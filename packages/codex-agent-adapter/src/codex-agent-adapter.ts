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
  StructuredAgentResultCapture
} from '@autocatalyst/execution';
import {
  ClassifiedProviderFailureError,
  ProviderConnectionError,
  ProviderProtocolError,
  UnsupportedProviderCapabilityError,
  assertSerializableStructuredResult,
  buildSafeAdapterFailureLogDetail,
  classifyProviderFailure,
  filterSafeClassificationDetails,
  runtimeSkillsCatalogRoot,
  writeScratchStepResultFile
} from '@autocatalyst/execution';

import {
  CodexAuthenticationError,
  type CodexAuthMode,
  type CodexAuthProbe,
  type CodexAuthProbeResult
} from './codex-auth.js';
import {
  materializeCodexSkills,
  type CodexSkillMount
} from './skill-materialization.js';

// ---------------------------------------------------------------------------
// Identity constants
// ---------------------------------------------------------------------------

export const codexProviderKind = 'codex' as const;
export const codexAgentAdapterId = 'codex-app-server' as const;

/** Codex sandbox filesystem permission values validated against the runtime. */
export type CodexSandboxValue = 'read-only' | 'workspace-write';

export const codexStructuredResultMechanism = 'codex_app_server_structured_output' as const;

// ---------------------------------------------------------------------------
// Structured result configuration
// ---------------------------------------------------------------------------

export interface CodexStructuredResultDefinition {
  readonly schemaId: string;
  readonly resultFile: string;
  readonly mechanism: typeof codexStructuredResultMechanism;
}

// ---------------------------------------------------------------------------
// Native event seam
//
// Mirrors the Codex app-server newline-delimited JSON event stream closely
// enough for adapter mapping. The seam keeps tests independent of a real Codex
// CLI / app-server subprocess.
// ---------------------------------------------------------------------------

export interface CodexNativeEvent {
  readonly type: 'agent_message' | 'tool_call' | 'token_count' | 'result' | string;
  readonly content?: string;
  readonly tool?: { readonly name: string; readonly input?: unknown };
  readonly structuredOutput?: unknown;
  readonly result?: {
    readonly directive?: 'advance' | 'needs_input' | 'fail';
    readonly output?: string;
    readonly question?: string;
    readonly reason?: string;
    readonly is_error?: boolean;
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly [key: string]: unknown;
}

export interface CodexSessionLaunchOptions {
  readonly prompt: string;
  readonly instructions: string;
  readonly model: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly sandbox: CodexSandboxValue;
  readonly allowedTools?: string[];
  readonly config?: Record<string, unknown>;
  readonly auth: { readonly mode: CodexAuthMode };
  readonly skills?: readonly CodexSkillMount[];
  readonly structuredResult?: CodexStructuredResultDefinition;
}

export type CodexSessionLaunch = (
  options: CodexSessionLaunchOptions
) => AsyncIterable<CodexNativeEvent>;

// ---------------------------------------------------------------------------
// Logger and adapter options
// ---------------------------------------------------------------------------

export interface CodexAgentAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface CodexAgentAdapterOptions {
  /** Override the default real app-server subprocess launch (tests inject a fake). */
  readonly launchCodexSession?: CodexSessionLaunch;
  /** Override the default enterprise sign-in probe (tests inject deterministic outcomes). */
  readonly probeCodexAuth?: CodexAuthProbe;
  readonly supportedInferenceSettings?: ReadonlySet<string>;
  /** Sandbox values accepted by the supported Codex runtime. Default: read-only, workspace-write. */
  readonly acceptedSandboxValues?: ReadonlySet<string>;
  /** Codex CLI binary name/path for the default real transport. Default: 'codex'. */
  readonly codexBinary?: string;
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
  readonly logger?: CodexAgentAdapterLogger;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PROGRESS_TOOL_NAMES = new Set(['update_plan', 'report_progress', 'notify']);

// Inference setting the Codex app-server plumbs through its config.
const DEFAULT_SUPPORTED_INFERENCE_KEYS: readonly string[] = ['reasoningEffort'];
// Inference settings the Codex app-server does NOT expose in agent mode.
const DEFAULT_UNSUPPORTED_INFERENCE_KEYS: readonly string[] = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'seed'
];

const DEFAULT_ACCEPTED_SANDBOX_VALUES: readonly string[] = ['read-only', 'workspace-write'];

const CODEX_TOOL_CATEGORY_MAP: Readonly<Record<string, readonly string[]>> = {
  bash: ['shell'],
  filesystem: ['read_file', 'write_file', 'apply_patch'],
  lsp: []
};

const CODEX_WRITE_TOOLS = new Set(['write_file', 'apply_patch']);

// ---------------------------------------------------------------------------
// Helpers: tool policy -> sandbox + allowed tools
// ---------------------------------------------------------------------------

function resolveRole(input: AgentProviderSessionInput): string | undefined {
  const telemetryRole = input.telemetryContext.role;
  if (typeof telemetryRole === 'string' && telemetryRole.length > 0) return telemetryRole;
  const inputs = input.runInput.environment.context.task.inputs as Record<string, unknown>;
  const role = inputs['role'];
  return typeof role === 'string' && role.length > 0 ? role : undefined;
}

function sandboxForRole(role: string | undefined): CodexSandboxValue {
  return role === 'reviewer' ? 'read-only' : 'workspace-write';
}

function mapAllowedToolsForCodex(
  allowedTools: readonly string[],
  sandbox: CodexSandboxValue
): string[] {
  const mapped: string[] = [];
  for (const tool of allowedTools) {
    const replacement = CODEX_TOOL_CATEGORY_MAP[tool];
    if (replacement !== undefined) {
      mapped.push(...replacement);
    } else {
      mapped.push(tool);
    }
  }
  let result = Array.from(new Set(mapped));
  if (sandbox === 'read-only') {
    result = result.filter((tool) => !CODEX_WRITE_TOOLS.has(tool));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers: inference settings
// ---------------------------------------------------------------------------

interface CodexInferenceMapping {
  readonly config: Record<string, unknown>;
  readonly degraded: ProviderCapabilityDegradation[];
}

function buildCodexConfig(
  profile: AgentProviderSessionInput['profile'],
  supportedInference: ReadonlySet<string>
): CodexInferenceMapping {
  const config: Record<string, unknown> = {};
  const degraded: ProviderCapabilityDegradation[] = [];
  const inference = profile.inferenceSettings as Record<string, unknown>;
  const requiredAlterations = profile.endpoint.requiredAlterations?.inferenceSettings ?? [];
  const requiredSet = new Set(requiredAlterations);

  // Supported: reasoning effort reaches Codex via its config.
  if (supportedInference.has('reasoningEffort')) {
    const reasoningEffort = inference['reasoningEffort'];
    if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
      config['model_reasoning_effort'] = reasoningEffort;
    }
  }

  for (const key of DEFAULT_UNSUPPORTED_INFERENCE_KEYS) {
    if (supportedInference.has(key)) continue;
    if (inference[key] === undefined) continue;
    if (requiredSet.has(key)) {
      throw new UnsupportedProviderCapabilityError(
        'inference_setting_unsupported',
        `Codex app-server does not support required inference setting "${key}".`,
        { providerKind: profile.providerKind, adapterId: codexAgentAdapterId, capability: key }
      );
    }
    degraded.push({
      capability: `inference_setting:${key}`,
      reason: 'Codex app-server does not expose this inference setting in agent mode.',
      required: false
    });
  }

  return { config, degraded };
}

// ---------------------------------------------------------------------------
// Helpers: redaction
// ---------------------------------------------------------------------------

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
// Default real transport (Codex app-server over stdio)
//
// Dynamically spawns `codex app-server` and translates its newline-delimited
// JSON stdout into CodexNativeEvent. This default is never exercised by the
// deterministic unit tests — they inject `launchCodexSession` — but keeps the
// package runnable against a real, operator-signed-in Codex CLI.
// ---------------------------------------------------------------------------

function defaultLaunch(codexBinary: string): CodexSessionLaunch {
  return async function* realCodexAppServerLaunch(
    options: CodexSessionLaunchOptions
  ): AsyncIterable<CodexNativeEvent> {
    let spawn: typeof import('node:child_process').spawn;
    let createInterface: typeof import('node:readline').createInterface;
    try {
      ({ spawn } = await import('node:child_process'));
      ({ createInterface } = await import('node:readline'));
    } catch {
      throw new ProviderConnectionError(
        'process_launch_failed',
        'Node child_process is unavailable; cannot launch the Codex app-server.'
      );
    }

    const child = spawn(
      codexBinary,
      ['app-server', '--listen', 'stdio://', '--sandbox', options.sandbox],
      {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    const launchRequest = {
      type: 'start_session',
      model: options.model,
      instructions: options.instructions,
      prompt: options.prompt,
      sandbox: options.sandbox,
      ...(options.allowedTools !== undefined ? { allowed_tools: options.allowedTools } : {}),
      ...(options.config !== undefined ? { config: options.config } : {}),
      ...(options.skills !== undefined ? { skills: options.skills.map((skill) => ({ ref: skill.ref, path: skill.sandboxPath })) } : {})
    };
    child.stdin.write(`${JSON.stringify(launchRequest)}\n`);
    child.stdin.end();

    const exitPromise = new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? 0));
    });

    try {
      const lines = createInterface({ input: child.stdout });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed: CodexNativeEvent;
        try {
          parsed = JSON.parse(trimmed) as CodexNativeEvent;
        } catch {
          continue;
        }
        yield parsed;
      }
      const exitCode = await exitPromise;
      if (exitCode !== 0) {
        throw new ProviderConnectionError(
          'process_launch_failed',
          'The Codex app-server exited abnormally before the session completed.'
        );
      }
    } finally {
      if (child.exitCode === null) child.kill();
    }
  };
}

// ---------------------------------------------------------------------------
// Default enterprise sign-in probe
//
// Fails closed: if the operator-approved sign-in cannot be positively confirmed
// the probe reports `missing_sign_in` rather than proceeding. Never reads, logs,
// or returns the cached credential.
// ---------------------------------------------------------------------------

function defaultAuthProbe(codexBinary: string): CodexAuthProbe {
  return async function probeCodexEnterpriseSignIn(): Promise<CodexAuthProbeResult> {
    let spawn: typeof import('node:child_process').spawn;
    try {
      ({ spawn } = await import('node:child_process'));
    } catch {
      return { status: 'unauthenticated', code: 'missing_sign_in' };
    }

    return await new Promise<CodexAuthProbeResult>((resolve) => {
      let stdout = '';
      try {
        const child = spawn(codexBinary, ['login', 'status', '--json'], {
          stdio: ['ignore', 'pipe', 'ignore']
        });
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.on('error', () => resolve({ status: 'unauthenticated', code: 'missing_sign_in' }));
        child.on('close', (code) => {
          if (code !== 0) {
            resolve({ status: 'unauthenticated', code: 'missing_sign_in' });
            return;
          }
          try {
            const parsed = JSON.parse(stdout) as Record<string, unknown>;
            const authMethod = parsed['auth_method'];
            if (authMethod === 'chatgpt' || authMethod === 'enterprise') {
              const plan = parsed['plan'];
              resolve({
                status: 'authenticated',
                ...(typeof plan === 'string' ? { accountType: plan } : {})
              });
              return;
            }
            // Signed in but not through the approved enterprise path.
            resolve({ status: 'unauthenticated', code: 'account_mismatch' });
          } catch {
            resolve({ status: 'unauthenticated', code: 'missing_sign_in' });
          }
        });
      } catch {
        resolve({ status: 'unauthenticated', code: 'missing_sign_in' });
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Result file helpers
// ---------------------------------------------------------------------------

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
  const scratchRoot = 'scratchRoot' in workspace ? workspace.scratchRoot : undefined;
  if (scratchRoot === undefined) return;
  const target = path.join(scratchRoot, resolveResultFileName(env));
  try {
    await access(target);
    return;
  } catch {
    // file does not exist; fall through to write
  }
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, output, { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new Error('Codex adapter failed to write the step result file.');
  }
}

async function writeCodexStructuredResultFile(
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
      `Codex structured result write failed: ${writeOutcome.code}`,
      { providerKind: codexProviderKind, adapterId: codexAgentAdapterId, code: writeOutcome.code }
    );
  }
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

interface PendingResult {
  readonly directive?: 'advance' | 'needs_input' | 'fail';
  readonly output?: string;
  readonly question?: string;
  readonly reason?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapNativeEvent(ev: CodexNativeEvent, ctx: MapContext): MappedNative {
  if (ev.type === 'agent_message' && typeof ev.content === 'string') {
    const event: RunnerEvent = {
      ...baseFields(ctx),
      type: 'runner_assistant_turn',
      importance: 'normal',
      message: { role: 'assistant', content: redactString(ev.content, ctx.knownSecretValues) }
    };
    return { events: [event] };
  }

  if (ev.type === 'tool_call' && ev.tool) {
    return mapToolCall(ev.tool, ctx);
  }

  if (ev.type === 'result') {
    const r = ev.result ?? {};
    const usage = pickTokenUsage(r, ev.usage);
    const pendingResult: PendingResult = {
      ...(r.directive !== undefined ? { directive: r.directive } : {}),
      ...(r.output !== undefined ? { output: r.output } : {}),
      ...(r.question !== undefined ? { question: r.question } : {}),
      ...(r.reason !== undefined ? { reason: r.reason } : {})
    };
    return { events: [], usage, pendingResult };
  }

  // token_count and other events carry no surfaced signal.
  return { events: [] };
}

function mapToolCall(tool: { name: string; input?: unknown }, ctx: MapContext): MappedNative {
  const name = tool.name;
  if (!PROGRESS_TOOL_NAMES.has(name)) {
    const event: RunnerEvent = {
      ...baseFields(ctx),
      type: 'runner_tool_activity',
      importance: 'normal',
      tool: { name: name.length > 0 ? name : 'unknown_tool', action: 'invoke', status: 'started' }
    };
    return { events: [event] };
  }

  const input = isRecord(tool.input) ? tool.input : {};

  if (name === 'update_plan') {
    const title = typeof input['title'] === 'string' ? input['title'] : '';
    const steps = Array.isArray(input['steps'])
      ? input['steps'].filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];
    if (title.length === 0 || steps.length === 0) return { events: [] };
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
    notification: { severity, message: redactString(message, ctx.knownSecretValues) }
  };
  return { events: [event] };
}

function pickTokenUsage(
  r: NonNullable<CodexNativeEvent['result']>,
  usage: CodexNativeEvent['usage']
): AgentTokenUsage {
  const input = r.input_tokens ?? usage?.input_tokens;
  const output = r.output_tokens ?? usage?.output_tokens;
  const total = r.total_tokens;
  if (input === undefined && output === undefined && total === undefined) {
    // Usage is unavailable — reported as degraded, never fabricated zero.
    return { available: false };
  }
  return {
    available: true,
    tokens: {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: 0,
      cacheWrite: 0
    }
  };
}

function buildTerminalResult(args: {
  readonly ctx: MapContext;
  readonly directive: 'advance' | 'needs_input' | 'fail';
  readonly question?: string;
  readonly reason?: string;
}): RunnerEvent {
  const base = { ...baseFields(args.ctx), importance: 'high' as const };
  if (args.directive === 'needs_input') {
    return {
      ...base,
      type: 'runner_terminal_result',
      result: { directive: 'needs_input', question: args.question ?? 'The Codex agent requested more input.' }
    };
  }
  if (args.directive === 'fail') {
    return {
      ...base,
      type: 'runner_terminal_result',
      result: { directive: 'fail', reason: args.reason ?? 'The Codex agent session failed.' }
    };
  }
  return { ...base, type: 'runner_terminal_result', result: { directive: 'advance' } };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createCodexAgentAdapter(
  options: CodexAgentAdapterOptions = {}
): AgentProviderAdapter {
  const codexBinary = options.codexBinary ?? 'codex';
  const launch = options.launchCodexSession ?? defaultLaunch(codexBinary);
  const probeAuth = options.probeCodexAuth ?? defaultAuthProbe(codexBinary);
  const supportedInference =
    options.supportedInferenceSettings ?? new Set<string>(DEFAULT_SUPPORTED_INFERENCE_KEYS);
  const acceptedSandboxValues =
    options.acceptedSandboxValues ?? new Set<string>(DEFAULT_ACCEPTED_SANDBOX_VALUES);
  const clock = options.clock ?? (() => new Date().toISOString());
  const idGenerator = options.idGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);
  const logger = options.logger;

  function safeLog(level: 'info' | 'warn' | 'error', event: string, fields: unknown): void {
    if (!logger) return;
    logger[level](event, fields);
  }

  function classifyCodexError(err: unknown): ClassifiedProviderFailureError | undefined {
    const shaped = err as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
    const classificationInput = {
      ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
      ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
      code: shaped.code,
      errorName: shaped.name,
      providerKind: codexProviderKind
    };
    const reason = classifyProviderFailure(classificationInput);
    return reason === undefined
      ? undefined
      : new ClassifiedProviderFailureError(reason, filterSafeClassificationDetails(classificationInput));
  }

  return {
    providerKind: codexProviderKind,
    adapterId: codexAgentAdapterId,
    supportedConnectionMechanism: 'process_environment',

    startSession(input: AgentProviderSessionInput): AgentProviderSession {
      const { runInput, profile, connection } = input;
      const env = runInput.environment;
      const runId = env.context.run.id;
      const step = env.context.run.currentStep;

      // ----------------------------------------------------------------
      // Synchronous fail-fast capability checks (before any session start).
      // ----------------------------------------------------------------
      const inferenceMapping = buildCodexConfig(profile, supportedInference);

      const role = resolveRole(input);
      const sandbox = sandboxForRole(role);
      if (!acceptedSandboxValues.has(sandbox)) {
        throw new UnsupportedProviderCapabilityError(
          'tool_policy_unsupported',
          `Codex runtime does not accept the sandbox value "${sandbox}" required for role "${role ?? 'unknown'}".`,
          { providerKind: profile.providerKind, adapterId: codexAgentAdapterId, capability: `sandbox:${sandbox}` }
        );
      }

      // Structured result configuration.
      let structuredResult: CodexStructuredResultDefinition | undefined;
      if (input.structuredResultCapture !== undefined) {
        structuredResult = {
          schemaId: input.structuredResultCapture.schemaId,
          resultFile: input.structuredResultCapture.resultFile,
          mechanism: codexStructuredResultMechanism
        };
      }

      // Materialize resolved skills (pure; throws on empty/escaping assetPath).
      const skillMaterialization = materializeCodexSkills(env.skills.resolved, runtimeSkillsCatalogRoot);

      const workspace = env.workspace;
      const cwd: string | undefined =
        'scratchRoot' in workspace ? workspace.scratchRoot : workspace.workspaceRoots[0];

      const allowedTools = mapAllowedToolsForCodex(env.toolPolicy.allowedTools, sandbox);
      const prompt = env.context.task.prompt;

      let metadataResolve!: (value: AgentProviderSessionMetadata) => void;
      let metadataReject!: (err: unknown) => void;
      const metadata = new Promise<AgentProviderSessionMetadata>((resolve, reject) => {
        metadataResolve = resolve;
        metadataReject = reject;
      });
      metadata.catch(() => undefined);

      async function* mapEvents(): AsyncIterable<RunnerEvent> {
        let tokenUsage: AgentTokenUsage = { available: false };
        let pendingResult: PendingResult | undefined;
        let capturedStructuredResult: { readonly value: unknown } | undefined;
        let resultSeen = false;
        let degradedCapabilities: ProviderCapabilityDegradation[] = [...inferenceMapping.degraded];

        try {
          // --------------------------------------------------------------
          // Build process launch config via the connection seam.
          // --------------------------------------------------------------
          let launchConfig: ProcessLaunchConfig;
          try {
            launchConfig = await connection.createProcessLaunchConfig({
              materializedEnvironment: env.environment
            });
          } catch (err) {
            safeLog('error', 'codex.adapter.launch_config_failed', {
              runId,
              step,
              providerKind: profile.providerKind,
              adapterId: codexAgentAdapterId,
              profileName: profile.profileName
            });
            throw err;
          }

          degradedCapabilities = [...launchConfig.degradedCapabilities, ...inferenceMapping.degraded];

          // Secrets to scrub from any forwarded string content.
          const knownSecretValues: string[] = [];
          const safeEnvironment: Record<string, string> = {};
          const secretSet = new Set(launchConfig.secretVariableNames);
          for (const [key, value] of Object.entries(launchConfig.environment)) {
            if (secretSet.has(key)) {
              if (typeof value === 'string' && value.length > 0) knownSecretValues.push(value);
            } else {
              safeEnvironment[key] = value;
            }
          }
          const mapCtx: MapContext = { runId, step, clock, idGenerator, knownSecretValues };

          // --------------------------------------------------------------
          // Enterprise sign-in probe (never reads/logs raw credentials). No
          // fallback to OPENAI_API_KEY or any other account.
          // --------------------------------------------------------------
          const authResult = await probeAuth({ env: safeEnvironment, ...(cwd !== undefined ? { cwd } : {}) });
          if (authResult.status !== 'authenticated') {
            safeLog('error', 'codex.adapter.auth_failed', {
              runId,
              step,
              providerKind: profile.providerKind,
              adapterId: codexAgentAdapterId,
              authMode: 'enterprise_sign_in',
              authFailureCode: authResult.code,
              failureReason: 'provider_auth_failed'
            });
            throw new CodexAuthenticationError(authResult.code, profile.providerKind);
          }

          safeLog('info', 'codex.adapter.session_start', {
            runId,
            step,
            providerKind: profile.providerKind,
            adapterId: codexAgentAdapterId,
            profileName: profile.profileName,
            configurationRecordId: profile.configurationRecordId,
            model: profile.model.model,
            mechanism: profile.connectionMechanism,
            authMode: 'enterprise_sign_in',
            accountType: authResult.accountType,
            sandbox,
            allowedToolsCount: allowedTools.length,
            requestedSkillCount: env.skills.requested.length,
            resolvedSkillCount: env.skills.resolved.length,
            deliveredSkillCount: skillMaterialization.delivered.length,
            deliveredSkills: skillMaterialization.delivered,
            cwdProvided: cwd !== undefined,
            launchConfig: launchConfig.redacted,
            ...(structuredResult !== undefined
              ? {
                  schemaId: structuredResult.schemaId,
                  resultFile: structuredResult.resultFile,
                  resultCaptureMechanism: structuredResult.mechanism
                }
              : {})
          });

          const instructionParts: string[] = [];
          if (skillMaterialization.systemPromptHint.length > 0) {
            instructionParts.push(skillMaterialization.systemPromptHint);
          }
          if (structuredResult !== undefined) {
            instructionParts.push(
              `Emit your final result as a single JSON object matching the "${structuredResult.schemaId}" contract. Do not write it to a file.`
            );
          }
          const instructions = instructionParts.join('\n\n');

          const native = launch({
            prompt,
            instructions,
            model: profile.model.model,
            ...(cwd !== undefined ? { cwd } : {}),
            env: launchConfig.environment,
            sandbox,
            allowedTools,
            ...(Object.keys(inferenceMapping.config).length > 0 ? { config: inferenceMapping.config } : {}),
            auth: { mode: 'enterprise_sign_in' },
            ...(skillMaterialization.mounts.length > 0 ? { skills: skillMaterialization.mounts } : {}),
            ...(structuredResult !== undefined ? { structuredResult } : {})
          });

          for await (const ev of native) {
            if (ev.type === 'result') {
              if (structuredResult !== undefined && ev.structuredOutput !== undefined) {
                if (capturedStructuredResult !== undefined) {
                  throw new ProviderProtocolError(
                    'duplicate_structured_result',
                    'Codex session returned structured output more than once.',
                    { providerKind: profile.providerKind, adapterId: codexAgentAdapterId }
                  );
                }
                capturedStructuredResult = { value: ev.structuredOutput };
              }
              if (resultSeen) {
                throw new ProviderProtocolError(
                  'impossible_session_sequence',
                  'Codex session produced more than one terminal result.',
                  { providerKind: profile.providerKind, adapterId: codexAgentAdapterId }
                );
              }
              resultSeen = true;
            }

            const mapped = mapNativeEvent(ev, mapCtx);
            if (mapped.usage) tokenUsage = mapped.usage;
            if (mapped.pendingResult) pendingResult = mapped.pendingResult;
            for (const out of mapped.events) yield out;
          }

          // ------------------------------------------------------------
          // Terminal handling.
          // ------------------------------------------------------------
          if (structuredResult !== undefined && input.structuredResultCapture !== undefined) {
            if (capturedStructuredResult === undefined) {
              throw new ProviderProtocolError(
                'missing_structured_result',
                'Codex session ended without returning structured output.',
                { providerKind: profile.providerKind, adapterId: codexAgentAdapterId }
              );
            }
            await writeCodexStructuredResultFile(env, input.structuredResultCapture, capturedStructuredResult.value);
            yield buildTerminalResult({ ctx: mapCtx, directive: 'advance' });
            metadataResolve({
              outcome: 'succeeded',
              launchMechanism: 'process_environment',
              degradedCapabilities,
              tokenUsage,
              model: profile.model
            });
          } else {
            const directive = pendingResult?.directive ?? 'advance';
            if (directive === 'advance') {
              await maybeWriteResultFile(env, pendingResult?.output);
            }
            yield buildTerminalResult({
              ctx: mapCtx,
              directive,
              ...(pendingResult?.question !== undefined ? { question: pendingResult.question } : {}),
              ...(pendingResult?.reason !== undefined ? { reason: pendingResult.reason } : {})
            });
            metadataResolve({
              outcome: directive === 'fail' ? 'failed' : 'succeeded',
              launchMechanism: 'process_environment',
              degradedCapabilities,
              tokenUsage,
              model: profile.model
            });
          }
        } catch (err) {
          const classified = classifyCodexError(err);
          const safeDetail = buildSafeAdapterFailureLogDetail(err, profile.providerKind);
          const failureCode = typeof safeDetail.code === 'string' ? safeDetail.code : undefined;
          safeLog('error', 'codex.adapter.session_failed', {
            runId,
            step,
            adapterId: codexAgentAdapterId,
            ...safeDetail,
            ...(classified !== undefined ? { failureReason: classified.failureReason } : {}),
            ...(err instanceof CodexAuthenticationError ? { failureReason: 'provider_auth_failed', authFailureCode: err.authFailureCode } : {}),
            ...(failureCode !== undefined ? { failureCode } : {}),
            ...(structuredResult !== undefined
              ? {
                  structuredResultCapture: true,
                  schemaId: structuredResult.schemaId,
                  resultFile: structuredResult.resultFile,
                  resultCaptureMechanism: structuredResult.mechanism
                }
              : {})
          });
          const thrown = classified ?? err;
          metadataReject(thrown);
          throw thrown;
        }
      }

      return { events: mapEvents(), metadata };
    }
  };
}
