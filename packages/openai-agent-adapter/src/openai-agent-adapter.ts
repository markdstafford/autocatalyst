import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Runner, OpenAIProvider, tool } from '@openai/agents';
import {
  SandboxAgent,
  Manifest,
  NoopSnapshotSpec,
  isNoopSnapshotSpec,
  localDir
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import type { RunItem } from '@openai/agents';
import type { SandboxClient, SandboxSessionLike } from '@openai/agents/sandbox';
import OpenAI from 'openai';
import { z } from 'zod/v4';

import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionInput,
  AgentProviderSessionMetadata,
  ProviderCapabilityDegradation,
  ProviderFetchTransport,
  ProviderRequest
} from '@autocatalyst/execution';
import {
  ClassifiedProviderFailureError,
  classifyProviderFailure,
  notifyToolInputSchema,
  ProviderProtocolError,
  reportProgressToolInputSchema,
  runtimeSkillsCatalogRoot,
  UnsupportedProviderCapabilityError,
  updatePlanToolInputSchema
} from '@autocatalyst/execution';
import { materializeOpenAISkillFiles } from './skill-materialization.js';
import type { RunnerEvent } from '@autocatalyst/api-contract';

export const openaiProviderKind = 'openai' as const;
export const openaiAgentAdapterId = 'openai-agents-sdk' as const;

// ---------------------------------------------------------------------------
// Public seam types
// ---------------------------------------------------------------------------

export interface OpenAIWorkspaceSandboxConfig {
  readonly shape: 'none' | 'scratch_only' | 'two_roots';
  readonly workspaceRoots: readonly string[];
  readonly repoRoot?: string;
  readonly scratchRoot?: string;
  readonly resultRoot?: string;
}

/**
 * A sandbox session opened against the materialized workspace. This is the real
 * `@openai/agents/sandbox` session shape (`SandboxSessionLike`); the per-session
 * `UnixLocalSandboxClient` produces it and `Runner.run({ sandbox: { session } })`
 * consumes it.
 */
export type OpenAISandboxSession = SandboxSessionLike;

export interface OpenAISandboxClientFactoryInput {
  readonly workspace: OpenAIWorkspaceSandboxConfig;
  /** The validated NoopSnapshotSpec; bound to the client, never a process global. */
  readonly snapshot: NoopSnapshotSpec;
  /** Secret-stripped environment variables to seed the sandbox with. */
  readonly environment: Readonly<Record<string, string>>;
  readonly telemetryContext: AgentProviderSessionInput['telemetryContext'];
  /** Resolved skill host→sandbox directory mounts to include in the sandbox manifest. */
  readonly skillMounts?: ReadonlyArray<{ readonly hostPath: string; readonly sandboxPath: string }>;
}

export interface OpenAISandboxClientHandle {
  /** The real (or fake) sandbox client used to create the session. */
  readonly client: SandboxClient;
  /** The session opened against the materialized workspace. */
  readonly session: OpenAISandboxSession;
  close?(): Promise<void> | void;
}

export type OpenAISandboxClientFactory = (
  input: OpenAISandboxClientFactoryInput
) => OpenAISandboxClientHandle | Promise<OpenAISandboxClientHandle>;

/**
 * Drives a single agent run. The default implementation constructs a real
 * `SandboxAgent` and a per-session `Runner` bound to an `OpenAIProvider` (which
 * is itself bound to the per-session fetch transport), then yields the real
 * `RunItem`s and final `RunResult`. Tests inject a fake to feed canned
 * RunItem-shaped events without driving the model.
 */
export interface OpenAIRunSessionInput {
  readonly prompt: string;
  readonly model: string;
  readonly instructions: string;
  readonly tools: ReturnType<typeof tool>[];
  readonly manifest: Manifest;
  readonly session: OpenAISandboxSession;
  /** OpenAIProvider bound to the per-session fetch transport. Never a global. */
  readonly modelProvider: OpenAIProvider;
  readonly modelSettings: Readonly<Record<string, unknown>>;
}

export interface OpenAIRunOutcome {
  readonly items: AsyncIterable<RunItem> | Iterable<RunItem>;
  /**
   * The terminal result of the run. `directive` maps to the canonical terminal
   * directive; `output` (if present) is written to the step-result file.
   */
  readonly result: Promise<{
    readonly directive: 'advance' | 'needs_input' | 'fail';
    readonly output?: unknown;
    readonly question?: string;
    readonly reason?: string;
    readonly tokenUsage?: { readonly input: number; readonly output: number };
  }>;
}

export type OpenAIRunAgentSession = (input: OpenAIRunSessionInput) => OpenAIRunOutcome | Promise<OpenAIRunOutcome>;

export interface OpenAIAgentAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface OpenAIAgentAdapterOptions {
  /** Override the default real-SDK sandbox client/session factory (tests inject a fake). */
  readonly sandboxClientFactory?: OpenAISandboxClientFactory;
  /** Override the default real-SDK run driver (tests inject canned RunItems). */
  readonly runAgentSession?: OpenAIRunAgentSession;
  /** Base directory under which the local sandbox materializes workspaces. Defaults to os tmp. */
  readonly sandboxWorkspaceBaseDir?: string;
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly logger?: OpenAIAgentAdapterLogger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRESS_TOOL_NAMES = new Set(['update_plan', 'report_progress', 'notify']);

// Inference settings the OpenAI Agents SDK plumbs through ModelSettings.
const SUPPORTED_INFERENCE_SETTINGS = new Set(['temperature', 'topP', 'maxOutputTokens']);
const OPTIONAL_AGENT_UNSUPPORTED_SETTINGS = ['reasoningEffort', 'seed', 'topK', 'streamingMode', 'parallelToolCalls'] as const;

// ---------------------------------------------------------------------------
// Inference settings mapping
// ---------------------------------------------------------------------------

interface OpenAIInferenceMapping {
  readonly mapped: Record<string, unknown>;
  readonly degraded: ProviderCapabilityDegradation[];
}

function mapInferenceSettings(profile: AgentProviderSessionInput['profile']): OpenAIInferenceMapping {
  const mapped: Record<string, unknown> = {};
  const degraded: ProviderCapabilityDegradation[] = [];
  const settings = profile.inferenceSettings as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    if (SUPPORTED_INFERENCE_SETTINGS.has(key)) {
      // ModelSettings uses maxTokens, not maxOutputTokens.
      mapped[key === 'maxOutputTokens' ? 'maxTokens' : key] = value;
    } else if ((OPTIONAL_AGENT_UNSUPPORTED_SETTINGS as readonly string[]).includes(key)) {
      degraded.push({
        capability: `inference_setting:${key}`,
        reason: `OpenAI agent adapter does not support ${key} in agent mode.`,
        required: false
      });
    }
  }
  return { mapped, degraded };
}

// ---------------------------------------------------------------------------
// Progress tool definitions
//
// The progress tools are *signaling* tools: the SDK executes them locally and
// returns a benign acknowledgement. The adapter intercepts the tool-call items
// (not the executor) and re-emits them as canonical runner_progress /
// runner_notification events. The executors only need to return something so the
// run loop can continue.
// ---------------------------------------------------------------------------

function createProgressTools(): ReturnType<typeof tool>[] {
  const ack = async (): Promise<string> => 'acknowledged';
  return [
    tool({
      name: 'update_plan',
      description: 'Replace the current plan with a list of safe plan items and statuses.',
      parameters: z.object({
        title: z.string(),
        steps: z.array(z.string())
      }),
      execute: ack
    }),
    tool({
      name: 'report_progress',
      description: 'Report task counts or a short safe progress intent summary.',
      parameters: z.object({
        label: z.string().nullable().optional(),
        completed: z.number().int().nullable().optional(),
        total: z.number().int().nullable().optional(),
        summary: z.string().nullable().optional()
      }),
      execute: ack
    }),
    tool({
      name: 'notify',
      description: 'Emit a safe notification for the run event stream.',
      parameters: z.object({
        message: z.string(),
        severity: z.enum(['debug', 'info', 'warn', 'error']).nullable().optional(),
        importance: z.enum(['low', 'normal', 'high']).nullable().optional()
      }),
      execute: ack
    })
  ];
}

// ---------------------------------------------------------------------------
// Event mapping helpers
// ---------------------------------------------------------------------------

interface EventContext {
  readonly runId: string;
  readonly step: string;
  readonly clock: () => string;
  readonly eventIdGenerator: () => string;
}

function baseEvent(ctx: EventContext): { id: string; runId: string; step: string; importance: 'normal'; createdAt: string } {
  return {
    id: ctx.eventIdGenerator(),
    runId: ctx.runId,
    step: ctx.step,
    importance: 'normal' as const,
    createdAt: ctx.clock()
  };
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function lowImportanceToolActivity(name: string, ctx: EventContext): RunnerEvent {
  return {
    ...baseEvent(ctx),
    type: 'runner_tool_activity',
    importance: 'low' as const,
    tool: { name, action: 'invoke', status: 'completed' }
  } as RunnerEvent;
}

function mapProgressToolCall(name: string, rawArgs: unknown, ctx: EventContext): RunnerEvent | undefined {
  const args = parseArgs(rawArgs);

  if (name === 'notify') {
    const parsed = notifyToolInputSchema.safeParse(args);
    if (!parsed.success) return lowImportanceToolActivity(name, ctx);
    return {
      ...baseEvent(ctx),
      type: 'runner_notification',
      importance: parsed.data.importance ?? 'normal',
      notification: { severity: parsed.data.severity ?? 'info', message: parsed.data.message }
    } as RunnerEvent;
  }

  if (name === 'update_plan') {
    const parsed = updatePlanToolInputSchema.safeParse(args);
    if (!parsed.success) return lowImportanceToolActivity(name, ctx);
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'plan' as const, title: parsed.data.title, steps: parsed.data.steps }
    } as RunnerEvent;
  }

  // report_progress
  const parsed = reportProgressToolInputSchema.safeParse(args);
  if (!parsed.success) return lowImportanceToolActivity(name, ctx);
  const { label, completed, total, summary } = parsed.data;
  if (completed !== undefined && total !== undefined && label !== undefined) {
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'task_progress' as const, label, completed, total }
    } as RunnerEvent;
  }
  if (summary !== undefined) {
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'intent' as const, summary }
    } as RunnerEvent;
  }
  return lowImportanceToolActivity(name, ctx);
}

function assistantText(rawItem: unknown): string {
  if (typeof rawItem !== 'object' || rawItem === null) return '';
  const content = (rawItem as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content as Array<Record<string, unknown>>) {
    if (block && block['type'] === 'output_text' && typeof block['text'] === 'string') {
      text += block['text'];
    }
  }
  return text;
}

/**
 * Maps a single native `RunItem` (from the real SDK) into a canonical
 * RunnerEvent, or undefined when the item carries no surfaced signal. Terminal
 * results are NOT produced here — the run driver returns a separate terminal
 * result so the adapter can enforce the single-terminal protocol.
 */
function mapRunItem(item: RunItem, ctx: EventContext): RunnerEvent | undefined {
  switch (item.type) {
    case 'message_output_item': {
      const text = assistantText(item.rawItem);
      if (text.length === 0) return undefined;
      return {
        ...baseEvent(ctx),
        type: 'runner_assistant_turn',
        message: { role: 'assistant', content: text }
      } as RunnerEvent;
    }

    case 'tool_call_item': {
      const raw = item.rawItem as { name?: unknown; arguments?: unknown; type?: unknown };
      const name = typeof raw.name === 'string' ? raw.name : '';
      if (PROGRESS_TOOL_NAMES.has(name)) {
        return mapProgressToolCall(name, raw.arguments, ctx);
      }
      return {
        ...baseEvent(ctx),
        type: 'runner_tool_activity',
        tool: { name: name.length > 0 ? name : 'unknown_tool', action: 'invoke', status: 'started' }
      } as RunnerEvent;
    }

    case 'tool_call_output_item': {
      const raw = item.rawItem as { name?: unknown; status?: unknown };
      const name = typeof raw.name === 'string' ? raw.name : '';
      // Progress tool acknowledgements were already surfaced on the call item.
      if (PROGRESS_TOOL_NAMES.has(name)) return undefined;
      const status = raw.status === 'incomplete' ? 'failed' : 'completed';
      return {
        ...baseEvent(ctx),
        type: 'runner_tool_activity',
        tool: { name: name.length > 0 ? name : 'unknown_tool', action: 'result', status }
      } as RunnerEvent;
    }

    // Reasoning, handoff, tool-approval, and tool-search items carry no
    // surfaced signal for the canonical stream.
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Result file helper
// ---------------------------------------------------------------------------

async function maybeWriteResultFile(
  env: AgentProviderSessionInput['runInput']['environment'],
  output: unknown
): Promise<void> {
  if (output === undefined || output === null) return;
  const workspace = env.workspace;
  const scratchRoot = 'scratchRoot' in workspace ? workspace.scratchRoot : undefined;
  if (scratchRoot === undefined) return;
  const target = path.join(scratchRoot, 'step-result.json');
  const content = typeof output === 'string' ? output : JSON.stringify(output);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  } catch {
    // Suppress raw filesystem errors that may carry host paths.
    throw new Error('OpenAI agent adapter failed to write the step result file.');
  }
}

// ---------------------------------------------------------------------------
// Workspace mapping & containment
// ---------------------------------------------------------------------------

function mapWorkspaceForSandbox(input: AgentProviderSessionInput): OpenAIWorkspaceSandboxConfig {
  const workspace = input.runInput.environment.workspace;
  if (workspace.shape === 'two_roots') {
    return {
      shape: 'two_roots',
      workspaceRoots: [...workspace.workspaceRoots],
      repoRoot: workspace.repoRoot,
      scratchRoot: workspace.scratchRoot,
      resultRoot: workspace.scratchRoot
    };
  }
  if (workspace.shape === 'scratch_only') {
    return {
      shape: 'scratch_only',
      workspaceRoots: [...workspace.workspaceRoots],
      scratchRoot: workspace.scratchRoot,
      resultRoot: workspace.scratchRoot
    };
  }
  return { shape: 'none', workspaceRoots: [] };
}

function assertWorkspaceRootsDoNotEscape(workspace: OpenAIWorkspaceSandboxConfig): void {
  const rootsSet = new Set(workspace.workspaceRoots);
  const pathsToCheck: Array<string | undefined> = [workspace.repoRoot, workspace.scratchRoot, workspace.resultRoot];
  for (const p of pathsToCheck) {
    if (p !== undefined && !rootsSet.has(p)) {
      throw new UnsupportedProviderCapabilityError(
        'workspace_containment_violation',
        `Workspace path "${p}" is not within the declared workspace roots.`,
        { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'workspace_roots' }
      );
    }
  }
}

/**
 * Builds the sandbox Manifest that materializes the run's workspace roots into
 * the local sandbox. Each declared root becomes a `localDir` entry, and each is
 * granted via `extraPathGrants` so `UnixLocalSandboxClient` may copy it from its
 * host location into the session workspace (the SDK otherwise restricts
 * local_dir sources to its own base directory).
 *
 * Optional `skillMounts` are appended as additional read-only `localDir` entries
 * so that the staged skill directories are visible inside the sandbox.
 */
function buildWorkspaceManifest(
  workspace: OpenAIWorkspaceSandboxConfig,
  environment: Readonly<Record<string, string>>,
  skillMounts: ReadonlyArray<{ readonly hostPath: string; readonly sandboxPath: string }> = []
): Manifest {
  const entries: Record<string, ReturnType<typeof localDir>> = {};
  const grants: Array<{ path: string; readOnly: boolean }> = [];
  for (const root of workspace.workspaceRoots) {
    const logicalName = path.basename(root) || 'root';
    entries[logicalName] = localDir({ src: root });
    grants.push({ path: root, readOnly: false });
  }
  for (const mount of skillMounts) {
    // Use a stable key derived from the sandbox path, preserving the path
    // structure relative to the manifest root so the sandbox places files at
    // the exact path the agent is told to look in.
    const MANIFEST_ROOT = '/workspace';
    const logicalName = mount.sandboxPath.startsWith(`${MANIFEST_ROOT}/`)
      ? mount.sandboxPath.slice(MANIFEST_ROOT.length + 1)
      : mount.sandboxPath.replace(/^\//, '');
    entries[logicalName] = localDir({ src: mount.hostPath });
    grants.push({ path: mount.hostPath, readOnly: true });
  }
  const environmentInit: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    environmentInit[key] = value;
  }
  return new Manifest({
    root: '/workspace',
    entries,
    environment: environmentInit,
    extraPathGrants: grants
  });
}

// ---------------------------------------------------------------------------
// Transport bridge: ProviderFetchTransport -> WHATWG fetch for the OpenAI client
// ---------------------------------------------------------------------------

function bridgeTransportToFetch(transport: ProviderFetchTransport): typeof fetch {
  const bridged = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let resolvedUrl: string;
    let method: string;
    let headers: Record<string, string> = {};
    let body: unknown;

    if (url instanceof Request) {
      resolvedUrl = url.url;
      method = url.method;
      url.headers.forEach((value, key) => { headers[key] = value; });
      body = init?.body ?? (await url.clone().text());
    } else {
      resolvedUrl = url.toString();
      method = init?.method ?? 'GET';
      const initHeaders = init?.headers;
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => { headers[key] = value; });
      } else if (Array.isArray(initHeaders)) {
        for (const [key, value] of initHeaders as Array<[string, string]>) headers[key] = value;
      } else if (initHeaders) {
        headers = { ...(initHeaders as Record<string, string>) };
      }
      body = init?.body;
    }

    const request: ProviderRequest = {
      url: resolvedUrl,
      method,
      headers,
      ...(body !== undefined && body !== null ? { body } : {})
    };
    return transport.fetch(request);
  };
  return bridged as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Default (real-SDK) run driver
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The structural subset of the SDK's non-stream RunResult that the adapter
 * consumes. The SDK's own `RunResult<_, SandboxAgent>` does not round-trip under
 * exactOptionalPropertyTypes (its `Agent` class declares optional fields without
 * `| undefined`), so we narrow to what we actually read instead of naming it.
 */
interface NonStreamRunResultView {
  readonly newItems: readonly RunItem[];
  readonly finalOutput: unknown;
  readonly state: { readonly _context: { readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } } };
}

/**
 * Drives a non-streaming run and returns the resolved RunResult (narrowed). The
 * `run` call itself typechecks against the concrete SandboxAgent; only naming
 * the full result type trips the SDK's exactOptional quirk, so we view it
 * structurally.
 */
async function runRunnerNonStream(
  runner: Runner,
  agent: SandboxAgent,
  prompt: string,
  session: OpenAISandboxSession,
  onError: (err: unknown) => void
): Promise<NonStreamRunResultView> {
  try {
    const result = await runner.run(agent, prompt, { sandbox: { session }, stream: false });
    return result as NonStreamRunResultView;
  } catch (err) {
    // Classify before rejecting so the result promise never carries raw SDK text.
    const shaped = err as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
    const reason = classifyProviderFailure({
      ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
      ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
      code: shaped.code,
      errorName: shaped.name,
      providerKind: openaiProviderKind
    });
    const classified: ClassifiedProviderFailureError = reason !== undefined
      ? new ClassifiedProviderFailureError(reason, {
          providerKind: openaiProviderKind,
          ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
          ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
          ...(typeof shaped.code === 'string' ? { code: shaped.code } : {}),
          ...(typeof shaped.name === 'string' ? { errorName: shaped.name } : {})
        })
      : new ClassifiedProviderFailureError('runner_failed_before_terminal_result', { providerKind: openaiProviderKind });
    onError(classified);
    throw err;
  }
}

function defaultRunAgentSession(input: OpenAIRunSessionInput): OpenAIRunOutcome {
  const agent = new SandboxAgent({
    name: 'autocatalyst-openai-agent',
    model: input.model,
    instructions: input.instructions,
    defaultManifest: input.manifest,
    tools: input.tools,
    ...(Object.keys(input.modelSettings).length > 0 ? { modelSettings: input.modelSettings } : {})
  });

  // Per-session Runner bound to the per-session model provider via RunConfig.
  // This is the ONLY place the model provider is set — never through any of the
  // SDK's process-global default setters.
  const runner = new Runner({ modelProvider: input.modelProvider, tracingDisabled: true });

  let resolveResult!: (value: OpenAIRunOutcome['result'] extends Promise<infer R> ? R : never) => void;
  let rejectResult!: (err: unknown) => void;
  const result: OpenAIRunOutcome['result'] = new Promise((resolve, reject) => {
    resolveResult = resolve as never;
    rejectResult = reject;
  });
  result.catch(() => undefined);

  async function* drive(): AsyncIterable<RunItem> {
    // The non-stream overload (no `stream: true`) returns a RunResult; let TS
    // infer the precise (agent-specialized) result type from the call.
    const runResult = await runRunnerNonStream(runner, agent, input.prompt, input.session, rejectResult);
    for (const item of runResult.newItems) {
      yield item;
    }
    const usage = runResult.state._context.usage;
    resolveResult({
      directive: 'advance',
      ...(runResult.finalOutput !== undefined ? { output: runResult.finalOutput } : {}),
      ...(usage
        ? { tokenUsage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } }
        : {})
    });
  }

  return { items: drive(), result };
}

/**
 * Default sandbox client factory: builds a per-session UnixLocalSandboxClient
 * (with the validated NoopSnapshotSpec bound to it) and opens a session over the
 * manifest that materializes the run's workspace roots.
 */
function makeDefaultSandboxClientFactory(workspaceBaseDir?: string): OpenAISandboxClientFactory {
  return async (factoryInput): Promise<OpenAISandboxClientHandle> => {
    const manifest = buildWorkspaceManifest(factoryInput.workspace, factoryInput.environment, factoryInput.skillMounts ?? []);
    let client: UnixLocalSandboxClient;
    let session: SandboxSessionLike;
    try {
      client = new UnixLocalSandboxClient({
        ...(workspaceBaseDir !== undefined ? { workspaceBaseDir } : {}),
        snapshot: factoryInput.snapshot
      });
      session = await client.create(manifest);
    } catch {
      throw new UnsupportedProviderCapabilityError(
        'sandbox_client_unsupported',
        'OpenAI local sandbox client could not open a session for the materialized workspace.',
        { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_local_sandbox_client' }
      );
    }
    return {
      client,
      session,
      async close(): Promise<void> {
        await session.close?.();
      }
    };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAIAgentAdapter(
  options: OpenAIAgentAdapterOptions = {}
): AgentProviderAdapter {
  function safeLog(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
    if (options.logger === undefined) return;
    options.logger[level](event, {
      providerKind: openaiProviderKind,
      adapterId: openaiAgentAdapterId,
      ...fields
    });
  }

  function classifySdkError(err: unknown): ClassifiedProviderFailureError | undefined {
    const shaped = err as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
    const reason = classifyProviderFailure({
      ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
      ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
      code: shaped.code,
      errorName: shaped.name,
      providerKind: openaiProviderKind
    });
    return reason === undefined
      ? undefined
      : new ClassifiedProviderFailureError(reason, {
          providerKind: openaiProviderKind,
          ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
          ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
          ...(typeof shaped.code === 'string' ? { code: shaped.code } : {}),
          ...(typeof shaped.name === 'string' ? { errorName: shaped.name } : {})
        });
  }

  const sandboxClientFactory = options.sandboxClientFactory ?? makeDefaultSandboxClientFactory(options.sandboxWorkspaceBaseDir);
  const runAgentSession = options.runAgentSession ?? defaultRunAgentSession;
  const clock = options.clock ?? (() => new Date().toISOString());
  const eventIdGenerator = options.eventIdGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);

  return {
    providerKind: openaiProviderKind,
    adapterId: openaiAgentAdapterId,
    supportedConnectionMechanism: 'fetch_transport',

    async startSession(input: AgentProviderSessionInput): Promise<AgentProviderSession> {
      // 1. Per-session transport, bound to the per-session fetch transport.
      const transport = input.connection.createFetchTransport();

      // 2. Explicit NoopSnapshotSpec with validation (snapshot belongs on the client).
      const snapshot = new NoopSnapshotSpec();
      if (!isNoopSnapshotSpec(snapshot) || snapshot.type !== 'noop') {
        throw new UnsupportedProviderCapabilityError(
          'sandbox_snapshot_unsupported',
          'The @openai/agents SDK NoopSnapshotSpec instance failed validation. The snapshot type must be "noop".',
          { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_noop_snapshot' }
        );
      }

      // 3. Workspace mapping + containment.
      const workspace = mapWorkspaceForSandbox(input);
      assertWorkspaceRootsDoNotEscape(workspace);

      // 4. Secret-env stripping.
      const { variables, secretVariableNames } = input.runInput.environment.environment;
      const secretSet = new Set(secretVariableNames);
      const safeEnvironment: Record<string, string> = {};
      for (const [key, value] of Object.entries(variables)) {
        if (!secretSet.has(key)) safeEnvironment[key] = value;
      }

      safeLog('info', 'openai_agent_session_start', {
        runId: input.telemetryContext.runId,
        phase: input.telemetryContext.phase,
        step: input.telemetryContext.step,
        role: input.telemetryContext.role,
        model: input.profile.model.model,
        connectionMechanism: input.profile.connectionMechanism,
        noopSnapshot: true,
        workspaceShape: workspace.shape,
        workspaceRootCount: workspace.workspaceRoots.length
      });

      // 5. Materialize resolved runtime skills into sandbox mounts + a system-prompt hint.
      const env = input.runInput.environment;
      const skillMaterialization = materializeOpenAISkillFiles(env.skills, runtimeSkillsCatalogRoot);

      // 6. Open the sandbox session over the materialized workspace (including skill mounts).
      let sandboxHandle: OpenAISandboxClientHandle;
      try {
        sandboxHandle = await sandboxClientFactory({
          workspace,
          snapshot,
          environment: safeEnvironment,
          telemetryContext: input.telemetryContext,
          skillMounts: skillMaterialization.mounts
        });
      } catch (err) {
        const classified = classifySdkError(err);
        if (classified !== undefined) {
          safeLog('error', 'openai.adapter.sandbox_auth_failed', {
            runId: input.telemetryContext.runId,
            step: input.telemetryContext.step,
            failureReason: classified.failureReason,
            errorName: err instanceof Error ? err.name : 'unknown'
          });
          throw classified;
        }
        throw err;
      }

      // 7. Per-session OpenAI client + model provider. The OpenAI client's fetch
      //    is bridged to the per-session ProviderFetchTransport, and the provider
      //    is passed to the per-session Runner — NEVER a global setter.
      const endpoint = input.profile.endpoint as { baseUrl?: string };
      const openAIClient = new OpenAI({
        apiKey: 'sk-autocatalyst-transport-bound',
        ...(isNonEmptyString(endpoint.baseUrl) ? { baseURL: endpoint.baseUrl } : {}),
        fetch: bridgeTransportToFetch(transport)
      });
      // OpenAIProvider's `openAIClient` is typed via its own (import-mode)
      // resolution of `openai`; under NodeNext that is nominally distinct from
      // the default-mode `OpenAI` we instantiate here even though both resolve
      // to the same package. Borrow the provider's own expected type so the two
      // identities unify without widening to `any`.
      type OpenAIProviderOptions = NonNullable<ConstructorParameters<typeof OpenAIProvider>[0]>;
      type OpenAIProviderClient = NonNullable<OpenAIProviderOptions['openAIClient']>;
      const providerOptions: OpenAIProviderOptions = {
        openAIClient: openAIClient as unknown as OpenAIProviderClient,
        useResponses: false
      };
      const modelProvider = new OpenAIProvider(providerOptions);

      const inferenceMapping = mapInferenceSettings(input.profile);
      const tools = createProgressTools();

      // The manifest the run driver hands to the SandboxAgent mirrors the one the
      // client used to open the session, so defaultManifest matches the session
      // (including skill mounts).
      const manifest = buildWorkspaceManifest(workspace, safeEnvironment, skillMaterialization.mounts);

      // Build the system instructions, appending the skill discovery hint when skills are staged.
      const baseInstructions = input.runInput.environment.context.task.prompt;
      const instructions = skillMaterialization.systemPromptHint.length > 0
        ? `${baseInstructions}\n\n${skillMaterialization.systemPromptHint}`
        : baseInstructions;

      const outcome = await runAgentSession({
        prompt: input.runInput.environment.context.task.prompt,
        model: input.profile.model.model,
        instructions,
        tools,
        manifest,
        session: sandboxHandle.session,
        modelProvider,
        modelSettings: inferenceMapping.mapped
      });

      let metadataResolve!: (value: AgentProviderSessionMetadata) => void;
      let metadataReject!: (err: unknown) => void;
      const metadataPromise = new Promise<AgentProviderSessionMetadata>((resolve, reject) => {
        metadataResolve = resolve;
        metadataReject = reject;
      });
      metadataPromise.catch(() => undefined);

      async function* events(): AsyncIterable<RunnerEvent> {
        const ctx: EventContext = {
          runId: input.runInput.environment.context.run.id,
          step: input.runInput.environment.context.run.currentStep,
          clock,
          eventIdGenerator
        };
        let terminalSeen = false;
        try {
          for await (const item of outcome.items) {
            const event = mapRunItem(item, ctx);
            if (event === undefined) continue;
            if (terminalSeen) {
              throw new ProviderProtocolError(
                'impossible_session_sequence',
                'OpenAI run produced events after the terminal result.',
                { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
              );
            }
            yield event;
          }

          const terminal = await outcome.result;

          // Result-file handoff: write the raw final output to the scratch root,
          // leaving validation to the execution entry point. Only on advance.
          if (terminal.directive === 'advance') {
            await maybeWriteResultFile(input.runInput.environment, terminal.output);
          }

          let terminalEvent: RunnerEvent;
          if (terminal.directive === 'needs_input') {
            terminalEvent = {
              ...baseEvent(ctx),
              type: 'runner_terminal_result',
              importance: 'high' as const,
              result: { directive: 'needs_input', question: terminal.question ?? 'The OpenAI agent requested more input.' }
            } as RunnerEvent;
          } else if (terminal.directive === 'fail') {
            terminalEvent = {
              ...baseEvent(ctx),
              type: 'runner_terminal_result',
              importance: 'high' as const,
              result: { directive: 'fail', reason: terminal.reason ?? 'OpenAI agent session failed.' }
            } as RunnerEvent;
          } else {
            terminalEvent = {
              ...baseEvent(ctx),
              type: 'runner_terminal_result',
              importance: 'high' as const,
              result: { directive: 'advance' }
            } as RunnerEvent;
          }
          terminalSeen = true;
          yield terminalEvent;

          metadataResolve({
            outcome: terminal.directive === 'fail' ? 'failed' : 'succeeded',
            launchMechanism: 'fetch_transport',
            degradedCapabilities: inferenceMapping.degraded,
            tokenUsage: terminal.tokenUsage
              ? { available: true, tokens: { input: terminal.tokenUsage.input, output: terminal.tokenUsage.output, cacheRead: 0, cacheWrite: 0 } }
              : { available: false },
            model: input.profile.model
          });
        } catch (err) {
          const classified = classifySdkError(err);
          const thrown = classified ?? err;
          if (classified !== undefined) {
            safeLog('error', 'openai.adapter.session_auth_failed', {
              runId: input.runInput.environment.context.run.id,
              step: input.runInput.environment.context.run.currentStep,
              failureReason: classified.failureReason,
              errorName: err instanceof Error ? err.name : 'unknown'
            });
          }
          metadataReject(thrown);
          throw thrown;
        }
      }

      return {
        events: events(),
        metadata: metadataPromise,
        async close(): Promise<void> {
          await sandboxHandle.close?.();
        }
      };
    }
  };
}
