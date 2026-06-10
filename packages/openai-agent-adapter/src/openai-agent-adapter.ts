import type { TokenBreakdown } from '@autocatalyst/api-contract';
import type { RunnerEvent } from '@autocatalyst/api-contract';
import { runnerEventSchema } from '@autocatalyst/api-contract';
import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionInput,
  AgentProviderSessionMetadata,
  ProviderCapabilityDegradation
} from '@autocatalyst/execution';
import {
  ProviderConnectionError,
  ProviderProtocolError
} from '@autocatalyst/execution';

export const openaiProviderKind = 'openai' as const;
export const openaiAgentAdapterId = 'openai-agents-sdk' as const;

// ---------------------------------------------------------------------------
// Native event vocabulary (internal seam for injected harness)
// ---------------------------------------------------------------------------
export type OpenAINativeEvent =
  | { readonly type: 'assistant_message'; readonly content: string }
  | { readonly type: 'tool_call'; readonly name: string; readonly action?: string }
  | { readonly type: 'tool_result'; readonly name: string; readonly status?: 'completed' | 'failed' }
  | { readonly type: 'progress_update_plan'; readonly title: string; readonly steps: readonly string[] }
  | { readonly type: 'progress_report'; readonly label: string; readonly completed: number; readonly total: number }
  | { readonly type: 'notify'; readonly severity: 'debug' | 'info' | 'warn' | 'error'; readonly message: string }
  | { readonly type: 'terminal_result'; readonly directive: 'advance' | 'needs_input' | 'fail'; readonly question?: string; readonly reason?: string }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number }
  | { readonly type: 'optional_ignored'; readonly reason: string }
  | { readonly type: 'required_unmappable'; readonly code: string };

export interface OpenAISessionLaunchOptions {
  readonly prompt: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly model: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly tools: readonly string[];
  readonly options: Record<string, unknown>;
}

export type OpenAISessionLaunch = (
  options: OpenAISessionLaunchOptions
) => AsyncIterable<OpenAINativeEvent>;

export interface OpenAIAgentAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface OpenAIAgentAdapterOptions {
  readonly launchSession?: OpenAISessionLaunch;
  readonly logger?: OpenAIAgentAdapterLogger;
}

// ---------------------------------------------------------------------------
// Helper: generate unique event IDs
// ---------------------------------------------------------------------------
let eventIdCounter = 0;
function nextEventId(): string {
  return `openai_evt_${++eventIdCounter}`;
}

// ---------------------------------------------------------------------------
// Token usage accumulator
// ---------------------------------------------------------------------------
interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  hasUsage: boolean;
}

function buildTokenUsage(acc: TokenAccumulator): AgentProviderSessionMetadata['tokenUsage'] {
  if (!acc.hasUsage) return { available: false };
  const tokens: TokenBreakdown = {
    input: acc.inputTokens,
    output: acc.outputTokens,
    cacheRead: 0,
    cacheWrite: 0
  };
  return { available: true, tokens };
}

// ---------------------------------------------------------------------------
// Map native events to canonical RunnerEvent
// ---------------------------------------------------------------------------
async function* mapNativeEventsToRunnerEvents(
  nativeEvents: AsyncIterable<OpenAINativeEvent>,
  runId: string,
  step: string,
  role: string | undefined,
  tokenAccumulator: TokenAccumulator
): AsyncGenerator<RunnerEvent> {
  let seenTerminal = false;
  const now = () => new Date().toISOString();

  const baseFields = (extra?: Record<string, unknown>) => ({
    id: nextEventId(),
    runId,
    step,
    importance: 'normal' as const,
    createdAt: now(),
    ...extra
  });

  // role is captured for telemetry context but not emitted in RunnerEvent fields
  void role;

  for await (const native of nativeEvents) {
    if (native.type === 'usage') {
      tokenAccumulator.inputTokens += native.inputTokens ?? 0;
      tokenAccumulator.outputTokens += native.outputTokens ?? 0;
      tokenAccumulator.hasUsage = true;
      continue;
    }

    if (native.type === 'optional_ignored') {
      continue;
    }

    if (native.type === 'required_unmappable') {
      throw new ProviderProtocolError(
        'event_mapping_failed',
        'OpenAI adapter encountered a required unmappable event.',
        { code: native.code, providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
      );
    }

    if (seenTerminal) {
      throw new ProviderProtocolError(
        'impossible_session_sequence',
        'OpenAI adapter emitted an event after the terminal event.',
        { eventType: native.type, providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
      );
    }

    if (native.type === 'terminal_result') {
      seenTerminal = true;
      const resultPayload: Record<string, unknown> = { directive: native.directive };
      if (native.question !== undefined) resultPayload['question'] = native.question;
      if (native.reason !== undefined) resultPayload['reason'] = native.reason;
      yield runnerEventSchema.parse({
        ...baseFields(),
        type: 'runner_terminal_result',
        result: resultPayload
      }) as RunnerEvent;
      continue;
    }

    if (native.type === 'assistant_message') {
      if (native.content.trim().length === 0) continue;
      yield runnerEventSchema.parse({
        ...baseFields(),
        type: 'runner_assistant_turn',
        message: { role: 'assistant', content: native.content }
      }) as RunnerEvent;
      continue;
    }

    if (native.type === 'tool_call') {
      yield runnerEventSchema.parse({
        ...baseFields(),
        type: 'runner_tool_activity',
        tool: {
          name: native.name,
          action: native.action ?? 'started',
          status: 'started'
        }
      }) as RunnerEvent;
      continue;
    }

    if (native.type === 'tool_result') {
      const resolvedStatus = native.status ?? 'completed';
      yield runnerEventSchema.parse({
        ...baseFields(),
        type: 'runner_tool_activity',
        tool: {
          name: native.name,
          action: resolvedStatus === 'failed' ? 'failed' : 'completed',
          status: resolvedStatus
        }
      }) as RunnerEvent;
      continue;
    }

    if (native.type === 'progress_update_plan') {
      if (!Array.isArray(native.steps) || native.steps.length === 0) {
        throw new ProviderProtocolError(
          'invalid_provider_event',
          'OpenAI adapter progress_update_plan has invalid or empty steps.',
          { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
        );
      }
      yield runnerEventSchema.parse({
        ...baseFields(),
        type: 'runner_progress',
        progress: { kind: 'plan', title: native.title, steps: native.steps }
      }) as RunnerEvent;
      continue;
    }

    if (native.type === 'progress_report') {
      yield runnerEventSchema.parse({
        ...baseFields(),
        type: 'runner_progress',
        progress: {
          kind: 'task_progress',
          label: native.label,
          completed: native.completed,
          total: native.total
        }
      }) as RunnerEvent;
      continue;
    }

    if (native.type === 'notify') {
      yield runnerEventSchema.parse({
        ...baseFields(),
        type: 'runner_notification',
        notification: { severity: native.severity, message: native.message }
      }) as RunnerEvent;
      continue;
    }
  }

  if (!seenTerminal) {
    throw new ProviderProtocolError(
      'impossible_session_sequence',
      'OpenAI adapter event stream ended without a terminal result.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
    );
  }
}

// ---------------------------------------------------------------------------
// Inference settings translation
// ---------------------------------------------------------------------------
interface InferenceTranslationResult {
  readonly options: Record<string, unknown>;
  readonly degradedCapabilities: ProviderCapabilityDegradation[];
}

function translateInferenceSettings(
  inferenceSettings: Record<string, unknown>
): InferenceTranslationResult {
  const options: Record<string, unknown> = {};
  const degradedCapabilities: ProviderCapabilityDegradation[] = [];

  const supportedMappings: Array<[string, string]> = [
    ['temperature', 'temperature'],
    ['topP', 'top_p'],
    ['maxOutputTokens', 'max_tokens'],
    ['reasoningEffort', 'reasoning_effort']
  ];

  for (const [key, apiKey] of supportedMappings) {
    const value = inferenceSettings[key];
    if (value !== undefined) {
      options[apiKey] = value;
    }
  }

  const optionalUnsupported = ['topK', 'streamingMode', 'parallelToolCalls'];
  for (const key of optionalUnsupported) {
    if (inferenceSettings[key] !== undefined) {
      degradedCapabilities.push({
        capability: key,
        reason: `OpenAI agent adapter does not support ${key}`,
        required: false
      });
    }
  }

  return { options, degradedCapabilities };
}

// ---------------------------------------------------------------------------
// Production SDK launch (fails if SDK transport not supported)
// ---------------------------------------------------------------------------
function createProductionLaunch(): OpenAISessionLaunch {
  return (_launchOptions: OpenAISessionLaunchOptions): AsyncIterable<OpenAINativeEvent> => {
    // The production path requires a per-session fetch transport hook in the SDK.
    // If the selected OpenAI Agents SDK does not support passing a custom fetch
    // per-session (not globally), we must fail before provider access.
    throw new ProviderConnectionError(
      'unsupported_connection_mechanism',
      'OpenAI Agents SDK path cannot delegate provider HTTP through Autocatalyst connection transport. This is a required capability for the working OpenAI B1 cell.',
      {
        providerKind: openaiProviderKind,
        adapterId: openaiAgentAdapterId,
        connectionMechanism: 'fetch_transport',
        reason: 'sdk_transport_hook_not_verified'
      }
    );
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------
export function createOpenAIAgentAdapter(adapterOptions: OpenAIAgentAdapterOptions = {}): AgentProviderAdapter {
  return {
    providerKind: openaiProviderKind,
    adapterId: openaiAgentAdapterId,
    supportedConnectionMechanism: 'fetch_transport',

    startSession(input: AgentProviderSessionInput): AgentProviderSession {
      const { runInput, profile, connection, telemetryContext } = input;

      // Validate mode
      if (profile.mode !== 'agent') {
        throw new ProviderConnectionError(
          'unsupported_connection_mechanism',
          'OpenAI agent adapter requires an agent profile.',
          { mode: profile.mode }
        );
      }

      // Translate inference settings
      const rawInferenceSettings = profile.inferenceSettings as Record<string, unknown>;
      const { options: inferenceOptions, degradedCapabilities } =
        translateInferenceSettings(rawInferenceSettings);

      // Build fetch bridge from connection layer
      const transport = connection.createFetchTransport();
      const fetchBridge: typeof globalThis.fetch = async (
        url: RequestInfo | URL,
        init?: RequestInit
      ) => {
        return transport.fetch({
          url: String(url),
          method: (init?.method ?? 'GET') as string,
          headers: init?.headers as Record<string, string> | undefined,
          body: init?.body as string | undefined,
          signal: init?.signal as AbortSignal | undefined
        });
      };

      // Select session launch: injected test harness or production
      const launch = adapterOptions.launchSession ?? createProductionLaunch();

      // Extract prompt and cwd from materialized environment
      const env = runInput.environment;
      const prompt = env.context.task.prompt;
      const workspace = env.workspace;
      const cwd: string | undefined =
        workspace.shape === 'scratch_only' || workspace.shape === 'two_roots'
          ? workspace.scratchRoot
          : undefined;
      const variables = env.environment.variables as Record<string, string>;

      const progressTools = ['update_plan', 'report_progress', 'notify'];

      const launchOptions: OpenAISessionLaunchOptions = {
        prompt,
        ...(cwd !== undefined ? { cwd } : {}),
        env: variables,
        model: profile.model.model,
        fetch: fetchBridge,
        tools: progressTools,
        options: inferenceOptions
      };

      // Token usage accumulator (mutated by generator)
      const tokenAccumulator: TokenAccumulator = { inputTokens: 0, outputTokens: 0, hasUsage: false };

      // Metadata promise — attach a no-op catch to suppress unhandled rejection
      // warnings when callers only consume events and don't await metadata.
      let resolveMetadata!: (m: AgentProviderSessionMetadata) => void;
      let rejectMetadata!: (e: unknown) => void;
      const metadataPromise = new Promise<AgentProviderSessionMetadata>((res, rej) => {
        resolveMetadata = res;
        rejectMetadata = rej;
      });
      // Prevent unhandled rejection if caller only consumes events
      metadataPromise.catch(() => { /* handled by caller */ });

      const runId = telemetryContext.runId;
      const step = telemetryContext.step;
      const role = telemetryContext.role;

      const events: AsyncIterable<RunnerEvent> = {
        async *[Symbol.asyncIterator]() {
          try {
            const nativeStream = launch(launchOptions);
            yield* mapNativeEventsToRunnerEvents(
              nativeStream,
              runId,
              step,
              role,
              tokenAccumulator
            );
            resolveMetadata({
              outcome: 'succeeded',
              launchMechanism: 'fetch_transport',
              degradedCapabilities,
              tokenUsage: buildTokenUsage(tokenAccumulator)
            });
          } catch (err) {
            rejectMetadata(err);
            throw err;
          }
        }
      };

      return { events, metadata: metadataPromise };
    }
  };
}
