import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionInput,
  AgentProviderSessionMetadata,
  ProviderCapabilityDegradation,
  ProviderFetchTransport
} from '@autocatalyst/execution';
import {
  ProviderConfigurationError,
  ProviderProtocolError,
  UnsupportedProviderCapabilityError
} from '@autocatalyst/execution';
import type { RunnerEvent } from '@autocatalyst/api-contract';

export const openaiProviderKind = 'openai' as const;
export const openaiAgentAdapterId = 'openai-agents-sdk' as const;

export interface OpenAIProviderClientBinding {
  readonly kind: 'client' | 'transport';
  readonly value: unknown;
}

export interface OpenAIWorkspaceSandboxConfig {
  readonly shape: 'none' | 'scratch_only' | 'two_roots';
  readonly workspaceRoots: readonly string[];
  readonly repoRoot?: string;
  readonly scratchRoot?: string;
  readonly resultRoot?: string;
}

export interface OpenAISandboxClient {
  readonly kind: 'local';
  close?(): Promise<void> | void;
}

export interface OpenAISandboxClientFactoryInput {
  readonly workspace: OpenAIWorkspaceSandboxConfig;
  readonly snapshot: unknown;
  readonly environment: Readonly<Record<string, string>>;
  readonly transport: ProviderFetchTransport;
  readonly telemetryContext: AgentProviderSessionInput['telemetryContext'];
}

export type OpenAISandboxClientFactory = (
  input: OpenAISandboxClientFactoryInput
) => OpenAISandboxClient | Promise<OpenAISandboxClient>;

export interface OpenAINativeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface OpenAIAgentsSdkFacade {
  readonly SandboxAgent?: new (options: Record<string, unknown>) => {
    run(input: unknown, options?: Record<string, unknown>): AsyncIterable<OpenAINativeEvent> | Promise<AsyncIterable<OpenAINativeEvent>>;
  };
  readonly NoopSnapshotSpec?: new () => { readonly type?: string };
  isNoopSnapshotSpec?(value: unknown): boolean;
  createClientBinding?(input: { readonly transport: ProviderFetchTransport }): OpenAIProviderClientBinding;
}

export interface OpenAIAgentAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface OpenAIAgentAdapterOptions {
  readonly sdk?: OpenAIAgentsSdkFacade;
  readonly sandboxClientFactory?: OpenAISandboxClientFactory;
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly logger?: OpenAIAgentAdapterLogger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROGRESS_TOOL_NAMES = new Set(['update_plan', 'report_progress', 'notify']);

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
      mapped[key] = value;
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
// ---------------------------------------------------------------------------

function createProgressTools(): readonly Record<string, unknown>[] {
  return [
    {
      type: 'function',
      name: 'update_plan',
      description: 'Replace the current plan with a list of safe plan items and statuses.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          steps: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['title', 'steps']
      }
    },
    {
      type: 'function',
      name: 'report_progress',
      description: 'Report task counts or a short safe progress intent summary.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          completed: { type: 'number' },
          total: { type: 'number' },
          summary: { type: 'string' }
        }
      }
    },
    {
      type: 'function',
      name: 'notify',
      description: 'Emit a safe notification for the run event stream.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string' },
          severity: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
          importance: { type: 'string', enum: ['low', 'normal', 'high'] }
        },
        required: ['message']
      }
    }
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

function safeStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

function mapProgressToolCall(name: string, rawArgs: unknown, ctx: EventContext): RunnerEvent | undefined {
  const args = parseArgs(rawArgs);
  if (args === undefined) {
    // Invalid payload — emit low-importance tool activity
    return {
      ...baseEvent(ctx),
      type: 'runner_tool_activity',
      importance: 'low' as const,
      tool: { name, action: 'invoke', status: 'completed' }
    } as RunnerEvent;
  }

  if (name === 'notify') {
    const message = safeStr(args['message']);
    if (message.length === 0) return undefined;
    const severityRaw = args['severity'];
    const severity: 'debug' | 'info' | 'warn' | 'error' =
      severityRaw === 'debug' || severityRaw === 'info' || severityRaw === 'warn' || severityRaw === 'error'
        ? severityRaw
        : 'info';
    const importanceRaw = args['importance'];
    const importance: 'low' | 'normal' | 'high' =
      importanceRaw === 'low' || importanceRaw === 'normal' || importanceRaw === 'high'
        ? importanceRaw
        : 'normal';
    return {
      ...baseEvent(ctx),
      type: 'runner_notification',
      importance,
      notification: { severity, message }
    } as RunnerEvent;
  }

  if (name === 'update_plan') {
    const title = safeStr(args['title']);
    const steps = Array.isArray(args['steps'])
      ? (args['steps'] as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];
    if (title.length === 0 || steps.length === 0) return undefined;
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'plan' as const, title, steps }
    } as RunnerEvent;
  }

  // report_progress
  const completed = typeof args['completed'] === 'number' ? args['completed'] : undefined;
  const total = typeof args['total'] === 'number' ? args['total'] : undefined;
  const label = safeStr(args['label'] ?? '');
  const summary = safeStr(args['summary'] ?? '');

  if (completed !== undefined && total !== undefined && label.length > 0) {
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'task_progress' as const, label, completed, total }
    } as RunnerEvent;
  }
  if (summary.length > 0) {
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'intent' as const, summary }
    } as RunnerEvent;
  }
  return undefined;
}

function mapNativeEvent(native: OpenAINativeEvent, ctx: EventContext): RunnerEvent | undefined {
  switch (native.type) {
    case 'assistant':
    case 'assistant_turn':
    case 'message': {
      const content = safeStr(native['content'] ?? native['text']);
      if (content.length === 0) return undefined;
      return {
        ...baseEvent(ctx),
        type: 'runner_assistant_turn',
        message: { role: 'assistant', content }
      } as RunnerEvent;
    }

    case 'tool_call':
    case 'tool_start': {
      const name = safeStr(native['name'] ?? (native['tool'] as Record<string, unknown> | undefined)?.['name']);
      if (PROGRESS_TOOL_NAMES.has(name)) {
        return mapProgressToolCall(name, native['arguments'] ?? native['input'], ctx);
      }
      return {
        ...baseEvent(ctx),
        type: 'runner_tool_activity',
        tool: { name: name.length > 0 ? name : 'unknown_tool', action: 'invoke', status: 'started' }
      } as RunnerEvent;
    }

    case 'tool_result':
    case 'tool_end': {
      const name = safeStr(native['name'] ?? (native['tool'] as Record<string, unknown> | undefined)?.['name']);
      const status = native['isError'] === true ? 'failed' : 'completed';
      return {
        ...baseEvent(ctx),
        type: 'runner_tool_activity',
        tool: { name: name.length > 0 ? name : 'unknown_tool', action: 'result', status }
      } as RunnerEvent;
    }

    case 'final':
    case 'result': {
      const directive =
        native['directive'] === 'needs_input' ? 'needs_input' :
        native['isError'] === true ? 'fail' :
        'advance';

      if (directive === 'advance') {
        return {
          ...baseEvent(ctx),
          type: 'runner_terminal_result',
          importance: 'high' as const,
          result: { directive }
        } as RunnerEvent;
      }
      if (directive === 'needs_input') {
        return {
          ...baseEvent(ctx),
          type: 'runner_terminal_result',
          importance: 'high' as const,
          result: { directive, question: 'The OpenAI agent requested more input.' }
        } as RunnerEvent;
      }
      return {
        ...baseEvent(ctx),
        type: 'runner_terminal_result',
        importance: 'high' as const,
        result: { directive, reason: 'OpenAI agent session failed.' }
      } as RunnerEvent;
    }

    case 'system':
    case 'usage':
      return undefined;

    default:
      throw new ProviderProtocolError(
        'invalid_provider_event',
        'OpenAI native event has an unsupported type.',
        { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, eventType: native.type }
      );
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

async function resolveDefaultSdkFacade(): Promise<OpenAIAgentsSdkFacade> {
  try {
    // @ts-expect-error -- optional peer dependency: types unavailable until the package is installed
    const sdk = await import('@openai/agents');
    return sdk as unknown as OpenAIAgentsSdkFacade;
  } catch {
    throw new ProviderConfigurationError(
      'unsupported_required_capability',
      'The @openai/agents SDK package could not be loaded. Ensure it is installed.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
    );
  }
}

function assertSdkSupportsSession(sdk: OpenAIAgentsSdkFacade): asserts sdk is OpenAIAgentsSdkFacade & {
  SandboxAgent: NonNullable<OpenAIAgentsSdkFacade['SandboxAgent']>;
  NoopSnapshotSpec: NonNullable<OpenAIAgentsSdkFacade['NoopSnapshotSpec']>;
} {
  if (!sdk.SandboxAgent) {
    throw new UnsupportedProviderCapabilityError(
      'tool_policy_unsupported',
      'The @openai/agents SDK does not export SandboxAgent. Upgrade to a version that supports sandbox sessions.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_sandbox_agent' }
    );
  }
  if (!sdk.NoopSnapshotSpec) {
    throw new UnsupportedProviderCapabilityError(
      'tool_policy_unsupported',
      'The @openai/agents SDK does not export NoopSnapshotSpec. Upgrade to a version that supports noop snapshots.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_noop_snapshot' }
    );
  }
}

function createNoopSnapshot(sdk: OpenAIAgentsSdkFacade & { NoopSnapshotSpec: NonNullable<OpenAIAgentsSdkFacade['NoopSnapshotSpec']> }): { readonly type?: string } {
  const snapshot = new sdk.NoopSnapshotSpec();
  const isValid = sdk.isNoopSnapshotSpec
    ? sdk.isNoopSnapshotSpec(snapshot)
    : snapshot.type === 'noop';
  if (!isValid) {
    throw new UnsupportedProviderCapabilityError(
      'tool_policy_unsupported',
      'The @openai/agents SDK NoopSnapshotSpec instance failed validation. The snapshot type must be "noop".',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_noop_snapshot' }
    );
  }
  return snapshot;
}

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
        'tool_policy_unsupported',
        `Workspace path "${p}" is not within the declared workspace roots.`,
        { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'workspace_roots' }
      );
    }
  }
}

async function defaultSandboxClientFactory(_input: OpenAISandboxClientFactoryInput): Promise<OpenAISandboxClient> {
  try {
    // @ts-expect-error -- optional peer dependency: types unavailable until the package is installed
    const local = await import('@openai/agents/sandbox/local');
    const localModule = local as Record<string, unknown>;
    const Candidate = localModule['UnixLocalSandboxClient'] ?? localModule['LocalSandboxClient'] ?? localModule['DockerSandboxClient'];
    if (typeof Candidate !== 'function') {
      throw new Error('no local sandbox constructor found');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (Candidate as any)({
      workspaceRoots: _input.workspace.workspaceRoots,
      repoRoot: _input.workspace.repoRoot,
      scratchRoot: _input.workspace.scratchRoot,
      snapshot: _input.snapshot,
      environment: _input.environment
    }) as OpenAISandboxClient;
    return client;
  } catch {
    throw new UnsupportedProviderCapabilityError(
      'tool_policy_unsupported',
      'OpenAI local sandbox client is not available. Inject a sandboxClientFactory or install a compatible @openai/agents/sandbox/local.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_local_sandbox_client' }
    );
  }
}

function mapTokenUsage(value: unknown): AgentProviderSessionMetadata['tokenUsage'] {
  const usage = value as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (usage == null) return { available: false };
  const input = (usage.input_tokens ?? usage.prompt_tokens) ?? 0;
  const output = (usage.output_tokens ?? usage.completion_tokens) ?? 0;
  if (input === 0 && output === 0) return { available: false };
  return {
    available: true,
    tokens: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0
    }
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

  return {
    providerKind: openaiProviderKind,
    adapterId: openaiAgentAdapterId,
    supportedConnectionMechanism: 'fetch_transport',

    async startSession(input: AgentProviderSessionInput): Promise<AgentProviderSession> {
      const sdk = options.sdk ?? await resolveDefaultSdkFacade();
      assertSdkSupportsSession(sdk);

      const transport = input.connection.createFetchTransport();
      const clientBinding = sdk.createClientBinding?.({ transport }) ?? { kind: 'transport' as const, value: transport };
      if (clientBinding.kind !== 'client' && clientBinding.kind !== 'transport') {
        throw new UnsupportedProviderCapabilityError(
          'header_operation_unsupported',
          'OpenAI Agents SDK custom client or transport binding is unavailable.',
          { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_custom_transport' }
        );
      }

      const snapshot = createNoopSnapshot(sdk);
      const workspace = mapWorkspaceForSandbox(input);
      assertWorkspaceRootsDoNotEscape(workspace);
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
      const sandboxFactory = options.sandboxClientFactory ?? defaultSandboxClientFactory;
      const { variables, secretVariableNames } = input.runInput.environment.environment;
      const safeEnvironment: Record<string, string> = {};
      const secretSet = new Set(secretVariableNames);
      for (const [key, value] of Object.entries(variables)) {
        if (!secretSet.has(key)) {
          safeEnvironment[key] = value;
        }
      }

      const sandboxClient = await sandboxFactory({
        workspace,
        snapshot,
        environment: safeEnvironment,
        transport,
        telemetryContext: input.telemetryContext
      });
      if (sandboxClient.kind !== 'local') {
        throw new UnsupportedProviderCapabilityError(
          'tool_policy_unsupported',
          'OpenAI agent sessions require a local sandbox client.',
          { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_local_sandbox_client' }
        );
      }

      const inferenceMapping = mapInferenceSettings(input.profile);

      // Build a Record for agent options to avoid computed property TypeScript issues
      const agentOptions: Record<string, unknown> = {
        model: input.profile.model.model,
        tools: createProgressTools(),
        sandbox: sandboxClient,
        snapshot,
        inferenceSettings: inferenceMapping.mapped
      };
      agentOptions[clientBinding.kind] = clientBinding.value;

      const agent = new sdk.SandboxAgent(agentOptions);

      let metadataResolve!: (value: AgentProviderSessionMetadata) => void;
      let metadataReject!: (err: unknown) => void;
      const metadataPromise = new Promise<AgentProviderSessionMetadata>((resolve, reject) => {
        metadataResolve = resolve;
        metadataReject = reject;
      });

      const clock = options.clock ?? (() => new Date().toISOString());
      const eventIdGenerator = options.eventIdGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);

      async function* events(): AsyncIterable<RunnerEvent> {
        const ctx: EventContext = {
          runId: input.runInput.environment.context.run.id,
          step: input.runInput.environment.context.run.currentStep,
          clock,
          eventIdGenerator
        };
        let terminalSeen = false;
        let lastUsage: unknown = undefined;
        try {
          const runOptions: Record<string, unknown> = {
            sandbox: sandboxClient,
            snapshot
          };
          runOptions[clientBinding.kind] = clientBinding.value;

          const nativeStream = await agent.run(
            input.runInput.environment.context.task.prompt,
            runOptions
          );
          for await (const native of nativeStream) {
            if (native.type === 'result' || native.type === 'final' || native.type === 'usage') {
              lastUsage = native['usage'] ?? lastUsage;
            }
            const event = mapNativeEvent(native, ctx);
            if (event === undefined) continue;
            if (terminalSeen) {
              throw new ProviderProtocolError(
                'impossible_session_sequence',
                'OpenAI native stream produced events after terminal result.',
                { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
              );
            }
            if (event.type === 'runner_terminal_result') terminalSeen = true;
            yield event;
          }
          if (!terminalSeen) {
            throw new ProviderProtocolError(
              'impossible_session_sequence',
              'OpenAI native stream ended without a terminal result.',
              { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
            );
          }
          metadataResolve({
            outcome: 'succeeded',
            launchMechanism: 'fetch_transport',
            degradedCapabilities: inferenceMapping.degraded,
            tokenUsage: mapTokenUsage(lastUsage),
            model: input.profile.model
          });
        } catch (err) {
          metadataReject(err);
          throw err;
        }
      }

      return {
        events: events(),
        metadata: metadataPromise,
        async close(): Promise<void> {
          await sandboxClient.close?.();
        }
      };
    }
  };
}
