import { describe, expect, it } from 'vitest';

import type { RunnerEvent } from '@autocatalyst/api-contract';
import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentProviderSessionInput,
  ProcessLaunchConfig,
  ProcessLaunchConfigInput,
  ProviderFetchTransport,
  ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import {
  ProviderConnectionError,
  ProviderProtocolError,
  createAgentOrchestratorRunner
} from '@autocatalyst/execution';

import {
  createOpenAIAgentAdapter,
  openaiAgentAdapterId,
  openaiProviderKind,
  type OpenAINativeEvent,
  type OpenAISessionLaunch,
  type OpenAISessionLaunchOptions
} from './openai-agent-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides?: Partial<ResolvedAgentRunnerProfile>): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: openaiProviderKind,
    adapterId: openaiAgentAdapterId,
    profileName: 'default',
    model: { provider: 'openai', model: 'gpt-4o' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'fetch_transport',
    ...overrides
  };
}

interface ConnectionRecorder {
  readonly connection: AgentConnection;
  createFetchTransportCalls: number;
  createProcessLaunchConfigCalls: ProcessLaunchConfigInput[];
}

function makeConnection(profile: ResolvedAgentRunnerProfile): ConnectionRecorder {
  const recorder: ConnectionRecorder = {
    connection: undefined as unknown as AgentConnection,
    createFetchTransportCalls: 0,
    createProcessLaunchConfigCalls: []
  };

  const fakeTransport: ProviderFetchTransport = {
    fetch: async (_request) => new Response('{}', { status: 200 })
  };

  const launchConfig: ProcessLaunchConfig = {
    environment: {},
    secretVariableNames: [],
    degradedCapabilities: [],
    redacted: {}
  };

  recorder.connection = {
    profile,
    credentialResolved: true,
    createFetchTransport(): ProviderFetchTransport {
      recorder.createFetchTransportCalls += 1;
      return fakeTransport;
    },
    createProcessLaunchConfig(input: ProcessLaunchConfigInput): ProcessLaunchConfig {
      recorder.createProcessLaunchConfigCalls.push(input);
      return launchConfig;
    }
  };
  return recorder;
}

function makeTelemetry(overrides?: Partial<AgentConnectionTelemetryContext>): AgentConnectionTelemetryContext {
  return { runId: 'run_test_1', step: 'implement', ...overrides };
}

function makeSessionInput(args: {
  profile?: ResolvedAgentRunnerProfile;
  prompt?: string;
  variables?: Record<string, string>;
  telemetry?: Partial<AgentConnectionTelemetryContext>;
} = {}): { input: AgentProviderSessionInput; recorder: ConnectionRecorder } {
  const profile = args.profile ?? makeProfile();
  const recorder = makeConnection(profile);

  const input: AgentProviderSessionInput = {
    runInput: {
      environment: {
        context: {
          run: { id: 'run_test_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
          task: { prompt: args.prompt ?? 'Do the thing', inputs: {} },
          workspaceIntent: { shape: 'none' },
          secretBindings: [],
          toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
          skills: { requested: [] },
          capabilityRequirements: {
            shell: { kind: 'bash', required: false },
            paths: { canonicalWorkspacePaths: true },
            lsp: { requested: false }
          }
        },
        workspace: { shape: 'none', workspaceRoots: [] },
        environment: { variables: args.variables ?? {}, secretVariableNames: [] },
        toolPolicy: { allowedTools: ['bash'], workspaceRoots: [] },
        skills: { requested: [] },
        capabilities: {
          shell: { kind: 'bash', available: true },
          paths: {},
          lsp: { requested: false, available: false }
        }
      }
    },
    profile,
    connection: recorder.connection,
    telemetryContext: makeTelemetry(args.telemetry)
  };
  return { input, recorder };
}

function fakeLaunch(events: OpenAINativeEvent[]): {
  launch: OpenAISessionLaunch;
  calls: OpenAISessionLaunchOptions[];
} {
  const calls: OpenAISessionLaunchOptions[] = [];
  const launch: OpenAISessionLaunch = (options) => {
    calls.push(options);
    async function* gen(): AsyncIterable<OpenAINativeEvent> {
      for (const ev of events) yield ev;
    }
    return gen();
  };
  return { launch, calls };
}

async function collect(stream: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — identity', () => {
  it('uses openai / openai-agents-sdk / fetch_transport', () => {
    const adapter = createOpenAIAgentAdapter({ launchSession: fakeLaunch([]).launch });
    expect(adapter.providerKind).toBe('openai');
    expect(adapter.adapterId).toBe('openai-agents-sdk');
    expect(adapter.supportedConnectionMechanism).toBe('fetch_transport');
  });
});

// ---------------------------------------------------------------------------
// Connection mechanism
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — connection mechanism', () => {
  it('calls createFetchTransport once and never createProcessLaunchConfig', async () => {
    const { input, recorder } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await collect(session.events);
    expect(recorder.createFetchTransportCalls).toBe(1);
    expect(recorder.createProcessLaunchConfigCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Assistant message mapping
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — assistant message', () => {
  it('maps assistant_message to runner_assistant_turn', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'assistant_message', content: 'Hello world' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const turn = events.find((e) => e.type === 'runner_assistant_turn');
    expect(turn).toBeDefined();
    if (turn?.type !== 'runner_assistant_turn') throw new Error('wrong type');
    expect(turn.message.role).toBe('assistant');
    expect(turn.message.content).toBe('Hello world');
    expect(turn.runId).toBe('run_test_1');
    expect(turn.step).toBe('implement');
  });

  it('drops empty assistant messages', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'assistant_message', content: '   ' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const turns = events.filter((e) => e.type === 'runner_assistant_turn');
    expect(turns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool call mapping
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — tool call', () => {
  it('maps tool_call to runner_tool_activity with status started', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'tool_call', name: 'web_search' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const activity = events.find((e) => e.type === 'runner_tool_activity');
    expect(activity).toBeDefined();
    if (activity?.type !== 'runner_tool_activity') throw new Error('wrong type');
    expect(activity.tool.name).toBe('web_search');
    expect(activity.tool.status).toBe('started');
  });
});

// ---------------------------------------------------------------------------
// Tool result mapping
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — tool result', () => {
  it('maps tool_result completed to runner_tool_activity action completed', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'tool_result', name: 'web_search', status: 'completed' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const activity = events.find((e) => e.type === 'runner_tool_activity');
    expect(activity).toBeDefined();
    if (activity?.type !== 'runner_tool_activity') throw new Error('wrong type');
    expect(activity.tool.action).toBe('completed');
    expect(activity.tool.status).toBe('completed');
  });

  it('maps tool_result failed to runner_tool_activity action failed', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'tool_result', name: 'code_exec', status: 'failed' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const activity = events.find((e) => e.type === 'runner_tool_activity');
    expect(activity).toBeDefined();
    if (activity?.type !== 'runner_tool_activity') throw new Error('wrong type');
    expect(activity.tool.action).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Progress update_plan mapping
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — progress_update_plan', () => {
  it('maps progress_update_plan to runner_progress with kind plan', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'progress_update_plan', title: 'My Plan', steps: ['Step 1', 'Step 2'] },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const progress = events.find((e) => e.type === 'runner_progress');
    expect(progress).toBeDefined();
    if (progress?.type !== 'runner_progress') throw new Error('wrong type');
    expect(progress.progress.kind).toBe('plan');
    if (progress.progress.kind !== 'plan') throw new Error('wrong kind');
    expect(progress.progress.title).toBe('My Plan');
    expect(progress.progress.steps).toEqual(['Step 1', 'Step 2']);
  });
});

// ---------------------------------------------------------------------------
// Progress report mapping
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — progress_report', () => {
  it('maps progress_report to runner_progress with kind task_progress', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'progress_report', label: 'Running tests', completed: 5, total: 10 },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const progress = events.find((e) => e.type === 'runner_progress');
    expect(progress).toBeDefined();
    if (progress?.type !== 'runner_progress') throw new Error('wrong type');
    expect(progress.progress.kind).toBe('task_progress');
    if (progress.progress.kind !== 'task_progress') throw new Error('wrong kind');
    expect(progress.progress.label).toBe('Running tests');
    expect(progress.progress.completed).toBe(5);
    expect(progress.progress.total).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Notify mapping
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — notify', () => {
  it('maps notify to runner_notification with correct severity', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'notify', severity: 'warn', message: 'Something unusual happened' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const notification = events.find((e) => e.type === 'runner_notification');
    expect(notification).toBeDefined();
    if (notification?.type !== 'runner_notification') throw new Error('wrong type');
    expect(notification.notification.severity).toBe('warn');
    expect(notification.notification.message).toBe('Something unusual happened');
  });
});

// ---------------------------------------------------------------------------
// Terminal result
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — terminal result', () => {
  it('maps terminal_result advance to runner_terminal_result', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const terminal = events.find((e) => e.type === 'runner_terminal_result');
    expect(terminal).toBeDefined();
    if (terminal?.type !== 'runner_terminal_result') throw new Error('wrong type');
    expect(terminal.result.directive).toBe('advance');
  });

  it('maps terminal_result needs_input with question', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'terminal_result', directive: 'needs_input', question: 'Which branch?' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const terminal = events.find((e) => e.type === 'runner_terminal_result');
    expect(terminal).toBeDefined();
    if (terminal?.type !== 'runner_terminal_result') throw new Error('wrong type');
    expect(terminal.result.directive).toBe('needs_input');
    expect(terminal.result.question).toBe('Which branch?');
  });

  it('maps terminal_result fail with reason', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'terminal_result', directive: 'fail', reason: 'Out of retries' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const terminal = events.find((e) => e.type === 'runner_terminal_result');
    expect(terminal).toBeDefined();
    if (terminal?.type !== 'runner_terminal_result') throw new Error('wrong type');
    expect(terminal.result.directive).toBe('fail');
    expect(terminal.result.reason).toBe('Out of retries');
  });
});

// ---------------------------------------------------------------------------
// Usage events → metadata tokenUsage
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — usage events', () => {
  it('accumulates usage events into metadata tokenUsage and does not emit them as RunnerEvents', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'usage', inputTokens: 100, outputTokens: 50 },
      { type: 'usage', inputTokens: 20, outputTokens: 10 },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    const usageEvents = events.filter((e) => (e as { type: string }).type === 'usage');
    expect(usageEvents).toHaveLength(0);
    const metadata = await session.metadata;
    expect(metadata.tokenUsage.available).toBe(true);
    if (!metadata.tokenUsage.available) throw new Error('no usage');
    expect(metadata.tokenUsage.tokens?.input).toBe(120);
    expect(metadata.tokenUsage.tokens?.output).toBe(60);
  });

  it('reports tokenUsage.available false when no usage events', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([{ type: 'terminal_result', directive: 'advance' }]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    expect(metadata.tokenUsage.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Protocol errors
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — protocol errors', () => {
  it('throws ProviderProtocolError when duplicate terminal is emitted', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'terminal_result', directive: 'advance' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await expect(collect(session.events)).rejects.toThrow(ProviderProtocolError);
  });

  it('throws ProviderProtocolError when event emitted after terminal', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'terminal_result', directive: 'advance' },
      { type: 'assistant_message', content: 'Too late' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await expect(collect(session.events)).rejects.toThrow(ProviderProtocolError);
  });

  it('throws ProviderProtocolError("event_mapping_failed") for required_unmappable event', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'required_unmappable', code: 'unknown_sdk_event' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await expect(collect(session.events)).rejects.toSatisfy(
      (err: unknown) => err instanceof ProviderProtocolError && err.code === 'event_mapping_failed'
    );
  });

  it('throws ProviderProtocolError("impossible_session_sequence") when no terminal event', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'assistant_message', content: 'I forgot to finish' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await expect(collect(session.events)).rejects.toSatisfy(
      (err: unknown) => err instanceof ProviderProtocolError && err.code === 'impossible_session_sequence'
    );
  });
});

// ---------------------------------------------------------------------------
// Optional ignored events
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — optional_ignored events', () => {
  it('silently drops optional_ignored events', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'optional_ignored', reason: 'not_applicable' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    const events = await collect(session.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('runner_terminal_result');
  });
});

// ---------------------------------------------------------------------------
// Inference settings translation
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — inference settings', () => {
  it('translates temperature, topP, maxOutputTokens, reasoningEffort to OpenAI options', async () => {
    const profile = makeProfile({
      inferenceSettings: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 1024,
        reasoningEffort: 'high'
      }
    });
    const { input } = makeSessionInput({ profile });
    const { launch, calls } = fakeLaunch([{ type: 'terminal_result', directive: 'advance' }]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await collect(session.events);
    expect(calls).toHaveLength(1);
    const opts = calls[0]!;
    expect(opts.options['temperature']).toBe(0.7);
    expect(opts.options['top_p']).toBe(0.9);
    expect(opts.options['max_tokens']).toBe(1024);
    expect(opts.options['reasoning_effort']).toBe('high');
  });

  it('records degradedCapabilities for unsupported optional settings', async () => {
    const profile = makeProfile({
      inferenceSettings: { topK: 40, streamingMode: 'sync' }
    });
    const { input } = makeSessionInput({ profile });
    const { launch } = fakeLaunch([{ type: 'terminal_result', directive: 'advance' }]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    const topKDeg = metadata.degradedCapabilities.find((d) => d.capability === 'topK');
    expect(topKDeg).toBeDefined();
    expect(topKDeg!.required).toBe(false);
    const modeDeg = metadata.degradedCapabilities.find((d) => d.capability === 'streamingMode');
    expect(modeDeg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Metadata outcome
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — metadata', () => {
  it('resolves metadata outcome succeeded on success', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([{ type: 'terminal_result', directive: 'advance' }]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const session = adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    expect(metadata.outcome).toBe('succeeded');
    expect(metadata.launchMechanism).toBe('fetch_transport');
  });
});

// ---------------------------------------------------------------------------
// Production launch throws typed error
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — production launch', () => {
  it('throws ProviderConnectionError("unsupported_connection_mechanism") when no injected launcher', async () => {
    const { input } = makeSessionInput();
    // No launchSession injected — uses production path
    const adapter = createOpenAIAgentAdapter();
    const session = adapter.startSession(input);
    await expect(collect(session.events)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProviderConnectionError &&
        err.code === 'unsupported_connection_mechanism'
    );
  });
});

// ---------------------------------------------------------------------------
// Integration with createAgentOrchestratorRunner
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — orchestrator runner integration', () => {
  it('can be driven by createAgentOrchestratorRunner and yields a terminal event', async () => {
    const profile = makeProfile();
    const recorder = makeConnection(profile);
    const { launch } = fakeLaunch([
      { type: 'assistant_message', content: 'Working on it...' },
      { type: 'terminal_result', directive: 'advance' }
    ]);
    const adapter = createOpenAIAgentAdapter({ launchSession: launch });
    const runner = createAgentOrchestratorRunner({
      adapter,
      profile,
      connection: recorder.connection,
      telemetryContext: makeTelemetry()
    });

    const runInput = {
      environment: {
        context: {
          run: { id: 'run_test_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
          task: { prompt: 'Do the integration test', inputs: {} },
          workspaceIntent: { shape: 'none' as const },
          secretBindings: [],
          toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' as const },
          skills: { requested: [] },
          capabilityRequirements: {
            shell: { kind: 'bash' as const, required: false },
            paths: { canonicalWorkspacePaths: true },
            lsp: { requested: false }
          }
        },
        workspace: { shape: 'none' as const, workspaceRoots: [] as string[] },
        environment: { variables: {}, secretVariableNames: [] as string[] },
        toolPolicy: { allowedTools: ['bash'], workspaceRoots: [] as string[] },
        skills: { requested: [] as string[] },
        capabilities: {
          shell: { kind: 'bash' as const, available: true },
          paths: {},
          lsp: { requested: false, available: false }
        }
      }
    };

    const events: RunnerEvent[] = [];
    for await (const ev of runner.run(runInput)) {
      events.push(ev);
    }

    const terminal = events.find((e) => e.type === 'runner_terminal_result');
    expect(terminal).toBeDefined();
    if (terminal?.type !== 'runner_terminal_result') throw new Error('wrong type');
    expect(terminal.result.directive).toBe('advance');
    const assistantTurn = events.find((e) => e.type === 'runner_assistant_turn');
    expect(assistantTurn).toBeDefined();
    await runner.close();
  });
});
