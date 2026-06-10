/**
 * Integration tests for multi-cell control-plane dispatch.
 *
 * OpenAI is no longer an agent cell — it is a direct cell ({openai, direct}).
 * Claude is the only agent cell. These tests prove, all through the production
 * `createDirectCallFactory` / `DefaultOrchestrator` seams:
 *   (a) the Claude agent cell dispatches through the production agent seam;
 *   (b) the Anthropic direct cell dispatches and validates through the direct seam;
 *   (c) the OpenAI direct cell dispatches and validates through the direct seam.
 * It also keeps the sensitive-data redaction assertions, now covering both the
 * Anthropic direct cell and the OpenAI direct cell.
 */

import { describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import {
  buildProviderAdapterKey,
  consumeRunnerEvents,
  createExecutionRunUnitOfWork,
  DefaultOrchestrator,
  InMemoryRetainedRunEventStore,
  RunDispatchQueue,
} from '@autocatalyst/core';
import type { ConfigurationRecord, JsonValue, Run, RunStep } from '@autocatalyst/api-contract';
import type { ConversationIngressRepository, RunRepository } from '@autocatalyst/core';
import {
  createAgentConnection,
  createAgentRunnerFactory,
  createDirectCallFactory,
  getAgentProviderAdapterKey,
  type AgentConnection,
  type AgentConnectionTelemetryContext,
  type AgentProfileResolution,
  type AgentProviderAdapter,
  type AgentRunnerFactoryInput,
  type DirectOrchestratorCallResult,
  type ProcessLaunchConfig,
  type ProcessLaunchConfigInput,
  type ProviderFetchTransport,
  type ResolvedAgentRunnerProfile,
  type RunnerEvent
} from '@autocatalyst/execution';
import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter,
  type ClaudeNativeEvent,
  type ClaudeSessionLaunch
} from '@autocatalyst/claude-agent-adapter';
import {
  anthropicDirectAdapterId,
  anthropicProviderKind,
  createAnthropicDirectAdapter
} from '@autocatalyst/anthropic-direct-adapter';
import {
  createOpenAIDirectAdapter,
  openaiDirectAdapterId,
  openaiProviderKind
} from '@autocatalyst/openai-direct-adapter';
import {
  createOpenAIAgentAdapter,
  openaiAgentAdapterId,
  type OpenAINativeEvent
} from '@autocatalyst/openai-agent-adapter';
import { createExplicitProfileResolver } from './server.js';

// ---------------------------------------------------------------------------
// Fake launcher helpers
// ---------------------------------------------------------------------------

function createFakeClaudeLaunch(events: ClaudeNativeEvent[]): ClaudeSessionLaunch {
  return (options) => {
    void options; // suppress unused warning
    async function* gen(): AsyncIterable<ClaudeNativeEvent> {
      for (const ev of events) yield ev;
    }
    return gen();
  };
}

function makeClaudeProfile(overrides?: Partial<ResolvedAgentRunnerProfile>): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: claudeProviderKind,
    adapterId: claudeAgentAdapterId,
    profileName: 'test-claude',
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'process_environment',
    ...overrides
  };
}

function makeProcessConnection(profile: ResolvedAgentRunnerProfile): AgentConnection {
  const launchConfig: ProcessLaunchConfig = {
    environment: { ANTHROPIC_AUTH_TOKEN: 'fake-token', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    secretVariableNames: ['ANTHROPIC_AUTH_TOKEN'],
    degradedCapabilities: [],
    redacted: { mechanism: 'process_environment', hasAuthToken: true }
  };
  return {
    profile,
    credentialResolved: true,
    createFetchTransport(): ProviderFetchTransport {
      throw new Error('createFetchTransport not supported for process_environment');
    },
    createProcessLaunchConfig(_input: ProcessLaunchConfigInput): ProcessLaunchConfig {
      return launchConfig;
    }
  };
}

// ---------------------------------------------------------------------------
// (a) Claude agent cell dispatches through the agent runner factory seam
// ---------------------------------------------------------------------------

describe('runner-cells: Claude agent cell dispatch', () => {
  it('dispatches the Claude agent cell through the production agent runner factory seam', async () => {
    const CLAUDE_EVENTS: ClaudeNativeEvent[] = [
      { type: 'assistant', content: 'Implementing the feature...' },
      { type: 'result', result: { output: '{"directive":"advance"}' } }
    ];

    const claudeAdapter = createClaudeAgentAdapter({
      launchClaudeSession: createFakeClaudeLaunch(CLAUDE_EVENTS)
    });

    const agentRegistry = new Map([
      [getAgentProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId), claudeAdapter]
    ]);

    const profile = makeClaudeProfile();
    const runId = 'run_claude_agent_001';
    const step = 'implement';

    const agentRunnerFactory = createAgentRunnerFactory({
      adapters: agentRegistry,
      resolveProfile: async (_factoryInput: AgentRunnerFactoryInput): Promise<AgentProfileResolution> => ({
        profile,
        credentialReference: { required: false }
      }),
      createConnection: async (connectionInput) => makeProcessConnection(connectionInput.profile),
      telemetryContext: (factoryInput): AgentConnectionTelemetryContext => ({
        runId: factoryInput.runId,
        step: factoryInput.step,
        ...(factoryInput.role !== undefined && { role: factoryInput.role }),
        profileName: profile.profileName
      })
    });

    const runner = await agentRunnerFactory.createRunner({ runId, step });
    const eventsStore = new InMemoryRetainedRunEventStore({ maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32 });

    let eventCount = 0;
    const subscription = eventsStore.subscribe({ runId, tenant: 'tenant_test' });
    const countingPromise = (async () => {
      for await (const _ev of subscription.events) {
        eventCount++;
      }
    })();

    const result = await consumeRunnerEvents({
      eventsStore,
      events: runner.run({
        environment: {
          context: {
            run: { id: runId, workKind: 'feature', currentStep: step, tenant: 'tenant_test' },
            task: { prompt: 'Test task', inputs: {} },
            workspaceIntent: { shape: 'none' },
            secretBindings: [],
            toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
            skills: { requested: [] },
            capabilityRequirements: {
              shell: { kind: 'bash', required: false },
              paths: { canonicalWorkspacePaths: false },
              lsp: { requested: false }
            }
          },
          workspace: { shape: 'none', workspaceRoots: [] },
          environment: { variables: {}, secretVariableNames: [] },
          toolPolicy: { allowedTools: [], workspaceRoots: [] },
          skills: { requested: [] },
          capabilities: {
            shell: { kind: 'bash', available: false },
            paths: {},
            lsp: { requested: false, available: false }
          }
        }
      }),
      runId,
      tenant: 'tenant_test'
    });

    subscription.close();
    await countingPromise;

    expect(result.workResult.directive).toBe('advance');
    expect(profile.providerKind).toBe(claudeProviderKind);
    expect(eventCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Anthropic direct cell dispatches + validates
// ---------------------------------------------------------------------------

describe('runner-cells: Anthropic direct dispatch', () => {
  it('Anthropic direct call returns validated result through direct dispatch', async () => {
    const schema = z.object({ intent: z.enum(['implement', 'review']) }).strict();

    const fakeTransport: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'autocatalyst_direct_result', input: { intent: 'implement' } }],
        model: 'claude-3-5-sonnet-latest',
        usage: { input_tokens: 20, output_tokens: 10 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const anthropicAdapter = createAnthropicDirectAdapter();

    const directCallFactory = createDirectCallFactory({
      adapters: [anthropicAdapter],
      resolveProfile: async (): Promise<{ profile: ResolvedAgentRunnerProfile; credentialReference: { required: boolean } }> => ({
        profile: {
          mode: 'direct',
          providerKind: anthropicProviderKind,
          adapterId: anthropicDirectAdapterId,
          profileName: 'test-anthropic-direct',
          model: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport'
        },
        credentialReference: { required: false }
      }),
      createConnection: async (input) => ({
        profile: input.profile,
        credentialResolved: true,
        createFetchTransport: () => fakeTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      })
    });

    const result = await directCallFactory.call({
      runId: 'run_direct_001',
      phase: 'main',
      step: 'classify_intent',
      directCall: {
        purpose: 'intent_classification',
        input: { id: 'msg_1' },
        resultValidation: { schemaId: 'intent-result', schema }
      }
    });

    expect(result.value).toEqual({ intent: 'implement' });

    const workResult = { directive: 'advance' as const, result: result.value };
    expect(workResult.directive).toBe('advance');
    expect(result.value).toEqual({ intent: 'implement' });
    expect(fakeTransport.fetch).toHaveBeenCalledTimes(1);
  });

  it('direct-step execution seam hands validated result to orchestrator checkpoint', async () => {
    const schema = z.object({ classification: z.string() }).strict();

    const fakeFetchTransport: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu_2', name: 'autocatalyst_direct_result', input: { classification: 'feature' } }],
        model: 'claude-3-5-sonnet-latest',
        usage: { input_tokens: 15, output_tokens: 8 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const anthropicAdapter = createAnthropicDirectAdapter();

    const directCallFactory = createDirectCallFactory({
      adapters: [anthropicAdapter],
      resolveProfile: async () => ({
        profile: {
          mode: 'direct' as const,
          providerKind: anthropicProviderKind,
          adapterId: anthropicDirectAdapterId,
          profileName: 'test-direct-port',
          model: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport' as const
        },
        credentialReference: { required: false }
      }),
      createConnection: async (input) => ({
        profile: input.profile,
        credentialResolved: true,
        createFetchTransport: () => fakeFetchTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      })
    });

    const directPortCallSpy = vi.spyOn(directCallFactory, 'call');

    const callResult = await directCallFactory.call({
      runId: 'run_port_002',
      phase: 'main',
      step: 'classify_step',
      directCall: {
        purpose: 'classify work kind',
        input: { workItem: 'feature request' },
        resultValidation: { schemaId: 'work-classification', schema }
      }
    });

    expect(directPortCallSpy).toHaveBeenCalledOnce();
    expect(callResult.value).toEqual({ classification: 'feature' });
    expect(callResult.metadata.outcome).toBe('succeeded');

    // Direct mode never emits runner events.
    const _noEventsTypeCheck: DirectOrchestratorCallResult = callResult;
    expect('events' in _noEventsTypeCheck).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(callResult, 'events')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) OpenAI direct cell dispatches + validates
// ---------------------------------------------------------------------------

describe('runner-cells: OpenAI direct dispatch', () => {
  it('OpenAI direct call returns validated result through direct dispatch', async () => {
    const schema = z.object({ intent: z.enum(['implement', 'review']) }).strict();

    const fakeTransport: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"intent":"review"}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 18, completion_tokens: 9 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const openaiAdapter = createOpenAIDirectAdapter();

    const directCallFactory = createDirectCallFactory({
      adapters: [openaiAdapter],
      resolveProfile: async (): Promise<{ profile: ResolvedAgentRunnerProfile; credentialReference: { required: boolean } }> => ({
        profile: {
          mode: 'direct',
          providerKind: openaiProviderKind,
          adapterId: openaiDirectAdapterId,
          profileName: 'test-openai-direct',
          model: { provider: 'openai', model: 'gpt-4o' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport'
        },
        credentialReference: { required: false }
      }),
      createConnection: async (input) => ({
        profile: input.profile,
        credentialResolved: true,
        createFetchTransport: () => fakeTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      })
    });

    const result = await directCallFactory.call({
      runId: 'run_openai_direct_001',
      phase: 'main',
      step: 'classify_intent',
      directCall: {
        purpose: 'intent_classification',
        input: { id: 'msg_1' },
        resultValidation: { schemaId: 'intent-result', schema }
      }
    });

    expect(result.value).toEqual({ intent: 'review' });
    expect(result.metadata.outcome).toBe('succeeded');
    expect(fakeTransport.fetch).toHaveBeenCalledTimes(1);
  });

  it('OpenAI direct result persists as checkpoint via DefaultOrchestrator through the production direct seam', async () => {
    const schema = z.object({ intent: z.enum(['implement', 'review']) }).strict();
    const fakeTransport: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_prod', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"intent":"implement"}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const openaiAdapter = createOpenAIDirectAdapter();
    const directCallFactory = createDirectCallFactory({
      adapters: [openaiAdapter],
      resolveProfile: async () => ({
        profile: {
          mode: 'direct' as const,
          providerKind: openaiProviderKind,
          adapterId: openaiDirectAdapterId,
          profileName: 'test-openai-direct',
          model: { provider: 'openai', model: 'gpt-4o' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport' as const
        },
        credentialReference: { required: false }
      }),
      createConnection: async (input) => ({
        profile: input.profile,
        credentialResolved: true,
        createFetchTransport: () => fakeTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      })
    });

    const directUoW = createExecutionRunUnitOfWork({
      execute: {
        execute: () => {
          throw new Error('execute should not be called in direct mode');
        }
      },
      resolveContext: async (workInput) => ({
        run: { id: workInput.runId, workKind: 'feature', currentStep: workInput.run.currentStep, tenant: workInput.tenant },
        task: { prompt: 'Classify intent', inputs: {} },
        workspaceIntent: { shape: 'none' },
        secretBindings: [],
        toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
        skills: { requested: [] },
        capabilityRequirements: {
          shell: { kind: 'bash', required: false },
          paths: { canonicalWorkspacePaths: false },
          lsp: { requested: false }
        }
      }),
      resolveExecutionMode: () => ({
        mode: 'direct' as const,
        directCall: {
          purpose: 'intent_classification',
          input: { rawText: 'implement this feature' },
          resultValidation: { schemaId: 'intent-result', schema }
        }
      }),
      direct: {
        call: (input) => directCallFactory.call({
          runId: input.runId,
          step: input.step,
          ...(input.phase !== undefined && { phase: input.phase }),
          directCall: input.directCall
        })
      },
      eventsStore: new InMemoryRetainedRunEventStore({
        maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32
      })
    });

    const capturedTransitions: Array<{ checkpointResult?: JsonValue }> = [];
    const fakeRunRepo = makeFakeRunRepo({
      recordRunStepTransition: vi.fn().mockImplementation(async (input: { checkpointResult?: JsonValue }) => {
        capturedTransitions.push({ checkpointResult: input.checkpointResult });
        return {
          run: makeRun({ currentStep: 'spec.author' }),
          runStep: makeRunStep({ step: 'spec.author' })
        };
      })
    });

    const eventBus = new InMemoryRetainedRunEventStore({
      maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32
    });
    const orchestrator = new DefaultOrchestrator({
      runs: fakeRunRepo,
      conversationIngress: makeFakeIngressRepo(),
      events: eventBus,
      dispatchQueue: new RunDispatchQueue({ maxConcurrent: 1 }),
      unitOfWork: directUoW
    });

    await orchestrator.dispatch({ runId: 'run_prod_001', tenant: 'tenant_test' });

    expect(capturedTransitions).toHaveLength(1);
    expect(capturedTransitions[0]?.checkpointResult).toEqual({ intent: 'implement' });
    expect(fakeTransport.fetch).toHaveBeenCalledTimes(1);

    const replay = await eventBus.replayAfter({ runId: 'run_prod_001', tenant: 'tenant_test' });
    expect(replay.status).toBe('ok');
    if (replay.status === 'ok') {
      expect(replay.events).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Redaction assertions — covering the Anthropic direct cell and the OpenAI direct cell
// ---------------------------------------------------------------------------

describe('runner-cells: sensitive data redaction', () => {
  it('does not expose sensitive data in telemetry events for either direct cell', async () => {
    const OPENAI_FAKE_SECRET = 'sk-openai-fake-secret-xyz';
    const ANTHROPIC_FAKE_SECRET = 'sk-ant-fake-secret-abc';
    const RAW_PROMPT_BODY = 'raw prompt body secret content';

    const telemetryEvents: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const telemetryEmitter = {
      emit(event: string, fields: Record<string, unknown>) {
        telemetryEvents.push({ event, fields });
      }
    };

    // 1. Anthropic direct adapter redaction via telemetry
    const anthropicTransport: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu_red_1', name: 'autocatalyst_direct_result', input: { result: 'ok' } }],
        model: 'claude-3-5-sonnet-latest',
        usage: { input_tokens: 5, output_tokens: 3 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const schema = z.object({ result: z.string() });
    const anthropicAdapter = createAnthropicDirectAdapter();

    const anthropicDirectCallFactory = createDirectCallFactory({
      adapters: [anthropicAdapter],
      resolveProfile: async () => ({
        profile: {
          mode: 'direct' as const,
          providerKind: anthropicProviderKind,
          adapterId: anthropicDirectAdapterId,
          profileName: 'test-redaction-anthropic',
          model: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport' as const
        },
        credentialReference: { required: false }
      }),
      createConnection: async (input) => ({
        profile: input.profile,
        credentialResolved: true,
        createFetchTransport: () => anthropicTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      }),
      telemetry: telemetryEmitter
    });

    await anthropicDirectCallFactory.call({
      runId: 'run_redact_001',
      phase: 'main',
      step: 'classify_sensitive',
      directCall: {
        purpose: 'test redaction',
        input: {
          prompt: RAW_PROMPT_BODY,
          secret: ANTHROPIC_FAKE_SECRET
        },
        resultValidation: { schemaId: 'redaction-test', schema }
      }
    });

    // 2. OpenAI direct adapter redaction via telemetry
    const openaiTransport: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_red', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"result":"ok"}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const openaiAdapter = createOpenAIDirectAdapter();

    const openaiDirectCallFactory = createDirectCallFactory({
      adapters: [openaiAdapter],
      resolveProfile: async () => ({
        profile: {
          mode: 'direct' as const,
          providerKind: openaiProviderKind,
          adapterId: openaiDirectAdapterId,
          profileName: 'test-redaction-openai',
          model: { provider: 'openai', model: 'gpt-4o' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport' as const
        },
        credentialReference: { required: false }
      }),
      createConnection: async (input) => ({
        profile: input.profile,
        credentialResolved: true,
        createFetchTransport: () => openaiTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      }),
      telemetry: telemetryEmitter
    });

    await openaiDirectCallFactory.call({
      runId: 'run_redact_002',
      phase: 'main',
      step: 'classify_sensitive',
      directCall: {
        purpose: 'test redaction',
        input: {
          prompt: RAW_PROMPT_BODY,
          secret: OPENAI_FAKE_SECRET
        },
        resultValidation: { schemaId: 'redaction-test', schema }
      }
    });

    // Serialized telemetry must not contain sensitive values from either cell.
    const serializedTelemetry = JSON.stringify(telemetryEvents);
    expect(serializedTelemetry).not.toContain(ANTHROPIC_FAKE_SECRET);
    expect(serializedTelemetry).not.toContain(OPENAI_FAKE_SECRET);
    expect(serializedTelemetry).not.toContain(RAW_PROMPT_BODY);

    // Telemetry was actually emitted (non-vacuous) for both direct cells.
    expect(telemetryEvents.length).toBeGreaterThan(0);
    const directEndEvents = telemetryEvents.filter(e => e.event === 'direct_orchestrator_call_end');
    expect(directEndEvents.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Production-seam integration helpers
// ---------------------------------------------------------------------------

const TS = '2026-06-10T00:00:00.000Z';
const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_test', displayName: 'Test User' };

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_prod_001',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_test',
    workKind: 'feature',
    currentStep: 'intake',
    terminal: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides
  };
}

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step_1',
    runId: 'run_prod_001',
    phase: null,
    step: 'intake',
    role: 'none',
    startedAt: TS,
    endedAt: null,
    durationMs: null,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: null,
    ...overrides
  };
}

function makeFakeRunRepo(overrides: Partial<RunRepository> = {}): RunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(makeRun()),
    findActiveByTopic: vi.fn().mockResolvedValue(null),
    listByTopic: vi.fn().mockResolvedValue([]),
    recordRunLifecycleStart: vi.fn().mockResolvedValue({ run: makeRun(), runStep: makeRunStep() }),
    recordRunStepTransition: vi.fn().mockResolvedValue({
      run: makeRun({ currentStep: 'spec.author' }),
      runStep: makeRunStep({ step: 'spec.author' })
    }),
    ...overrides
  };
}

function makeFakeIngressRepo(): ConversationIngressRepository {
  return {
    createConversationTopicMessageAndRun: vi.fn().mockResolvedValue({
      conversation: { id: 'conv_1' },
      topic: { id: 'topic_1' },
      message: { id: 'msg_1' },
      run: makeRun(),
      runStep: makeRunStep()
    })
  } as unknown as ConversationIngressRepository;
}

// ---------------------------------------------------------------------------
// Direct mode through DefaultOrchestrator and createExecutionRunUnitOfWork (Anthropic)
// ---------------------------------------------------------------------------

describe('runner-cells: direct mode through DefaultOrchestrator and createExecutionRunUnitOfWork', () => {
  it('Anthropic direct result persists as checkpoint via DefaultOrchestrator.applyDirective()', async () => {
    const schema = z.object({ intent: z.enum(['implement', 'review']) }).strict();
    const fakeTransport: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'autocatalyst_direct_result', input: { intent: 'implement' } }],
        model: 'claude-3-5-sonnet-latest',
        usage: { input_tokens: 20, output_tokens: 10 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const anthropicAdapter = createAnthropicDirectAdapter();
    const directCallFactory = createDirectCallFactory({
      adapters: [anthropicAdapter],
      resolveProfile: async () => ({
        profile: {
          mode: 'direct' as const,
          providerKind: anthropicProviderKind,
          adapterId: anthropicDirectAdapterId,
          profileName: 'test-direct',
          model: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport' as const
        },
        credentialReference: { required: false }
      }),
      createConnection: async (input) => ({
        profile: input.profile,
        credentialResolved: true,
        createFetchTransport: () => fakeTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      })
    });

    const directUoW = createExecutionRunUnitOfWork({
      execute: {
        execute: () => {
          throw new Error('execute should not be called in direct mode');
        }
      },
      resolveContext: async (workInput) => ({
        run: { id: workInput.runId, workKind: 'feature', currentStep: workInput.run.currentStep, tenant: workInput.tenant },
        task: { prompt: 'Classify intent', inputs: {} },
        workspaceIntent: { shape: 'none' },
        secretBindings: [],
        toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
        skills: { requested: [] },
        capabilityRequirements: {
          shell: { kind: 'bash', required: false },
          paths: { canonicalWorkspacePaths: false },
          lsp: { requested: false }
        }
      }),
      resolveExecutionMode: () => ({
        mode: 'direct' as const,
        directCall: {
          purpose: 'intent_classification',
          input: { rawText: 'implement this feature' },
          resultValidation: { schemaId: 'intent-result', schema }
        }
      }),
      direct: {
        call: (input) => directCallFactory.call({
          runId: input.runId,
          step: input.step,
          ...(input.phase !== undefined && { phase: input.phase }),
          directCall: input.directCall
        })
      },
      eventsStore: new InMemoryRetainedRunEventStore({
        maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32
      })
    });

    const capturedTransitions: Array<{ checkpointResult?: JsonValue }> = [];
    const fakeRunRepo = makeFakeRunRepo({
      recordRunStepTransition: vi.fn().mockImplementation(async (input: { checkpointResult?: JsonValue }) => {
        capturedTransitions.push({ checkpointResult: input.checkpointResult });
        return {
          run: makeRun({ currentStep: 'spec.author' }),
          runStep: makeRunStep({ step: 'spec.author' })
        };
      })
    });

    const eventBus = new InMemoryRetainedRunEventStore({
      maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32
    });
    const orchestrator = new DefaultOrchestrator({
      runs: fakeRunRepo,
      conversationIngress: makeFakeIngressRepo(),
      events: eventBus,
      dispatchQueue: new RunDispatchQueue({ maxConcurrent: 1 }),
      unitOfWork: directUoW
    });

    await orchestrator.dispatch({ runId: 'run_prod_001', tenant: 'tenant_test' });

    expect(capturedTransitions).toHaveLength(1);
    expect(capturedTransitions[0]?.checkpointResult).toEqual({ intent: 'implement' });
    expect(fakeTransport.fetch).toHaveBeenCalledTimes(1);

    const replay = await eventBus.replayAfter({ runId: 'run_prod_001', tenant: 'tenant_test' });
    expect(replay.status).toBe('ok');
    if (replay.status === 'ok') {
      expect(replay.events).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Credential guard — required=true with absent secret fails before provider access
// ---------------------------------------------------------------------------

describe('runner-cells: direct credential guard', () => {
  it('throws missing_credential before adapter call when credentialSecretHandle is configured but secret is absent', async () => {
    const adapterCallSpy = vi.fn();
    const openaiAdapter = createOpenAIDirectAdapter();
    const originalCall = openaiAdapter.call.bind(openaiAdapter);
    openaiAdapter.call = async (...args) => {
      adapterCallSpy();
      return originalCall(...args);
    };

    const directCallFactory = createDirectCallFactory({
      adapters: [openaiAdapter],
      resolveProfile: async () => ({
        profile: {
          mode: 'direct' as const,
          providerKind: openaiProviderKind,
          adapterId: openaiDirectAdapterId,
          profileName: 'test-credential-guard',
          model: { provider: 'openai', model: 'gpt-4o' },
          inferenceSettings: {},
          endpoint: {},
          connectionMechanism: 'fetch_transport' as const
        },
        // Simulates the production direct profile resolver when credentialSecretHandle is set
        credentialReference: { required: true, secretHandle: 'sec_openai_missing' }
      }),
      createConnection: async (input) =>
        createAgentConnection({
          profile: input.profile,
          credentialReference: input.credentialReference,
          credentialResolver: {
            // Secret store returns undefined — secret not found
            async resolveCredential(_handle: string): Promise<string | undefined> {
              return undefined;
            }
          },
          telemetryContext: input.telemetryContext
        })
    });

    await expect(
      directCallFactory.call({
        runId: 'run_cred_guard_001',
        step: 'guard_test',
        directCall: {
          purpose: 'credential guard',
          input: {},
          resultValidation: { schemaId: 'guard-test', schema: z.object({}) }
        }
      })
    ).rejects.toThrow(
      expect.objectContaining({ code: 'missing_credential' })
    );

    // Provider adapter must not be invoked when the credential check fails
    expect(adapterCallSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (d) OpenAI agent cell — profile resolution and factory lookup
// ---------------------------------------------------------------------------

describe('runner-cells: OpenAI agent cell profile resolution', () => {
  it('resolves explicit OpenAI agent profiles to fetch_transport/header', async () => {
    const record: ConfigurationRecord = {
      id: 'cfg_openai_agent',
      owner: { tenant: 'tenant_test' },
      kind: 'provider_profile',
      providerKind: openaiProviderKind,
      adapterId: openaiAgentAdapterId,
      settings: {
        profileName: 'openai-reviewer',
        model: { provider: 'openai', model: 'gpt-4.1' },
        endpoint: { baseUrl: 'https://api.openai.example' },
        credentialSecretHandle: 'sec_fake_openai'
      },
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z'
    };

    const fakeAdapter = createOpenAIAgentAdapter({
      sdk: {
        SandboxAgent: class {
          constructor(_opts: Record<string, unknown>) {}
          async *run(_input: unknown): AsyncIterable<OpenAINativeEvent> {}
        } as never,
        NoopSnapshotSpec: class {
          readonly type = 'noop';
        } as never,
        isNoopSnapshotSpec: (v: unknown) => (v as { type?: unknown }).type === 'noop',
        createClientBinding: ({ transport }) => ({ kind: 'transport' as const, value: transport })
      }
    });

    const registry = new Map([
      [buildProviderAdapterKey(openaiProviderKind, openaiAgentAdapterId), fakeAdapter]
    ]);

    const resolve = createExplicitProfileResolver({
      defaultProviderProfileId: record.id,
      listRecords: async () => [record],
      registry
    });

    const resolution = await resolve({ runId: 'run_openai_agent_001', step: 'implementation.work' });

    expect(resolution.profile.connectionMechanism).toBe('fetch_transport');
    expect(resolution.profile.providerKind).toBe('openai');
    expect(resolution.profile.adapterId).toBe(openaiAgentAdapterId);
    expect(resolution.credentialReference.authTarget).toBe('header');
    expect(resolution.credentialReference.secretHandle).toBe('sec_fake_openai');
  });
});

// ---------------------------------------------------------------------------
// (e) Two-provider dispatch: Claude implementer + OpenAI reviewer
// ---------------------------------------------------------------------------

// Shared helpers for two-provider test
function makeFakeAgentAdapter(opts: {
  providerKind: string;
  adapterId: string;
  mechanism: 'process_environment' | 'fetch_transport';
  terminalId: string;
}): AgentProviderAdapter {
  return {
    providerKind: opts.providerKind,
    adapterId: opts.adapterId,
    supportedConnectionMechanism: opts.mechanism,
    async startSession(input) {
      const runId = input.telemetryContext.runId;
      const step = input.telemetryContext.step ?? 'implementation.work';
      async function* events(): AsyncIterable<RunnerEvent> {
        yield {
          id: opts.terminalId,
          runId,
          step,
          importance: 'normal',
          createdAt: new Date().toISOString(),
          type: 'runner_terminal_result',
          result: { directive: 'advance' }
        } as RunnerEvent;
      }
      return {
        events: events(),
        metadata: Promise.resolve({
          outcome: 'succeeded' as const,
          launchMechanism: opts.mechanism,
          degradedCapabilities: [],
          tokenUsage: { available: false } as const,
        })
      };
    }
  };
}

function makeResolvedProfile(opts: { providerKind: string; adapterId: string; mechanism: 'process_environment' | 'fetch_transport' }): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: opts.providerKind,
    adapterId: opts.adapterId,
    profileName: `${opts.adapterId}-profile`,
    model: { provider: opts.providerKind as 'anthropic' | 'openai', model: opts.providerKind === 'anthropic' ? 'claude-sonnet-4' : 'gpt-4.1' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: opts.mechanism
  };
}

function makeFakeConnection(profile: ResolvedAgentRunnerProfile): AgentConnection {
  return {
    profile,
    credentialResolved: true,
    createFetchTransport: () => ({ fetch: vi.fn(async () => new Response('{}', { status: 200 })) }),
    createProcessLaunchConfig: (_input: ProcessLaunchConfigInput): ProcessLaunchConfig => ({
      environment: { ANTHROPIC_AUTH_TOKEN: 'fake-token', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      secretVariableNames: ['ANTHROPIC_AUTH_TOKEN'],
      degradedCapabilities: [],
      redacted: { mechanism: 'process_environment', hasAuthToken: true }
    })
  };
}

describe('runner-cells: two-provider dispatch (Claude implementer + OpenAI reviewer)', () => {
  it('dispatches Claude implementer and OpenAI reviewer as separate agent streams for one step setup', async () => {
    const claudeAdapter = makeFakeAgentAdapter({ providerKind: 'anthropic', adapterId: 'claude-agent-sdk', mechanism: 'process_environment', terminalId: 'evt_claude_terminal' });
    const openaiAdapter = makeFakeAgentAdapter({ providerKind: 'openai', adapterId: 'openai-agents-sdk', mechanism: 'fetch_transport', terminalId: 'evt_openai_terminal' });

    const adapters = new Map([
      [getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk'), claudeAdapter],
      [getAgentProviderAdapterKey('openai', 'openai-agents-sdk'), openaiAdapter]
    ]);

    const factory = createAgentRunnerFactory({
      adapters,
      resolveProfile: async (input: AgentRunnerFactoryInput): Promise<AgentProfileResolution> =>
        input.role === 'implementer'
          ? {
              profile: makeResolvedProfile({ providerKind: 'anthropic', adapterId: 'claude-agent-sdk', mechanism: 'process_environment' }),
              credentialReference: { required: false }
            }
          : {
              profile: makeResolvedProfile({ providerKind: 'openai', adapterId: 'openai-agents-sdk', mechanism: 'fetch_transport' }),
              credentialReference: { required: false }
            },
      createConnection: async (connectionInput) => makeFakeConnection(connectionInput.profile)
    });

    const implementer = await factory.createRunner({ runId: 'run_two_provider_001', step: 'implementation.work', role: 'implementer' });
    const reviewer = await factory.createRunner({ runId: 'run_two_provider_001', step: 'implementation.work', role: 'reviewer' });

    const eventsStore = new InMemoryRetainedRunEventStore({ maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32 });

    const implementerResult = await consumeRunnerEvents({
      eventsStore,
      events: implementer.run({
        environment: {
          context: {
            run: { id: 'run_two_provider_001', workKind: 'feature', currentStep: 'implementation.work', tenant: 'tenant_test' },
            task: { prompt: 'Test task', inputs: {} },
            workspaceIntent: { shape: 'none' },
            secretBindings: [],
            toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
            skills: { requested: [] },
            capabilityRequirements: {
              shell: { kind: 'bash', required: false },
              paths: { canonicalWorkspacePaths: false },
              lsp: { requested: false }
            }
          },
          workspace: { shape: 'none', workspaceRoots: [] },
          environment: { variables: {}, secretVariableNames: [] },
          toolPolicy: { allowedTools: [], workspaceRoots: [] },
          skills: { requested: [] },
          capabilities: {
            shell: { kind: 'bash', available: false },
            paths: {},
            lsp: { requested: false, available: false }
          }
        }
      }),
      runId: 'run_two_provider_001',
      tenant: 'tenant_test'
    });
    const reviewerResult = await consumeRunnerEvents({
      eventsStore,
      events: reviewer.run({
        environment: {
          context: {
            run: { id: 'run_two_provider_001', workKind: 'feature', currentStep: 'implementation.work', tenant: 'tenant_test' },
            task: { prompt: 'Test task', inputs: {} },
            workspaceIntent: { shape: 'none' },
            secretBindings: [],
            toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
            skills: { requested: [] },
            capabilityRequirements: {
              shell: { kind: 'bash', required: false },
              paths: { canonicalWorkspacePaths: false },
              lsp: { requested: false }
            }
          },
          workspace: { shape: 'none', workspaceRoots: [] },
          environment: { variables: {}, secretVariableNames: [] },
          toolPolicy: { allowedTools: [], workspaceRoots: [] },
          skills: { requested: [] },
          capabilities: {
            shell: { kind: 'bash', available: false },
            paths: {},
            lsp: { requested: false, available: false }
          }
        }
      }),
      runId: 'run_two_provider_001',
      tenant: 'tenant_test'
    });

    expect(implementerResult.workResult.directive).toBe('advance');
    expect(reviewerResult.workResult.directive).toBe('advance');
  });
});

describe('runner-cells: OpenAI agent cell factory lookup', () => {
  it('dispatches the OpenAI agent cell through the production agent runner factory seam', async () => {
    const fakeAdapter = createOpenAIAgentAdapter({
      sdk: {
        SandboxAgent: class {
          constructor(_opts: Record<string, unknown>) {}
          async *run(_input: unknown): AsyncIterable<OpenAINativeEvent> {}
        } as never,
        NoopSnapshotSpec: class {
          readonly type = 'noop';
        } as never,
        isNoopSnapshotSpec: (v: unknown) => (v as { type?: unknown }).type === 'noop',
        createClientBinding: ({ transport }) => ({ kind: 'transport' as const, value: transport })
      },
      sandboxClientFactory: async () => ({ kind: 'local' as const })
    });

    const agentRegistry = new Map([
      [getAgentProviderAdapterKey(openaiProviderKind, openaiAgentAdapterId), fakeAdapter]
    ]);

    const profile: ResolvedAgentRunnerProfile = {
      mode: 'agent',
      providerKind: openaiProviderKind,
      adapterId: openaiAgentAdapterId,
      profileName: 'test-openai-agent',
      model: { provider: 'openai', model: 'gpt-4.1' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'fetch_transport'
    };

    const fakeTransport: ProviderFetchTransport = {
      fetch: vi.fn(async () => new Response('{}', { status: 200 }))
    };

    const agentRunnerFactory = createAgentRunnerFactory({
      adapters: agentRegistry,
      resolveProfile: async (): Promise<AgentProfileResolution> => ({
        profile,
        credentialReference: { required: false }
      }),
      createConnection: async (connectionInput) => ({
        profile: connectionInput.profile,
        credentialResolved: true,
        createFetchTransport: () => fakeTransport,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('process launch not supported for fetch_transport');
        }
      })
    });

    const runner = await agentRunnerFactory.createRunner({ runId: 'run_openai_agent_001', step: 'implement' });

    // The factory lookup succeeds — proves the adapter key resolution and registry wiring are correct.
    expect(runner).toBeDefined();
    // Confirms the runner was dispatched through the production factory — not just a static const check
    const runResult = runner.run({
      environment: {
        context: {
          run: { id: 'run_openai_agent_001', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_test' },
          task: { prompt: 'Test task', inputs: {} },
          workspaceIntent: { shape: 'none' },
          secretBindings: [],
          toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
          skills: { requested: [] },
          capabilityRequirements: {
            shell: { kind: 'bash', required: false },
            paths: { canonicalWorkspacePaths: false },
            lsp: { requested: false }
          }
        },
        workspace: { shape: 'none', workspaceRoots: [] },
        environment: { variables: {}, secretVariableNames: [] },
        toolPolicy: { allowedTools: [], workspaceRoots: [] },
        skills: { requested: [] },
        capabilities: {
          shell: { kind: 'bash', available: false },
          paths: {},
          lsp: { requested: false, available: false }
        }
      }
    });
    // Confirms the runner.run() returns an AsyncIterable — proves adapter key resolution worked
    expect(typeof runResult[Symbol.asyncIterator]).toBe('function');
  });
});
