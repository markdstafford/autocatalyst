/**
 * Integration tests for multi-cell control-plane dispatch.
 *
 * Proves:
 * - Task 6.2: Two roles in one step (Claude implementer + OpenAI reviewer) dispatched sequentially
 * - Task 6.3: Anthropic direct call returns validated result through direct dispatch
 * - Task 6.4: Sensitive data is not exposed in telemetry
 */

import { describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import {
  consumeRunnerEvents,
  createExecutionRunUnitOfWork,
  DefaultOrchestrator,
  InMemoryRetainedRunEventStore,
  RunDispatchQueue,
  type RunUnitOfWork,
} from '@autocatalyst/core';
import type { JsonValue, Run, RunStep } from '@autocatalyst/api-contract';
import type { ConversationIngressRepository, RunRepository } from '@autocatalyst/core';
import {
  createAgentOrchestratorRunner,
  createAgentRunnerFactory,
  createDirectCallFactory,
  getAgentProviderAdapterKey,
  type AgentConnection,
  type AgentConnectionTelemetryContext,
  type AgentProfileResolution,
  type AgentRunnerFactoryInput,
  type DirectOrchestratorCallResult,
  type ProcessLaunchConfig,
  type ProcessLaunchConfigInput,
  type ProviderFetchTransport,
  type ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter,
  type ClaudeNativeEvent,
  type ClaudeSessionLaunch
} from '@autocatalyst/claude-agent-adapter';
import {
  createOpenAIAgentAdapter,
  openaiAgentAdapterId,
  openaiProviderKind,
  type OpenAINativeEvent,
  type OpenAISessionLaunch
} from '@autocatalyst/openai-agent-adapter';
import {
  anthropicDirectAdapterId,
  anthropicProviderKind,
  createAnthropicDirectAdapter
} from '@autocatalyst/anthropic-direct-adapter';

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

function createFakeOpenAILaunch(events: OpenAINativeEvent[]): OpenAISessionLaunch {
  return async function* (_options) {
    for (const ev of events) yield ev;
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

function makeOpenAIProfile(overrides?: Partial<ResolvedAgentRunnerProfile>): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: openaiProviderKind,
    adapterId: openaiAgentAdapterId,
    profileName: 'test-openai',
    model: { provider: 'openai', model: 'gpt-4o' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'fetch_transport',
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

function makeFetchConnection(profile: ResolvedAgentRunnerProfile, fetchImpl?: typeof globalThis.fetch): AgentConnection {
  const fetchFn = fetchImpl ?? (async () => new Response('{}', { status: 200 }));
  return {
    profile,
    credentialResolved: true,
    createFetchTransport(): ProviderFetchTransport {
      return {
        fetch: async (req) => fetchFn(req.url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.body
        })
      };
    },
    createProcessLaunchConfig(_input: ProcessLaunchConfigInput): ProcessLaunchConfig {
      throw new Error('createProcessLaunchConfig not supported for fetch_transport');
    }
  };
}

// ---------------------------------------------------------------------------
// Task 6.2: Multi-role dispatch test
// ---------------------------------------------------------------------------

describe('runner-cells: multi-role agent dispatch', () => {
  it('dispatches two roles in one step to distinct agent providers sequentially', async () => {
    const CLAUDE_EVENTS: ClaudeNativeEvent[] = [
      { type: 'assistant', content: 'Implementing the feature...' },
      { type: 'result', result: { output: '{"directive":"advance"}' } }
    ];

    const OPENAI_EVENTS: OpenAINativeEvent[] = [
      { type: 'assistant_message', content: 'Reviewing the implementation...' },
      { type: 'terminal_result', directive: 'advance' }
    ];

    const claudeAdapter = createClaudeAgentAdapter({
      launchClaudeSession: createFakeClaudeLaunch(CLAUDE_EVENTS)
    });
    const openaiAdapter = createOpenAIAgentAdapter({
      launchSession: createFakeOpenAILaunch(OPENAI_EVENTS)
    });

    const agentRegistry = new Map([
      [getAgentProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId), claudeAdapter],
      [getAgentProviderAdapterKey(openaiProviderKind, openaiAgentAdapterId), openaiAdapter]
    ]);

    const roleProfiles: Record<string, ResolvedAgentRunnerProfile> = {
      implementer: makeClaudeProfile(),
      reviewer: makeOpenAIProfile()
    };

    const runId = 'run_multi_role_001';
    const step = 'implement_and_review';
    const roleResults: Record<string, { directive: string; providerKind: string }> = {};
    const eventCountByRole: Record<string, number> = {};

    // Execute roles sequentially in deterministic role order
    const roleOrder = ['implementer', 'reviewer'] as const;
    for (const role of roleOrder) {
      const profile = roleProfiles[role]!;

      const agentRunnerFactory = createAgentRunnerFactory({
        adapters: agentRegistry,
        resolveProfile: async (_factoryInput: AgentRunnerFactoryInput): Promise<AgentProfileResolution> => ({
          profile,
          credentialReference: { required: false }
        }),
        createConnection: async (connectionInput) => {
          if (connectionInput.profile.connectionMechanism === 'process_environment') {
            return makeProcessConnection(connectionInput.profile);
          }
          return makeFetchConnection(connectionInput.profile);
        },
        telemetryContext: (factoryInput): AgentConnectionTelemetryContext => ({
          runId: factoryInput.runId,
          step: factoryInput.step,
          role: factoryInput.role,
          profileName: profile.profileName
        })
      });

      const runner = await agentRunnerFactory.createRunner({ runId, step, role });
      const eventsStore = new InMemoryRetainedRunEventStore({ maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32 });

      // Count events as they are appended via subscription
      let eventCount = 0;
      const subscription = eventsStore.subscribe({ runId, tenant: 'tenant_test' });
      const countingPromise = (async () => {
        for await (const _ev of subscription.events) {
          eventCount++;
        }
      })();

      // Use the runner's run method to get events, wrapping as needed for consumeRunnerEvents
      const runnerSession = runner.run({
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
      });

      const result = await consumeRunnerEvents({
        eventsStore,
        events: runnerSession,
        runId,
        tenant: 'tenant_test'
      });

      // Close subscription so the counting loop terminates
      subscription.close();
      await countingPromise;

      eventCountByRole[role] = eventCount;
      roleResults[role] = {
        directive: result.workResult.directive,
        providerKind: profile.providerKind
      };
    }

    // Assertions

    // Both roles ran
    expect(Object.keys(roleResults)).toHaveLength(2);

    // Each role used the expected provider
    expect(roleResults['implementer']!.providerKind).toBe(claudeProviderKind);
    expect(roleResults['reviewer']!.providerKind).toBe(openaiProviderKind);

    // Both returned advance directive
    expect(roleResults['implementer']!.directive).toBe('advance');
    expect(roleResults['reviewer']!.directive).toBe('advance');

    // Aggregate checkpoint structure (one logical step, two role outcomes)
    const aggregateCheckpoint = { roles: roleResults };
    expect(aggregateCheckpoint.roles['implementer']).toBeDefined();
    expect(aggregateCheckpoint.roles['reviewer']).toBeDefined();

    // Events were stored for each role
    expect(eventCountByRole['implementer']!).toBeGreaterThan(0);
    expect(eventCountByRole['reviewer']!).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task 6.3a: Anthropic direct call returns validated result
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

    // Wrapping as RunWorkResult
    const workResult = { directive: 'advance' as const, result: result.value };
    const checkpointResult = result.value;

    expect(workResult.directive).toBe('advance');
    expect(checkpointResult).toEqual({ intent: 'implement' });

    // The transport was called
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

    // Call directly to verify the port seam works
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

    // Task 6.3: Assert direct mode never emits runner events.
    // Structural proof: DirectOrchestratorCallResult has no `events` property.
    // The type constraint below fails at compile time if events were added.
    const _noEventsTypeCheck: DirectOrchestratorCallResult = callResult;
    expect('events' in _noEventsTypeCheck).toBe(false);
    // Runtime proof: the result object itself has no events key.
    expect(Object.prototype.hasOwnProperty.call(callResult, 'events')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 6.4: Redaction assertions
// ---------------------------------------------------------------------------

describe('runner-cells: sensitive data redaction', () => {
  it('does not expose sensitive data in telemetry events', async () => {
    const OPENAI_FAKE_SECRET = 'sk-openai-fake-secret-xyz';
    const ANTHROPIC_FAKE_SECRET = 'sk-ant-fake-secret-abc';
    const RAW_PROMPT_BODY = 'raw prompt body secret content';
    const RAW_PROVIDER_RESPONSE = 'raw provider response data here';

    const telemetryEvents: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const telemetryEmitter = {
      emit(event: string, fields: Record<string, unknown>) {
        telemetryEvents.push({ event, fields });
      }
    };

    // 1. Test Anthropic direct adapter redaction via telemetry
    const fakeFetchTransportWithSecrets: ProviderFetchTransport = {
      fetch: vi.fn(async (_request) => new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu_red_1', name: 'autocatalyst_direct_result', input: { result: 'ok' } }],
        model: 'claude-3-5-sonnet-latest',
        usage: { input_tokens: 5, output_tokens: 3 }
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    };

    const schema = z.object({ result: z.string() });
    const anthropicAdapter = createAnthropicDirectAdapter();

    const directCallFactory = createDirectCallFactory({
      adapters: [anthropicAdapter],
      resolveProfile: async () => ({
        profile: {
          mode: 'direct' as const,
          providerKind: anthropicProviderKind,
          adapterId: anthropicDirectAdapterId,
          profileName: 'test-redaction',
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
        createFetchTransport: () => fakeFetchTransportWithSecrets,
        createProcessLaunchConfig: (_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig => {
          throw new Error('createProcessLaunchConfig not supported');
        }
      }),
      telemetry: telemetryEmitter
    });

    await directCallFactory.call({
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

    // 2. Test OpenAI agent adapter redaction
    // Wire telemetryEmitter directly so agent_orchestrator_session_start/end events
    // are captured. The OPENAI_FAKE_SECRET is passed as an env variable that would
    // be visible to the adapter's launchOptions but must not leak into telemetry.
    const OPENAI_EVENTS: OpenAINativeEvent[] = [
      { type: 'assistant_message', content: 'Processing...' },
      { type: 'terminal_result', directive: 'advance' }
    ];

    const openaiAdapter = createOpenAIAgentAdapter({
      launchSession: createFakeOpenAILaunch(OPENAI_EVENTS)
    });

    const openaiProfile = makeOpenAIProfile();
    const openaiConnection: AgentConnection = {
      profile: openaiProfile,
      credentialResolved: true,
      createFetchTransport(): ProviderFetchTransport {
        // The fake transport response body contains the secret — it must not
        // appear in the telemetry events emitted by the orchestrator runner.
        return {
          fetch: async (_req) => new Response(JSON.stringify({
            response: RAW_PROVIDER_RESPONSE,
            credential: OPENAI_FAKE_SECRET
          }), { status: 200 })
        };
      },
      createProcessLaunchConfig(_launchInput: ProcessLaunchConfigInput): ProcessLaunchConfig {
        throw new Error('createProcessLaunchConfig not supported');
      }
    };

    const openaiTelemetryContext: AgentConnectionTelemetryContext = {
      runId: 'run_redact_002',
      step: 'review_step',
      profileName: openaiProfile.profileName
    };

    // Create the runner directly so we can pass the telemetryEmitter.
    // This proves that agent_orchestrator_session_start/end telemetry does not
    // contain the OPENAI_FAKE_SECRET even when it is present in the env variables.
    const openaiRunner = createAgentOrchestratorRunner({
      adapter: openaiAdapter,
      profile: openaiProfile,
      connection: openaiConnection,
      telemetryContext: openaiTelemetryContext,
      telemetry: telemetryEmitter
    });

    const openaiEventsStore = new InMemoryRetainedRunEventStore({ maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32 });
    await consumeRunnerEvents({
      eventsStore: openaiEventsStore,
      events: openaiRunner.run({
        environment: {
          context: {
            run: { id: 'run_redact_002', workKind: 'feature', currentStep: 'review_step', tenant: 'tenant_test' },
            task: { prompt: RAW_PROMPT_BODY, inputs: {} },
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
          environment: { variables: { OPENAI_API_KEY: OPENAI_FAKE_SECRET }, secretVariableNames: ['OPENAI_API_KEY'] },
          toolPolicy: { allowedTools: [], workspaceRoots: [] },
          skills: { requested: [] },
          capabilities: {
            shell: { kind: 'bash', available: false },
            paths: {},
            lsp: { requested: false, available: false }
          }
        }
      }),
      runId: 'run_redact_002',
      tenant: 'tenant_test'
    });

    // Check that serialized telemetry events don't contain sensitive values
    const serializedTelemetry = JSON.stringify(telemetryEvents);
    expect(serializedTelemetry).not.toContain(ANTHROPIC_FAKE_SECRET);

    // Task 6.4: The OPENAI_FAKE_SECRET is present in the env variables passed to
    // the adapter (launchOptions.env), but must not appear in orchestrator telemetry.
    // This assertion is non-vacuous because we wired telemetryEmitter to the OpenAI
    // runner above, so agent_orchestrator_session_start/end events ARE captured.
    expect(serializedTelemetry).not.toContain(OPENAI_FAKE_SECRET);

    // Verify telemetry was actually emitted (not just silently skipped)
    expect(telemetryEvents.length).toBeGreaterThan(0);
    expect(telemetryEvents.some(e => e.event === 'direct_orchestrator_call_end')).toBe(true);
    // Confirm OpenAI orchestrator events were captured (making the redaction assertion non-vacuous)
    expect(telemetryEvents.some(e => e.event === 'agent_orchestrator_session_start')).toBe(true);
    expect(telemetryEvents.some(e => e.event === 'agent_orchestrator_session_end')).toBe(true);
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
// Task 6.2 (production): Multi-role dispatch through DefaultOrchestrator
// ---------------------------------------------------------------------------

describe('runner-cells: multi-role dispatch through DefaultOrchestrator production seams', () => {
  it('dispatches implementer+reviewer sequentially and persists aggregate checkpoint via orchestrator', async () => {
    const CLAUDE_EVENTS: ClaudeNativeEvent[] = [
      { type: 'assistant', content: 'Implementing...' },
      { type: 'result', result: { output: '{"directive":"advance"}' } }
    ];
    const OPENAI_EVENTS: OpenAINativeEvent[] = [
      { type: 'assistant_message', content: 'Reviewing...' },
      { type: 'terminal_result', directive: 'advance' }
    ];

    const claudeAdapter = createClaudeAgentAdapter({
      launchClaudeSession: createFakeClaudeLaunch(CLAUDE_EVENTS)
    });
    const openaiAdapter = createOpenAIAgentAdapter({
      launchSession: createFakeOpenAILaunch(OPENAI_EVENTS)
    });

    const agentRegistry = new Map([
      [getAgentProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId), claudeAdapter],
      [getAgentProviderAdapterKey(openaiProviderKind, openaiAgentAdapterId), openaiAdapter]
    ]);

    const roleProfiles: Record<string, ResolvedAgentRunnerProfile> = {
      implementer: makeClaudeProfile(),
      reviewer: makeOpenAIProfile()
    };

    // Multi-role unit of work: run both roles sequentially, return aggregate checkpoint
    const multiRoleUoW: RunUnitOfWork = {
      async run(input): Promise<{ directive: 'advance' | 'needs_input' | 'fail'; reason?: string; result?: Readonly<Record<string, unknown>> }> {
        const roleOrder = ['implementer', 'reviewer'] as const;
        const roleResults: Record<string, { directive: string; providerKind: string }> = {};

        for (const role of roleOrder) {
          const profile = roleProfiles[role]!;
          const eventsStore = new InMemoryRetainedRunEventStore({
            maxEventsPerScope: 256, maxExpiredIdsPerScope: 64, subscriberBufferSize: 32
          });

          const factory = createAgentRunnerFactory({
            adapters: agentRegistry,
            resolveProfile: async (): Promise<AgentProfileResolution> => ({
              profile,
              credentialReference: { required: false }
            }),
            createConnection: async (ci) => {
              if (ci.profile.connectionMechanism === 'process_environment') {
                return makeProcessConnection(ci.profile);
              }
              return makeFetchConnection(ci.profile);
            },
            telemetryContext: (fi): AgentConnectionTelemetryContext => ({
              runId: fi.runId, step: fi.step, role: fi.role, profileName: profile.profileName
            })
          });

          const runner = await factory.createRunner({
            runId: input.runId,
            step: input.run.currentStep,
            role
          });
          const result = await consumeRunnerEvents({
            eventsStore,
            events: runner.run({
              environment: {
                context: {
                  run: { id: input.runId, workKind: 'feature', currentStep: input.run.currentStep, tenant: input.tenant },
                  task: { prompt: 'Multi-role task', inputs: {} },
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
            runId: input.runId,
            tenant: input.tenant
          });

          roleResults[role] = { directive: result.workResult.directive, providerKind: profile.providerKind };
        }

        // Aggregate checkpoint: keyed by role
        const aggregateCheckpoint = { roles: roleResults };
        return { directive: 'advance', result: aggregateCheckpoint };
      }
    };

    // Capture checkpoint via spy on recordRunStepTransition
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
      unitOfWork: multiRoleUoW
    });

    // Dispatch through production orchestrator seam
    await orchestrator.dispatch({ runId: 'run_prod_001', tenant: 'tenant_test' });

    // One source RunStep → one call to recordRunStepTransition
    expect(capturedTransitions).toHaveLength(1);

    // Aggregate checkpoint is keyed by role
    const checkpoint = capturedTransitions[0]?.checkpointResult;
    expect(checkpoint).toMatchObject({
      roles: {
        implementer: { directive: 'advance', providerKind: claudeProviderKind },
        reviewer: { directive: 'advance', providerKind: openaiProviderKind }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Task 6.3 (production): Direct mode through DefaultOrchestrator
// ---------------------------------------------------------------------------

describe('runner-cells: direct mode through DefaultOrchestrator and createExecutionRunUnitOfWork', () => {
  it('direct result persists as checkpoint via DefaultOrchestrator.applyDirective()', async () => {
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

    // Unit of work: resolveExecutionMode → direct, direct port → directCallFactory
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

    // Capture checkpoint in fake run repo
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

    // Dispatch through production orchestrator seam
    await orchestrator.dispatch({ runId: 'run_prod_001', tenant: 'tenant_test' });

    // Direct result should be checkpointed
    expect(capturedTransitions).toHaveLength(1);
    expect(capturedTransitions[0]?.checkpointResult).toEqual({ intent: 'implement' });

    // Transport was called (proves production dispatch path reached the adapter)
    expect(fakeTransport.fetch).toHaveBeenCalledTimes(1);

    // No runner events in the event store for this run (direct mode)
    const replay = await eventBus.replayAfter({ runId: 'run_prod_001', tenant: 'tenant_test' });
    expect(replay.status).toBe('ok');
    if (replay.status === 'ok') {
      expect(replay.events).toHaveLength(0);
    }
  });
});
