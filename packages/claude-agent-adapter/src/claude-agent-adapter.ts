import { NativeResumeRefused, protectedHistoryRoots } from '@autocatalyst/execution';
import { ClaudeUsage, type ClaudeAccountingAnomaly } from './claude-usage.js';
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
  ProviderCapabilityDegradation,
  ProviderSchemaProjection,
  ProviderStructuredOutputSchema,
  StructuredAgentResultCapture
} from '@autocatalyst/execution';
import {
  ClassifiedProviderFailureError,
  ProviderConfigurationError,
  ProviderConnectionError,
  ProviderProtocolError,
  UnsupportedProviderCapabilityError,
  assertSerializableStructuredResult,
  buildSafeAdapterFailureLogDetail,
  classifyProviderFailure,
  filterSafeClassificationDetails,
  projectStepResultSchemaForProvider,
  isReviewedSpecCapture,
  decodeSpecRoleProviderResult,
  runtimeSkillsCatalogRoot,
  writeScratchStepResultFile,
  type ProxyUpstreamFailureRecord
} from '@autocatalyst/execution';

import { claudeSubscriptionEnvironment, probeClaudeSubscription } from './subscription-auth.js';

import { materializeClaudeSkillPlugins } from './skill-materialization.js';

// ---------------------------------------------------------------------------
// Identity constants
// ---------------------------------------------------------------------------

export const claudeProviderKind = 'anthropic' as const;
export const claudeAgentAdapterId = 'claude-agent-sdk' as const;
export const claudeSubscriptionAdapterId = 'claude-agent-sdk-subscription' as const;

// ---------------------------------------------------------------------------
// Structured result output format
// ---------------------------------------------------------------------------

export interface ClaudeStructuredResultDefinition {
  readonly outputFormat: {
    readonly type: 'json_schema';
    readonly schema: ProviderStructuredOutputSchema;
  };
  readonly projection: ProviderSchemaProjection & {
    readonly target: 'claude_output_format';
    readonly mechanism: 'claude_structured_output';
  };
}

// ---------------------------------------------------------------------------
// Native event seam (mirrors the @anthropic-ai/claude-agent-sdk wire shape
// closely enough for adapter mapping; the seam keeps tests independent of the
// real SDK).
// ---------------------------------------------------------------------------

export interface ClaudeNativeEvent {
  readonly type: 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'system' | string;
  readonly content?: string;
  readonly tool?: { readonly name: string; readonly input?: unknown };
  readonly structuredOutput?: unknown;
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
  readonly conversation?: import('@autocatalyst/execution').NativeConversationTurn;
  readonly onUsage?: (usage: AgentTokenUsage, anomalies?: readonly ClaudeAccountingAnomaly[]) => void;
  readonly prompt: string;
  readonly cwd?: string;
  readonly workspaceRoots?: readonly string[];
  readonly env?: Record<string, string>;
  readonly allowedTools?: string[];
  readonly options?: Record<string, unknown>;
  readonly structuredResult?: ClaudeStructuredResultDefinition;
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

export type ClaudeSdkQuery = (input: {
  prompt: string; options?: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

export interface ClaudeAgentAdapterOptions {
  /** Native message source; the default is the pinned Claude Agent SDK query. */
  readonly queryClaudeSdk?: ClaudeSdkQuery;
  readonly authentication?: 'api_key' | 'subscription';
  readonly probeSubscriptionAuth?: (env: Record<string, string>) => Promise<boolean>;
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

// Sampling controls are unsupported in agent mode. Reasoning effort maps to the
// SDK effort option with adaptive thinking.
const DEFAULT_UNSUPPORTED_INFERENCE_KEYS: readonly string[] = [
  'temperature',
  'topP',
  'maxOutputTokens',
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

// ---------------------------------------------------------------------------
// Safe failure diagnostics (metadata-only: never raw messages, bodies, prompts,
// headers, tokens, or secrets). Values are class names, numeric codes, and
// allowlisted syscall/signal tokens only.
// ---------------------------------------------------------------------------

// Safe syscall error codes (ECONNRESET, ETIMEDOUT, ...) and POSIX signals (SIGKILL, ...) only.
const SAFE_ERRNO_CODE = /^E[A-Z0-9]+$/u;
const SAFE_SIGNAL = /^SIG[A-Z0-9]+$/u;

function errorClassName(err: unknown): string {
  if (err instanceof Error) {
    const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof ctorName === 'string' && ctorName.length > 0) return ctorName;
    if (typeof err.name === 'string' && err.name.length > 0) return err.name;
    return 'Error';
  }
  return typeof err;
}

// Walk the (bounded) cause chain and return only the class names — never any message text.
function causeChainClassNames(err: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = (err as { cause?: unknown } | undefined)?.cause;
  let depth = 0;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && depth < 8 && !seen.has(current)) {
    seen.add(current);
    chain.push(errorClassName(current));
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return chain;
}

interface SafeDiagnosticScalars {
  readonly errno?: number;
  readonly code?: string;
  readonly exitCode?: number;
  readonly signal?: string;
}

function safeDiagnosticScalars(err: unknown): SafeDiagnosticScalars {
  const shaped = (err ?? {}) as {
    errno?: unknown; code?: unknown; exitCode?: unknown; signal?: unknown; status?: unknown;
  };
  const out: Record<string, unknown> = {};
  if (typeof shaped.errno === 'number') out['errno'] = shaped.errno;
  if (typeof shaped.code === 'string' && SAFE_ERRNO_CODE.test(shaped.code)) out['code'] = shaped.code;
  if (typeof shaped.exitCode === 'number') out['exitCode'] = shaped.exitCode;
  // Subprocess failures sometimes carry the exit code on `status`.
  else if (typeof shaped.status === 'number') out['exitCode'] = shaped.status;
  if (typeof shaped.signal === 'string' && SAFE_SIGNAL.test(shaped.signal)) out['signal'] = shaped.signal;
  return out as SafeDiagnosticScalars;
}

const QUALIFYING_PROXY_OUTCOMES: ReadonlySet<ProxyUpstreamFailureRecord['outcome']> = new Set([
  'exhausted',
  'timeout',
  'mid_stream'
]);

function proxyEvidenceQualifies(evidence: ProxyUpstreamFailureRecord | undefined): evidence is ProxyUpstreamFailureRecord {
  return evidence !== undefined && QUALIFYING_PROXY_OUTCOMES.has(evidence.outcome);
}

// The proxy record is already safe (origin-only, metadata-only); surface a compact subset for logs.
function safeProxyEvidenceFields(evidence: ProxyUpstreamFailureRecord): Record<string, unknown> {
  return {
    proxyFailureOutcome: evidence.outcome,
    proxyUpstreamOrigin: evidence.upstreamOrigin,
    proxyAttempt: evidence.attempt,
    proxyElapsedMs: evidence.elapsedMs,
    proxyResponseStarted: evidence.responseStarted,
    proxyBodyBytesStreamed: evidence.bodyBytesStreamed,
    ...(evidence.status !== undefined ? { proxyStatus: evidence.status } : {}),
    ...(evidence.errorCode !== undefined ? { proxyErrorCode: evidence.errorCode } : {}),
    ...(evidence.profileName !== undefined ? { proxyProfileName: evidence.profileName } : {})
  };
}

// Structured provider errors are terminal/permanent and must never be promoted to a transient
// classification on the strength of proxy evidence.
function isNonRetryableStructuredError(err: unknown): boolean {
  return err instanceof ProviderProtocolError
    || err instanceof ProviderConnectionError
    || err instanceof ProviderConfigurationError
    || err instanceof UnsupportedProviderCapabilityError
    || err instanceof ClassifiedProviderFailureError;
}

// Real SDK launch: dynamically imports @anthropic-ai/claude-agent-sdk and
// translates its SDKMessage stream into the ClaudeNativeEvent shape used by
// mapNativeEvent. Dynamic import keeps the package buildable and unit-testable
// while still making the adapter package own its provider SDK dependency.
async function* realSDKLaunch(
  opts: ClaudeSessionLaunchOptions,
  queryOverride?: ClaudeSdkQuery
): AsyncIterable<ClaudeNativeEvent> {
  let query: ClaudeSdkQuery;
  try {
    query = queryOverride ?? (await import('@anthropic-ai/claude-agent-sdk') as { query: ClaudeSdkQuery }).query;
  } catch {
    throw new ProviderConnectionError(
      'process_launch_failed',
      '@anthropic-ai/claude-agent-sdk is not installed for @autocatalyst/claude-agent-adapter. Run pnpm install or provide options.launchClaudeSession.'
    );
  }

  const retention = opts.conversation?.mode === 'retained' ? opts.conversation : undefined;
  const historyRoots = protectedHistoryRoots(retention?.protectedHistoryRoots,
    opts.workspaceRoots ?? (opts.cwd ? [opts.cwd] : []));
  if (retention && (!historyRoots || !await retention.verifyLaunch())) {
    throw new ProviderConfigurationError('unsupported_required_capability', 'Native conversation confinement was not verified.');
  }
  if (retention?.resumeId && (!opts.cwd || !await retention.lookupRootSession?.(retention.resumeId, opts.cwd))) {
    throw new NativeResumeRefused('missing', false);
  }
  const sdkOpts: Record<string, unknown> = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined || retention?.scopeEnvironment ? { env: { ...opts.env, ...retention?.scopeEnvironment } } : {}),
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
    permissionMode: 'dontAsk',
    ...(opts.options ?? {}),
    ...(opts.structuredResult !== undefined ? { outputFormat: opts.structuredResult.outputFormat } : {})
  };

  if (opts.conversation) {
    delete sdkOpts['resume'];
    delete sdkOpts['resumeSessionAt'];
    delete sdkOpts['continue'];
    delete sdkOpts['forkSession'];
    if (retention) {
      const configured = sdkOpts['settings'];
      if (configured !== undefined && (typeof configured !== 'object' || configured === null || Array.isArray(configured))) {
        throw new ProviderConfigurationError('unsupported_required_capability', 'Native conversation settings could not be protected.');
      }
      const settings = configured as Record<string, unknown> | undefined;
      if (settings?.['sandbox'] !== undefined) {
        throw new ProviderConfigurationError('unsupported_required_capability', 'Native conversation sandbox has conflicting settings.');
      }
      const protectedRoots = historyRoots!;
      const permissions = settings?.['permissions'] as { deny?: string[] } | undefined;
      sdkOpts['settingSources'] = [];
      sdkOpts['settings'] = {
        ...settings,
        permissions: {
          ...permissions,
          deny: [...(permissions?.deny ?? []), ...protectedRoots.flatMap(root =>
            ['Read(/' + root + ')', 'Read(/' + root + '/**)', 'Edit(/' + root + ')', 'Edit(/' + root + '/**)'])]
        },
        sandbox: {
          enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
          filesystem: { denyRead: protectedRoots, denyWrite: protectedRoots }
        }
      };
      sdkOpts['persistSession'] = true;
      sdkOpts['resume'] = retention.resumeId;
      if (!retention.resumeId) delete sdkOpts['resume'];
    } else if (opts.conversation.mode === 'fresh_only' && opts.conversation.verifiedNonPersistence) {
      sdkOpts['persistSession'] = false;
    }
  }
  let root: string | undefined;
  const retainedEvents = new Set<string>();
  const linkedTools = new Set<string>();
  const accounting = new ClaudeUsage(retention?.resumeId !== undefined);
  const invalidRetainedRoot = () => new ProviderProtocolError('invalid_provider_event', 'Claude root conversation did not match the current query.');
  try {
    for await (const msg of query({ prompt: opts.prompt, options: sdkOpts })) {
      if (retention && msg['type'] === 'system' && msg['subtype'] === 'init') {
        const id = msg['session_id'];
        if (typeof id !== 'string' || !id || (root !== undefined && id !== root) ||
            (retention.resumeId !== undefined && id !== retention.resumeId)) throw invalidRetainedRoot();
        root = id;
      }
      if (retention && (msg['type'] === 'assistant' || msg['type'] === 'result')) {
        if (msg['isReplay'] === true || msg['is_replay'] === true) {
          accounting.observe(msg);
          continue;
        }
        if (!root) throw invalidRetainedRoot();
        const child = msg['type'] === 'assistant' && typeof msg['parent_tool_use_id'] === 'string';
        if (child && (!linkedTools.has(msg['parent_tool_use_id'] as string) || msg['session_id'] !== root)) continue;
        if (msg['session_id'] !== root) throw invalidRetainedRoot();
      }
      accounting.observe(msg);
      if (msg['type'] === 'assistant') {
        const inner = msg['message'] as Record<string, unknown> | undefined;
        const content = inner?.['content'];
        if (Array.isArray(content)) {
          for (const [index, block] of (content as Record<string, unknown>[]).entries()) {
            if (retention) {
              const messageId = inner?.['id'];
              if (typeof messageId !== 'string' || !messageId) continue;
              const event = JSON.stringify([messageId, block['type'], block['id'] ?? index]);
              if (retainedEvents.has(event)) continue;
              retainedEvents.add(event);
              if (block['type'] === 'tool_use' && typeof block['id'] === 'string') linkedTools.add(block['id']);
            }
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
          if (root && msg['is_error'] !== true) retention?.completed(root);
          const input_tokens =
            typeof usage?.['input_tokens'] === 'number' ? (usage['input_tokens'] as number) : undefined;
          const output_tokens =
            typeof usage?.['output_tokens'] === 'number' ? (usage['output_tokens'] as number) : undefined;
          const hasTokens = input_tokens !== undefined && output_tokens !== undefined;
          yield {
            type: 'result',
            ...(msg['structured_output'] !== undefined ? { structuredOutput: msg['structured_output'] } : {}),
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
    // Other messages are not used for UI events.
    }
  } finally {
    opts.onUsage?.(accounting.evidence(), [...accounting.anomalies]);
  }
}

function defaultLaunch(query?: ClaudeSdkQuery): ClaudeSessionLaunch {
  // realSDKLaunch is an async generator function; it satisfies ClaudeSessionLaunch
  // (returns AsyncIterable<ClaudeNativeEvent>). Dynamic import means the SDK is
  // only required at runtime — tests inject launchClaudeSession instead.
  return (options) => realSDKLaunch(options, query);
}

function createClaudeStructuredResultDefinition(
  capture: StructuredAgentResultCapture
): ClaudeStructuredResultDefinition {
  const projection = projectStepResultSchemaForProvider({
    schemaId: capture.schemaId,
    step: capture.step,
    schema: capture.schema,
    target: 'claude_output_format'
  });
  return {
    outputFormat: {
      type: 'json_schema',
      schema: projection.schema
    },
    projection: projection as ProviderSchemaProjection & {
      readonly target: 'claude_output_format';
      readonly mechanism: 'claude_structured_output';
    }
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createClaudeAgentAdapter(
  options: ClaudeAgentAdapterOptions = {}
): AgentProviderAdapter {
  const subscription = options.authentication === 'subscription';
  const adapterId = subscription ? claudeSubscriptionAdapterId : claudeAgentAdapterId;
  const probeAuth = options.probeSubscriptionAuth ?? probeClaudeSubscription;
  const launch = options.launchClaudeSession ?? defaultLaunch(options.queryClaudeSdk);
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
    if (err instanceof ClassifiedProviderFailureError) return err;
    const shaped = (err ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
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
    supportsSpecReview: true,
    providerKind: claudeProviderKind,
    adapterId,
    supportedConnectionMechanism: 'process_environment',
    ...(subscription ? { credentialRequirement: 'external' as const } : {}),

    startSession(input: AgentProviderSessionInput): AgentProviderSession {
      const { runInput, profile, connection, telemetryContext } = input;
      const env = runInput.environment;
      if (subscription && Object.entries(profile.endpoint).some(([key, value]) =>
        !['requestTimeoutMs', 'maxRetries'].includes(key) && !(key === 'proxyMode' && value === 'disabled')
      )) {
        throw new ProviderConfigurationError('invalid_endpoint', 'Subscription profiles cannot use API credentials or gateway alterations.');
      }
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
              adapterId,
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

      // Structured result output format configuration (before any SDK launch).
      let structuredResult: ClaudeStructuredResultDefinition | undefined;
      if (input.structuredResultCapture !== undefined) {
        structuredResult = createClaudeStructuredResultDefinition(input.structuredResultCapture);
      }

      // Resolve cwd from materialized workspace.
      const workspace = env.workspace;
      const cwd: string | undefined =
        'scratchRoot' in workspace
          ? workspace.scratchRoot
          : workspace.workspaceRoots[0];

      const baseAllowedTools = mapAllowedToolsForClaude(env.toolPolicy.allowedTools);
      const reviewedSpec = isReviewedSpecCapture(input.structuredResultCapture);
      const allowedTools = reviewedSpec && input.telemetryContext.role !== 'reviewer'
        ? [...baseAllowedTools, 'Skill'] : baseAllowedTools;
      const prompt = env.context.task.prompt;

      // Materialize resolved skills into real Claude SDK LOCAL PLUGINS
      // (`.claude-plugin/plugin.json` + skills/<name>/), passed via options.plugins.
      const skillMaterialization = materializeClaudeSkillPlugins(
        env.skills.resolved,
        runtimeSkillsCatalogRoot
      );
      const skillPlugins = skillMaterialization.plugins;
      const localPluginSkillRefs = skillPlugins.map((plugin) => {
        const namespace = path.basename(plugin.path);
        return env.skills.resolved
          .filter((skill) => {
            const colon = skill.ref.indexOf(':');
            const skillNamespace = colon === -1 ? skill.ref : skill.ref.slice(0, colon);
            return skillNamespace === namespace;
          })
          .map((skill) => skill.ref);
      });
      safeLog('info', 'claude.adapter.runtime_skills_prepared', {
        runId,
        step,
        providerKind: profile.providerKind,
        adapterId,
        profileName: profile.profileName,
        requestedSkillCount: env.skills.requested.length,
        requestedSkillRefs: [...env.skills.requested],
        resolvedSkillCount: env.skills.resolved.length,
        resolvedSkillRefs: env.skills.resolved.map((skill) => skill.ref),
        localPluginCount: skillPlugins.length,
        localPluginNamespaces: skillPlugins.map((plugin) => path.basename(plugin.path)),
        localPluginSkillRefs,
        sdkOptionsSkills: skillPlugins.length > 0 ? 'all' : undefined,
        sdkHandoffMode: skillPlugins.length > 0 ? 'local_plugins' : 'no_runtime_skills'
      });
      if (env.skills.requested.length > 0 && env.skills.resolved.length === 0) {
        safeLog('warn', 'claude.adapter.runtime_skills_unresolved', {
          runId,
          step,
          providerKind: profile.providerKind,
          adapterId,
          profileName: profile.profileName,
          requestedSkillRefs: [...env.skills.requested]
        });
      }

      let metadataResolve!: (value: AgentProviderSessionMetadata) => void;
      let metadataReject!: (err: unknown) => void;
      const metadata = new Promise<AgentProviderSessionMetadata>((resolve, reject) => {
        metadataResolve = resolve;
        metadataReject = reject;
      });
      metadata.catch(() => undefined);

      let tokenUsage: AgentTokenUsage = { available: false };
      async function* mapEvents(): AsyncIterable<RunnerEvent> {
        let outcome: 'succeeded' | 'failed' | 'canceled' = 'succeeded';

        let pendingResult: PendingResult | undefined;
        let capturedStructuredResult: { readonly value: unknown } | undefined;
        // Safe session diagnostics captured for the failure path (counts/timing only, no content).
        const sessionStartedAtMs = Date.now();
        let sdkEventCount = 0;
        let lastSdkEventType: string | undefined;
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
              adapterId,
              profileName: profile.profileName,
              telemetryContext
            });
            throw err;
          }

          // The connection.environment IS the overlay; tests check that secret
          // values do not leak out of launch logs. We DO NOT log the env map.
          const launchEnv = subscription
            ? claudeSubscriptionEnvironment(launchConfig.environment)
            : { ...launchConfig.environment };
          // Ambient effort/budget variables take precedence over SDK options in
          // Claude Code; mask them whenever the profile explicitly owns effort.
          if (inference.reasoningEffort !== undefined) {
            launchEnv['CLAUDE_CODE_EFFORT_LEVEL'] = inference.reasoningEffort;
            launchEnv['MAX_THINKING_TOKENS'] = '';
            launchEnv['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING'] = '';
          }
          if (subscription && !await probeAuth(launchEnv)) {
            throw new ClassifiedProviderFailureError('provider_auth_failed', { providerKind: claudeProviderKind });
          }

          safeLog('info', 'claude.adapter.session_start', {
            runId,
            step,
            providerKind: profile.providerKind,
            adapterId,
            profileName: profile.profileName,
            configurationRecordId: profile.configurationRecordId,
            model: profile.model.model,
            mechanism: profile.connectionMechanism,
            allowedToolsCount: allowedTools.length,
            requestedSkillCount: env.skills.requested.length,
            resolvedSkillPluginCount: skillPlugins.length,
            cwdProvided: cwd !== undefined,
            // Redacted summary the connection layer already prepared.
            launchConfig: launchConfig.redacted,
            ...(structuredResult !== undefined ? {
              schemaId: structuredResult.projection.schemaId,
              ...(!isReviewedSpecCapture(input.structuredResultCapture) ? { resultFile: input.structuredResultCapture?.resultFile } : {}),
              resultCaptureMechanism: structuredResult.projection.mechanism
            } : {})
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

          yield runtimeSkillDiagnosticNotification({
            requestedSkillRefs: env.skills.requested,
            resolvedSkillRefs: env.skills.resolved.map((skill) => skill.ref),
            handoffMode: skillPlugins.length > 0 ? 'local_plugins' : 'no_runtime_skills',
            pluginNamespaces: skillPlugins.map((plugin) => path.basename(plugin.path))
          }, { runId, step, clock, idGenerator, knownSecretValues });

          const native = launch({
            ...(runInput.nativeConversation ? { conversation: runInput.nativeConversation } : {}),
            onUsage: (usage, anomalies) => {
              tokenUsage = usage;
              for (const code of anomalies ?? []) safeLog('warn', 'claude.adapter.invalid_accounting', { runId, step, code });
            },
            prompt,
            ...(cwd !== undefined ? { cwd } : {}),
            env: launchEnv,
            workspaceRoots: env.workspace.workspaceRoots,
            allowedTools,
            ...((subscription || inference.reasoningEffort !== undefined || skillPlugins.length > 0 || structuredResult !== undefined)
              ? {
                  options: {
                    model: profile.model.model,
                    ...(subscription ? { pathToClaudeCodeExecutable: 'claude', settingSources: [], settings: { forceLoginMethod: 'claudeai', apiKeyHelper: '' } } : {}),
                    ...(inference.reasoningEffort !== undefined ? { effort: inference.reasoningEffort, thinking: { type: 'adaptive' } } : {}),
                    // Local plugins carry the skills; `skills: 'all'` loads every
                    // discovered skill into the system prompt.
                    ...(skillPlugins.length > 0 ? { plugins: skillPlugins, skills: 'all' } : {}),
                    ...(reviewedSpec ? { tools: allowedTools, additionalDirectories: [...workspace.workspaceRoots] } : {}),
                    ...(structuredResult !== undefined ? { outputFormat: structuredResult.outputFormat } : {})
                  }
                }
              : {}),
            ...(structuredResult !== undefined ? { structuredResult } : {})
          });

          for await (const ev of native) {
            sdkEventCount += 1;
            if (typeof ev.type === 'string') lastSdkEventType = ev.type;
            if (structuredResult !== undefined && ev.type === 'result' && ev.structuredOutput !== undefined) {
              if (capturedStructuredResult !== undefined) {
                throw new ProviderProtocolError(
                  'duplicate_structured_result',
                  'Claude session returned structured_output more than once.',
                  { providerKind: profile.providerKind, adapterId }
                );
              }
              capturedStructuredResult = { value: ev.structuredOutput };
            }

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

          // After the native stream ends: write the result file and emit a terminal-result event.
          if (structuredResult !== undefined && input.structuredResultCapture !== undefined) {
            // Structured capture path
            if (capturedStructuredResult === undefined) {
              throw new ProviderProtocolError(
                'missing_structured_result',
                'Claude session ended without returning structured_output.',
                { providerKind: profile.providerKind, adapterId }
              );
            }
            const decoded = decodeSpecRoleProviderResult(input.structuredResultCapture, capturedStructuredResult.value);
            if (decoded.kind === 'question') {
              yield { ...buildTerminalResult({ runId, step, clock, idGenerator, directive: 'advance' }),
                type: 'runner_terminal_result', result: { directive: 'needs_input', question: decoded.question } };
              return;
            }
            await writeClaudeStructuredResultFile(env, input.structuredResultCapture, decoded.value);
            safeLog('info', 'claude.adapter.result_capture_diagnostic', {
              runId, step, schemaId: input.structuredResultCapture.schemaId,
              ...(!isReviewedSpecCapture(input.structuredResultCapture) ? { resultFile: input.structuredResultCapture.resultFile } : {}),
              captureStage: 'capture_complete', resultCaptureMechanism: structuredResult.projection.mechanism
            });
            yield buildTerminalResult({ runId, step, clock, idGenerator, directive: 'advance' });
          } else {
            // Legacy no-contract path
            if (pendingResult !== undefined) {
              await maybeWriteResultFile(env, pendingResult.output);
              yield buildTerminalResult({ runId, step, clock, idGenerator, directive: 'advance' });
            }
          }
        } catch (err) {
          outcome = 'failed';
          skillMaterialization.cleanup();
          let classified = classifySdkError(err);

          // Read the proxy's safe unrecovered failure evidence (if any) for this session. Used both
          // to enrich diagnostics and — only when the failure is otherwise unclassified and not a
          // terminal structured provider error — to classify the death as a transient provider
          // failure so the session-retry layer can recover it.
          const proxyEvidence = connection.getProxyFailureEvidence?.();
          if (
            classified === undefined &&
            !(err instanceof NativeResumeRefused) &&
            runInput.nativeConversation?.mode !== 'retained' &&
            !isNonRetryableStructuredError(err) &&
            proxyEvidenceQualifies(proxyEvidence)
          ) {
            classified = new ClassifiedProviderFailureError('transient_provider_failure', {
              providerKind: profile.providerKind
            });
          }

          const safeDetail = { ...buildSafeAdapterFailureLogDetail(err ?? {}, profile.providerKind), ...(classified?.safeDetails ?? {}) };
          const protocolErrorCode = err instanceof ProviderProtocolError ? err.code : undefined;
          const failureCode = typeof safeDetail.code === 'string' ? safeDetail.code : undefined;
          const diagnosticScalars = safeDiagnosticScalars(err);
          safeLog('error', 'claude.adapter.session_failed', {
            runId,
            step,
            adapterId,
            ...safeDetail,
            // Safe scalar diagnostics — class/cause/errno/exit/signal/timing/event counts only.
            errorClass: errorClassName(err),
            causeChain: causeChainClassNames(err),
            ...diagnosticScalars,
            elapsedMs: Date.now() - sessionStartedAtMs,
            sdkEventCount,
            ...(lastSdkEventType !== undefined ? { lastSdkEventType } : {}),
            ...(proxyEvidenceQualifies(proxyEvidence) ? safeProxyEvidenceFields(proxyEvidence) : {}),
            ...(protocolErrorCode !== undefined ? { protocolErrorCode } : {}),
            ...(classified !== undefined ? { failureReason: classified.failureReason } : {}),
            ...(failureCode !== undefined ? { failureCode } : {}),
            ...(structuredResult !== undefined && input.structuredResultCapture !== undefined ? {
              structuredResultCapture: true,
              schemaId: input.structuredResultCapture.schemaId,
              ...(!isReviewedSpecCapture(input.structuredResultCapture) ? { resultFile: input.structuredResultCapture.resultFile } : {}),
              resultCaptureMechanism: structuredResult.projection.mechanism
            } : {})
          });
          const thrown = classified ?? err;
          metadataReject(thrown);
          throw thrown;
        } finally {
          skillMaterialization.cleanup();
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
              adapterId,
              outcome
            });
          }
        }
      }

      const session: AgentProviderSession = {
        events: mapEvents(),
        metadata,
        getTokenUsage: () => tokenUsage,
        async close() { skillMaterialization.cleanup(); }
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

function runtimeSkillDiagnosticNotification(input: {
  readonly requestedSkillRefs: readonly string[];
  readonly resolvedSkillRefs: readonly string[];
  readonly handoffMode: string;
  readonly pluginNamespaces?: readonly string[];
}, ctx: MapContext): RunnerEvent {
  const requested = input.requestedSkillRefs.length > 0 ? input.requestedSkillRefs.join(',') : 'none';
  const resolved = input.resolvedSkillRefs.length > 0 ? input.resolvedSkillRefs.join(',') : 'none';
  const plugins = input.pluginNamespaces !== undefined && input.pluginNamespaces.length > 0
    ? ` plugins=${input.pluginNamespaces.join(',')}`
    : '';
  return {
    ...baseFields(ctx),
    type: 'runner_notification',
    importance: 'normal',
    notification: {
      severity: input.requestedSkillRefs.length > 0 && input.resolvedSkillRefs.length === 0 ? 'warn' : 'info',
      message: `Runtime skills: requested=${requested} resolved=${resolved} handoff=${input.handoffMode}${plugins}`
    }
  };
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

async function writeClaudeStructuredResultFile(
  env: AgentProviderSessionInput['runInput']['environment'],
  capture: StructuredAgentResultCapture,
  value: unknown
): Promise<void> {
  assertSerializableStructuredResult(value);
  const writeOutcome = await writeScratchStepResultFile({
    environment: env,
    resultFile: capture.resultFile,
    value
  });
  if (writeOutcome.status === 'failed') {
    throw new ProviderProtocolError(
      'structured_result_invalid',
      `Claude structured_output write failed: ${writeOutcome.code}`,
      { providerKind: claudeProviderKind, adapterId: claudeAgentAdapterId, code: writeOutcome.code }
    );
  }
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
