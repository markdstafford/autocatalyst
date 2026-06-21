import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunnerEvent } from '@autocatalyst/api-contract';
import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionInput,
  AgentProviderSessionMetadata,
  AgentTokenUsage,
  ProcessLaunchConfig,
  ProviderCapabilityDegradation
} from '@autocatalyst/execution';
import {
  ClassifiedProviderFailureError,
  ProviderConnectionError,
  UnsupportedProviderCapabilityError,
  buildSafeAdapterFailureLogDetail,
  classifyProviderFailure,
  filterSafeClassificationDetails,
  runtimeSkillsCatalogRoot
} from '@autocatalyst/execution';

import { materializeClaudeSkillPlugins } from './skill-materialization.js';

// ---------------------------------------------------------------------------
// Identity constants
// ---------------------------------------------------------------------------

export const claudeProviderKind = 'anthropic' as const;
export const claudeAgentAdapterId = 'claude-agent-sdk' as const;

// ---------------------------------------------------------------------------
// Native event seam (mirrors the @anthropic-ai/claude-agent-sdk wire shape
// closely enough for adapter mapping; the seam keeps tests independent of the
// real SDK).
// ---------------------------------------------------------------------------

export interface ClaudeNativeEvent {
  readonly type: 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'system' | string;
  readonly content?: string;
  readonly tool?: { readonly name: string; readonly input?: unknown };
  readonly result?: {
    readonly type?: string;
    readonly output?: string;
    readonly is_error?: boolean;
    readonly total_tokens?: number;
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly [key: string]: unknown;
}

export interface ClaudeSessionLaunchOptions {
  readonly prompt: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly allowedTools?: string[];
  readonly options?: Record<string, unknown>;
}

export type ClaudeSessionLaunch = (
  options: ClaudeSessionLaunchOptions
) => AsyncIterable<ClaudeNativeEvent>;

// ---------------------------------------------------------------------------
// Logger and adapter options
// ---------------------------------------------------------------------------

export interface ClaudeAgentAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface ClaudeAgentAdapterOptions {
  readonly launchClaudeSession?: ClaudeSessionLaunch;
  readonly supportedInferenceSettings?: ReadonlySet<string>;
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
  readonly logger?: ClaudeAgentAdapterLogger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PROGRESS_TOOL_NAMES = new Set(['update_plan', 'report_progress', 'notify']);

const CLAUDE_TOOL_CATEGORY_MAP: Readonly<Record<string, readonly string[]>> = {
  bash: ['Bash'],
  filesystem: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  lsp: []
};

function mapAllowedToolsForClaude(allowedTools: readonly string[]): string[] {
  const mapped: string[] = [];
  for (const tool of allowedTools) {
    const replacement = CLAUDE_TOOL_CATEGORY_MAP[tool];
    if (replacement !== undefined) {
      mapped.push(...replacement);
    } else {
      mapped.push(tool);
    }
  }
  return Array.from(new Set(mapped));
}

// Inference settings the Claude Agent SDK does NOT plumb into agent mode.
// (Everything currently in the InferenceSettings schema falls into this set;
// the SDK only exposes the model via the launch env / options, never
// per-request inference knobs from agent mode.)
const DEFAULT_UNSUPPORTED_INFERENCE_KEYS: readonly string[] = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'reasoningEffort',
  'seed'
];

interface PendingResult {
  readonly output?: string;
  readonly tokens?: { readonly input?: number; readonly output?: number; readonly total?: number };
}

function redactString(value: string, knownSecretValues: readonly string[]): string {
  let out = value;
  for (const secret of knownSecretValues) {
    if (secret.length === 0) continue;
    while (out.includes(secret)) {
      out = out.replace(secret, '[REDACTED]');
    }
  }
  return out;
}

// Real SDK launch: dynamically imports @anthropic-ai/claude-agent-sdk and
// translates its SDKMessage stream into the ClaudeNativeEvent shape used by
// mapNativeEvent. Dynamic import keeps the package buildable and unit-testable
// without the SDK installed; tests inject their own launchClaudeSession seam.
async function* realSDKLaunch(
  opts: ClaudeSessionLaunchOptions
): AsyncIterable<ClaudeNativeEvent> {
  type QueryFn = (input: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;
  let query: QueryFn;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-ignore is required here because @ts-expect-error triggers TS2578 (unused directive) when the optional peer is installed, making the suppression self-defeating
    // @ts-ignore -- optional peer: types unavailable until the package is installed
    const sdk = await import('@anthropic-ai/claude-agent-sdk') as { query: QueryFn };
    query = sdk.query;
  } catch {
    throw new ProviderConnectionError(
      'process_launch_failed',
      '@anthropic-ai/claude-agent-sdk is not installed. Install it as a peer dependency or provide options.launchClaudeSession.'
    );
  }

  const sdkOpts: Record<string, unknown> = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
    permissionMode: 'dontAsk',
    ...(opts.options ?? {})
  };

  for await (const msg of query({ prompt: opts.prompt, options: sdkOpts })) {
    if (msg['type'] === 'assistant') {
      const inner = msg['message'] as Record<string, unknown> | undefined;
      const content = inner?.['content'];
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            yield { type: 'assistant', content: block['text'] };
          } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
            yield { type: 'tool_use', tool: { name: block['name'], input: block['input'] } };
          }
        }
      }
    } else if (msg['type'] === 'result') {
      const subtype = msg['subtype'] as string | undefined;
      const usage = msg['usage'] as Record<string, unknown> | undefined;
      if (subtype === 'success') {
        const input_tokens =
          typeof usage?.['input_tokens'] === 'number' ? (usage['input_tokens'] as number) : undefined;
        const output_tokens =
          typeof usage?.['output_tokens'] === 'number' ? (usage['output_tokens'] as number) : undefined;
        const hasTokens = input_tokens !== undefined && output_tokens !== undefined;
        yield {
          type: 'result',
          result: {
            is_error: msg['is_error'] === true,
            ...(typeof msg['result'] === 'string' ? { output: msg['result'] } : {}),
            ...(hasTokens
              ? { total_tokens: input_tokens + output_tokens, input_tokens, output_tokens }
              : {})
          }
        };
      } else {
        // Error result subtypes (error_max_turns, error_during_execution, etc.)
        const errors = Array.isArray(msg['errors']) ? (msg['errors'] as unknown[]).map(String) : [];
        yield {
          type: 'result',
          result: {
            is_error: true,
            ...(errors.length > 0 ? { output: errors.join('\n') } : {})
          }
        };
      }
    }
    // System, user, status, hook, task, and other messages are intentionally ignored.
  }
}

function defaultLaunch(): ClaudeSessionLaunch {
  // realSDKLaunch is an async generator function; it satisfies ClaudeSessionLaunch
  // (returns AsyncIterable<ClaudeNativeEvent>). Dynamic import means the SDK is
  // only required at runtime — tests inject launchClaudeSession instead.
  return realSDKLaunch;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createClaudeAgentAdapter(
  options: ClaudeAgentAdapterOptions = {}
): AgentProviderAdapter {
  const launch = options.launchClaudeSession ?? defaultLaunch();
  const supportedInference = options.supportedInferenceSettings ?? new Set<string>();
  const clock = options.clock ?? (() => new Date().toISOString());
  const idGenerator =
    options.idGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);
  const logger = options.logger;

  function safeLog(
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: unknown
  ): void {
    if (!logger) return;
    logger[level](event, fields);
  }

  function classifySdkError(err: unknown): ClassifiedProviderFailureError | undefined {
    const shaped = err as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
    const classificationInput = {
      ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
      ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
      code: shaped.code,
      errorName: shaped.name,
      providerKind: claudeProviderKind
    };
    const reason = classifyProviderFailure(classificationInput);
    return reason === undefined
      ? undefined
      : new ClassifiedProviderFailureError(reason, filterSafeClassificationDetails(classificationInput));
  }

  return {
    providerKind: claudeProviderKind,
    adapterId: claudeAgentAdapterId,
    supportedConnectionMechanism: 'process_environment',

    startSession(input: AgentProviderSessionInput): AgentProviderSession {
      const { runInput, profile, connection, telemetryContext } = input;
      const env = runInput.environment;
      const runId = env.context.run.id;
      const step = env.context.run.currentStep;

      // --------------------------------------------------------------
      // Inference-setting capability evaluation (before any SDK launch).
      // --------------------------------------------------------------
      const inference = profile.inferenceSettings;
      const requiredAlterations =
        profile.endpoint.requiredAlterations?.inferenceSettings ?? [];
      const requiredAlterationSet = new Set(requiredAlterations);
      const inferenceDegradations: ProviderCapabilityDegradation[] = [];

      for (const key of DEFAULT_UNSUPPORTED_INFERENCE_KEYS) {
        if (supportedInference.has(key)) continue;
        const raw = (inference as Record<string, unknown>)[key];
        if (raw === undefined) continue;
        const isRequired = requiredAlterationSet.has(key);
        if (isRequired) {
          throw new UnsupportedProviderCapabilityError(
            'inference_setting_unsupported',
            `Claude Agent SDK does not support required inference setting "${key}".`,
            {
              providerKind: profile.providerKind,
              adapterId: claudeAgentAdapterId,
              capability: key
            }
          );
        }
        inferenceDegradations.push({
          capability: `inference_setting:${key}`,
          reason: 'Claude Agent SDK does not expose this inference setting in agent mode.',
          required: false
        });
      }

      // Resolve cwd from materialized workspace.
      const workspace = env.workspace;
      const cwd: string | undefined =
        'scratchRoot' in workspace
          ? workspace.scratchRoot
          : workspace.workspaceRoots[0];

      const allowedTools = mapAllowedToolsForClaude(env.toolPolicy.allowedTools);
      const prompt = env.context.task.prompt;

      // Materialize resolved skills into Claude SDK plugin descriptors.
      // This is a pure transformation — throws ClaudeSkillMaterializationError
      // if any resolved skill has an empty assetPath.
      const skillPlugins = materializeClaudeSkillPlugins(
        env.skills.resolved,
        runtimeSkillsCatalogRoot
      );

      let metadataResolve!: (value: AgentProviderSessionMetadata) => void;
      let metadataReject!: (err: unknown) => void;
      const metadata = new Promise<AgentProviderSessionMetadata>((resolve, reject) => {
        metadataResolve = resolve;
        metadataReject = reject;
      });
      metadata.catch(() => undefined);

      async function* mapEvents(): AsyncIterable<RunnerEvent> {
        let outcome: 'succeeded' | 'failed' | 'canceled' = 'succeeded';
        let tokenUsage: AgentTokenUsage = { available: false };
        let pendingResult: PendingResult | undefined;
        // degradedCapabilities is populated after the launch config resolves;
        // declared here so the finally block can always reference it.
        let degradedCapabilities: ProviderCapabilityDegradation[] = [...inferenceDegradations];

        try {
          // --------------------------------------------------------------
          // Build process launch config (this is the seam to the connection
          // layer, which produces connection-owned env vars). Awaited here
          // so that Promise-returning implementations are supported.
          // --------------------------------------------------------------
          let launchConfig: ProcessLaunchConfig;
          try {
            launchConfig = await connection.createProcessLaunchConfig({
              materializedEnvironment: env.environment
            });
          } catch (err) {
            safeLog('error', 'claude.adapter.launch_config_failed', {
              runId,
              step,
              providerKind: profile.providerKind,
              adapterId: claudeAgentAdapterId,
              profileName: profile.profileName,
              telemetryContext
            });
            throw err;
          }

          // The connection.environment IS the overlay; tests check that secret
          // values do not leak out of launch logs. We DO NOT log the env map.
          const launchEnv: Record<string, string> = { ...launchConfig.environment };

          safeLog('info', 'claude.adapter.session_start', {
            runId,
            step,
            providerKind: profile.providerKind,
            adapterId: claudeAgentAdapterId,
            profileName: profile.profileName,
            configurationRecordId: profile.configurationRecordId,
            model: profile.model.model,
            mechanism: profile.connectionMechanism,
            allowedToolsCount: allowedTools.length,
            requestedSkillCount: env.skills.requested.length,
            resolvedSkillPluginCount: skillPlugins.length,
            cwdProvided: cwd !== undefined,
            // Redacted summary the connection layer already prepared.
            launchConfig: launchConfig.redacted
          });

          // Merge connection-layer degradations now that we have the launch config.
          degradedCapabilities = [
            ...launchConfig.degradedCapabilities,
            ...inferenceDegradations
          ];

          // Secrets we MUST scrub from any string content we forward.
          const knownSecretValues: string[] = [];
          for (const name of launchConfig.secretVariableNames) {
            const v = launchConfig.environment[name];
            if (typeof v === 'string' && v.length > 0) {
              knownSecretValues.push(v);
            }
          }

          const native = launch({
            prompt,
            ...(cwd !== undefined ? { cwd } : {}),
            env: launchEnv,
            allowedTools,
            ...(skillPlugins.length > 0 ? { options: { skills: skillPlugins } } : {})
          });

          for await (const ev of native) {
            const mapped = mapNativeEvent(ev, {
              runId,
              step,
              clock,
              idGenerator,
              knownSecretValues
            });
            if (mapped.usage) {
              tokenUsage = mapped.usage;
            }
            if (mapped.pendingResult) {
              pendingResult = mapped.pendingResult;
            }
            for (const out of mapped.events) {
              yield out;
            }
          }

          // After the native stream ends: write the result file if any
          // captured output, then emit a single terminal-result event if the
          // SDK did not already produce one.
          if (pendingResult !== undefined) {
            await maybeWriteResultFile(env, pendingResult.output);
            yield buildTerminalResult({
              runId,
              step,
              clock,
              idGenerator,
              directive: 'advance'
            });
          }
        } catch (err) {
          outcome = 'failed';
          const classified = classifySdkError(err);
          safeLog('error', 'claude.adapter.session_failed', {
            runId,
            step,
            adapterId: claudeAgentAdapterId,
            ...buildSafeAdapterFailureLogDetail(err, profile.providerKind),
            ...(classified !== undefined ? { failureReason: classified.failureReason } : {})
          });
          const thrown = classified ?? err;
          metadataReject(thrown);
          throw thrown;
        } finally {
          if (outcome !== 'failed') {
            metadataResolve({
              outcome,
              launchMechanism: 'process_environment',
              degradedCapabilities,
              tokenUsage,
              model: profile.model
            });
            safeLog('info', 'claude.adapter.session_end', {
              runId,
              step,
              providerKind: profile.providerKind,
              adapterId: claudeAgentAdapterId,
              outcome
            });
          }
        }
      }

      const session: AgentProviderSession = {
        events: mapEvents(),
        metadata
      };
      return session;
    }
  };
}

// ---------------------------------------------------------------------------
// Native -> canonical event mapping
// ---------------------------------------------------------------------------

interface MapContext {
  readonly runId: string;
  readonly step: string;
  readonly clock: () => string;
  readonly idGenerator: () => string;
  readonly knownSecretValues: readonly string[];
}

interface MappedNative {
  readonly events: RunnerEvent[];
  readonly usage?: AgentTokenUsage;
  readonly pendingResult?: PendingResult;
}

function baseFields(ctx: MapContext): { id: string; runId: string; step: string; createdAt: string } {
  return {
    id: ctx.idGenerator(),
    runId: ctx.runId,
    step: ctx.step,
    createdAt: ctx.clock()
  };
}

function mapNativeEvent(ev: ClaudeNativeEvent, ctx: MapContext): MappedNative {
  if (ev.type === 'assistant' && typeof ev.content === 'string') {
    const event: RunnerEvent = {
      ...baseFields(ctx),
      type: 'runner_assistant_turn',
      importance: 'normal',
      message: {
        role: 'assistant',
        content: redactString(ev.content, ctx.knownSecretValues)
      }
    };
    return { events: [event] };
  }

  if (ev.type === 'tool_use' && ev.tool) {
    return mapToolUse(ev.tool, ctx);
  }

  if (ev.type === 'result') {
    const r = ev.result ?? {};
    const tokens = pickTokens(r, ev.usage);
    const usage: AgentTokenUsage = (tokens.available
      ? { available: true, tokens: tokens.breakdown }
      : { available: false }) as AgentTokenUsage;
    return {
      events: [],
      usage,
      pendingResult: { ...(r.output !== undefined ? { output: r.output } : {}) }
    };
  }

  // Unknown / system events: ignore.
  return { events: [] };
}

function mapToolUse(
  tool: { name: string; input?: unknown },
  ctx: MapContext
): MappedNative {
  const name = tool.name;
  if (!PROGRESS_TOOL_NAMES.has(name)) {
    const event: RunnerEvent = {
      ...baseFields(ctx),
      type: 'runner_tool_activity',
      importance: 'normal',
      tool: { name, action: 'invoke', status: 'started' }
    };
    return { events: [event] };
  }

  const input = isRecord(tool.input) ? tool.input : {};

  if (name === 'update_plan') {
    const title = typeof input['title'] === 'string' ? input['title'] : '';
    const steps = Array.isArray(input['steps'])
      ? input['steps'].filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];
    if (title.length === 0 || steps.length === 0) {
      return { events: [] };
    }
    const event: RunnerEvent = {
      ...baseFields(ctx),
      type: 'runner_progress',
      importance: 'normal',
      progress: { kind: 'plan', title, steps }
    };
    return { events: [event] };
  }

  if (name === 'report_progress') {
    const completed = typeof input['completed'] === 'number' ? input['completed'] : undefined;
    const total = typeof input['total'] === 'number' ? input['total'] : undefined;
    const label = typeof input['label'] === 'string' ? input['label'] : undefined;
    const summary = typeof input['summary'] === 'string' ? input['summary'] : undefined;

    if (completed !== undefined && total !== undefined && label !== undefined) {
      const event: RunnerEvent = {
        ...baseFields(ctx),
        type: 'runner_progress',
        importance: 'normal',
        progress: { kind: 'task_progress', label, completed, total }
      };
      return { events: [event] };
    }
    if (summary !== undefined) {
      const event: RunnerEvent = {
        ...baseFields(ctx),
        type: 'runner_progress',
        importance: 'normal',
        progress: { kind: 'intent', summary }
      };
      return { events: [event] };
    }
    return { events: [] };
  }

  // notify
  const message = typeof input['message'] === 'string' ? input['message'] : '';
  if (message.length === 0) return { events: [] };
  const severityRaw = input['severity'];
  const severity =
    severityRaw === 'debug' || severityRaw === 'info' || severityRaw === 'warn' || severityRaw === 'error'
      ? severityRaw
      : 'info';
  const importanceRaw = input['importance'];
  const importance =
    importanceRaw === 'low' || importanceRaw === 'normal' || importanceRaw === 'high'
      ? importanceRaw
      : 'normal';
  const event: RunnerEvent = {
    ...baseFields(ctx),
    type: 'runner_notification',
    importance,
    notification: { severity, message }
  };
  return { events: [event] };
}

type TokensBreakdown = { input?: number; output?: number; total?: number };
type PickTokensResult =
  | { available: false }
  | { available: true; breakdown: TokensBreakdown };

function pickTokens(
  r: NonNullable<ClaudeNativeEvent['result']>,
  usage: ClaudeNativeEvent['usage']
): PickTokensResult {
  const input = r.input_tokens ?? usage?.input_tokens;
  const output = r.output_tokens ?? usage?.output_tokens;
  const total = r.total_tokens;
  if (input === undefined && output === undefined && total === undefined) {
    return { available: false };
  }
  const breakdown: TokensBreakdown = {};
  if (input !== undefined) breakdown.input = input;
  if (output !== undefined) breakdown.output = output;
  if (total !== undefined) breakdown.total = total;
  return { available: true, breakdown };
}

function buildTerminalResult(args: {
  runId: string;
  step: string;
  clock: () => string;
  idGenerator: () => string;
  directive: 'advance';
}): RunnerEvent {
  return {
    id: args.idGenerator(),
    runId: args.runId,
    step: args.step,
    importance: 'high',
    createdAt: args.clock(),
    type: 'runner_terminal_result',
    result: { directive: args.directive }
  };
}

// The result file the agent's final output is captured into. Defaults to the
// shared step-result.json, but honors the per-(step, role, round) file named by
// the task's output contract so each role/round gets its own immutable result
// file. This is also how a read-only reviewer's verdict is recorded: it cannot
// write files, so its final message is captured into its own result file here.
function resolveResultFileName(
  env: AgentProviderSessionInput['runInput']['environment']
): string {
  const inputs = env.context?.task?.inputs as Record<string, unknown> | undefined;
  const outputContract = inputs?.['outputContract'];
  if (
    typeof outputContract === 'object' &&
    outputContract !== null &&
    !Array.isArray(outputContract)
  ) {
    const resultFile = (outputContract as Record<string, unknown>)['resultFile'];
    if (typeof resultFile === 'string' && resultFile.length > 0) return resultFile;
  }
  return 'step-result.json';
}

async function maybeWriteResultFile(
  env: AgentProviderSessionInput['runInput']['environment'],
  output: string | undefined
): Promise<void> {
  if (output === undefined) return;
  const workspace = env.workspace;
  const scratchRoot =
    'scratchRoot' in workspace ? workspace.scratchRoot : undefined;
  if (scratchRoot === undefined) return;
  const target = path.join(scratchRoot, resolveResultFileName(env));
  try {
    await access(target);
    return;
  } catch {
    // file does not exist, fall through to write
  }
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, output, { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new Error('Claude adapter failed to write the step result file.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
