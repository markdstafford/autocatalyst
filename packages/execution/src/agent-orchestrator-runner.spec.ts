import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  RunnerAssistantTurnEvent,
  RunnerToolActivityEvent,
  RunnerTerminalResultEvent,
  RunnerEvent
} from '@autocatalyst/api-contract';

import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionMetadata,
  ResolvedAgentRunnerProfile,
  AgentConnection,
  AgentConnectionTelemetryContext
} from './agent-provider-adapter.js';
import {
  ProviderConfigurationError,
  ProviderConnectionError
} from './agent-provider-adapter.js';
import type { RunnerRunInput } from './runner.js';
import { createAgentOrchestratorRunner } from './agent-orchestrator-runner.js';
import type { CreateAgentOrchestratorRunnerOptions } from './agent-orchestrator-runner.js';
import { createExecutionEntryPoint } from './execution-entry-point.js';
import type { ExecutionContext } from '@autocatalyst/api-contract';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';

// ---------------------------------------------------------------------------
// Test event factories
// ---------------------------------------------------------------------------

function makeAssistantTurnEvent(runId: string): RunnerAssistantTurnEvent {
  return {
    id: `evt_assistant_${Math.random().toString(36).slice(2)}`,
    type: 'runner_assistant_turn',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    message: { role: 'assistant', content: 'Hello from the agent.' }
  };
}

function makeToolActivityEvent(runId: string): RunnerToolActivityEvent {
  return {
    id: `evt_tool_${Math.random().toString(36).slice(2)}`,
    type: 'runner_tool_activity',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    tool: { name: 'bash', action: 'run', status: 'success' }
  };
}

function makeTerminalEvent(runId: string): RunnerTerminalResultEvent {
  return {
    id: `evt_terminal_${Math.random().toString(36).slice(2)}`,
    type: 'runner_terminal_result',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    result: { directive: 'advance' }
  };
}

// ---------------------------------------------------------------------------
// Fake adapter builder
// ---------------------------------------------------------------------------

interface FakeAdapterOptions {
  providerKind?: string;
  adapterId?: string;
  supportedConnectionMechanism?: 'process_environment' | 'fetch_transport';
  events?: RunnerEvent[];
  sessionMetadata?: Partial<AgentProviderSessionMetadata>;
  startSessionError?: Error;
  streamError?: Error;
  closeError?: Error;
  sessionCloseError?: Error;
}

function makeDefaultMetadata(overrides: Partial<AgentProviderSessionMetadata> = {}): AgentProviderSessionMetadata {
  return {
    outcome: 'succeeded',
    launchMechanism: 'process_environment',
    degradedCapabilities: [],
    tokenUsage: { available: false },
    ...overrides
  };
}

function makeFakeAdapter(options: FakeAdapterOptions = {}): {
  adapter: AgentProviderAdapter;
  sessionCloseMock: ReturnType<typeof vi.fn>;
  adapterCloseMock: ReturnType<typeof vi.fn>;
} {
  const {
    providerKind = 'test',
    adapterId = 'test-adapter',
    supportedConnectionMechanism = 'process_environment',
    events = [],
    sessionMetadata,
    startSessionError,
    streamError,
    closeError,
    sessionCloseError
  } = options;

  const sessionCloseMock = sessionCloseError
    ? vi.fn().mockRejectedValue(sessionCloseError)
    : vi.fn().mockResolvedValue(undefined);

  const adapterCloseMock = closeError
    ? vi.fn().mockRejectedValue(closeError)
    : vi.fn().mockResolvedValue(undefined);

  const adapter: AgentProviderAdapter = {
    providerKind,
    adapterId,
    supportedConnectionMechanism,
    startSession(_input) {
      if (startSessionError !== undefined) {
        throw startSessionError;
      }
      const eventsToEmit = [...events];
      const err = streamError;
      const session: AgentProviderSession = {
        events: (async function* () {
          for (const event of eventsToEmit) {
            yield event;
          }
          if (err !== undefined) {
            throw err;
          }
        })(),
        metadata: Promise.resolve(makeDefaultMetadata(sessionMetadata)),
        close: sessionCloseMock
      };
      return session;
    },
    close: adapterCloseMock
  };

  return { adapter, sessionCloseMock, adapterCloseMock };
}

// ---------------------------------------------------------------------------
// Profile and connection helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<ResolvedAgentRunnerProfile> = {}): ResolvedAgentRunnerProfile {
  return {
    providerKind: 'test',
    adapterId: 'test-adapter',
    profileName: 'default',
    model: { provider: 'test', model: 'test-model' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'process_environment',
    ...overrides
  };
}

function makeTelemetryContext(overrides: Partial<AgentConnectionTelemetryContext> = {}): AgentConnectionTelemetryContext {
  return {
    runId: 'run_test_1',
    phase: 'execute',
    step: 'implement',
    ...overrides
  };
}

function makeConnection(profile: ResolvedAgentRunnerProfile): AgentConnection {
  return {
    profile,
    credentialResolved: true,
    createFetchTransport() {
      return {
        fetch: vi.fn().mockResolvedValue(new Response())
      };
    },
    createProcessLaunchConfig(_input) {
      return {
        environment: {},
        secretVariableNames: [],
        degradedCapabilities: [],
        redacted: {}
      };
    }
  };
}

function makeRunInput(): RunnerRunInput {
  const context: ExecutionContext = {
    run: { id: 'run_test_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
    task: { prompt: 'Test task', inputs: {} },
    workspaceIntent: { shape: 'none' },
    secretBindings: [],
    toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
    skills: { requested: [] },
    capabilityRequirements: {
      shell: { kind: 'bash', required: false },
      paths: { canonicalWorkspacePaths: false },
      lsp: { requested: false }
    }
  };
  const environment: MaterializedExecutionEnvironment = {
    context,
    workspace: { shape: 'none', workspaceRoots: [] },
    environment: { variables: {}, secretVariableNames: [] },
    toolPolicy: { allowedTools: ['bash'], workspaceRoots: [] },
    skills: { requested: [] },
    capabilities: {
      shell: { kind: 'bash', available: false },
      paths: {},
      lsp: { requested: false, available: false }
    }
  };
  return { environment };
}

function makeOrchestratorOptions(
  adapterOverrides: FakeAdapterOptions = {},
  profileOverrides: Partial<ResolvedAgentRunnerProfile> = {}
): {
  options: CreateAgentOrchestratorRunnerOptions;
  sessionCloseMock: ReturnType<typeof vi.fn>;
  adapterCloseMock: ReturnType<typeof vi.fn>;
} {
  const profile = makeProfile(profileOverrides);
  const { adapter, sessionCloseMock, adapterCloseMock } = makeFakeAdapter(adapterOverrides);
  const telemetryEmitter = { emit: vi.fn() };
  const options: CreateAgentOrchestratorRunnerOptions = {
    adapter,
    profile,
    connection: makeConnection(profile),
    telemetryContext: makeTelemetryContext(),
    telemetry: telemetryEmitter,
    clock: () => 1000
  };
  return { options, sessionCloseMock, adapterCloseMock };
}

async function collectEvents(runner: ReturnType<typeof createAgentOrchestratorRunner>, input: RunnerRunInput): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const event of runner.run(input)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAgentOrchestratorRunner', () => {
  describe('success path', () => {
    it('yields all events from adapter in order', async () => {
      const runId = 'run_test_1';
      const assistantEvent = makeAssistantTurnEvent(runId);
      const toolEvent = makeToolActivityEvent(runId);
      const terminalEvent = makeTerminalEvent(runId);

      const { options } = makeOrchestratorOptions({ events: [assistantEvent, toolEvent, terminalEvent] });
      const runner = createAgentOrchestratorRunner(options);
      const collected = await collectEvents(runner, makeRunInput());

      expect(collected).toHaveLength(3);
      expect(collected[0]).toMatchObject({ type: 'runner_assistant_turn' });
      expect(collected[1]).toMatchObject({ type: 'runner_tool_activity' });
      expect(collected[2]).toMatchObject({ type: 'runner_terminal_result', result: { directive: 'advance' } });
    });
  });

  describe('pre-flight validation', () => {
    it('throws ProviderConfigurationError(mechanism_mismatch) when providerKind does not match', async () => {
      const { options } = makeOrchestratorOptions(
        { providerKind: 'anthropic' }, // adapter.providerKind
        { providerKind: 'openai' }     // profile.providerKind
      );
      const runner = createAgentOrchestratorRunner(options);
      await expect(collectEvents(runner, makeRunInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(collectEvents(runner, makeRunInput())).rejects.toMatchObject({ code: 'mechanism_mismatch' });
    });

    it('throws ProviderConfigurationError(mechanism_mismatch) when connectionMechanism does not match', async () => {
      const { options } = makeOrchestratorOptions(
        { supportedConnectionMechanism: 'fetch_transport' },
        { connectionMechanism: 'process_environment' }
      );
      const runner = createAgentOrchestratorRunner(options);
      await expect(collectEvents(runner, makeRunInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(collectEvents(runner, makeRunInput())).rejects.toMatchObject({ code: 'mechanism_mismatch' });
    });

    it('does not call startSession when pre-flight validation fails', async () => {
      const { options, sessionCloseMock } = makeOrchestratorOptions(
        { providerKind: 'mismatch' },
        { providerKind: 'other' }
      );
      const startSessionSpy = vi.spyOn(options.adapter, 'startSession');
      const runner = createAgentOrchestratorRunner(options);

      try {
        await collectEvents(runner, makeRunInput());
      } catch {
        // expected
      }

      expect(startSessionSpy).not.toHaveBeenCalled();
      expect(sessionCloseMock).not.toHaveBeenCalled();
    });
  });

  describe('event validation', () => {
    it('throws RunnerProtocolError(invalid_event) when adapter emits a malformed event', async () => {
      const runId = 'run_test_1';
      const badEvent = { id: 'evt_bad', type: 'runner_assistant_turn', runId /* missing fields */ } as unknown as RunnerEvent;
      const { options } = makeOrchestratorOptions({ events: [badEvent] });
      const runner = createAgentOrchestratorRunner(options);

      await expect(collectEvents(runner, makeRunInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'invalid_event'
      });
    });

    it('throws RunnerProtocolError(duplicate_terminal_result) when terminal is emitted twice', async () => {
      const runId = 'run_test_1';
      const t1 = makeTerminalEvent(runId);
      const t2 = makeTerminalEvent(runId);
      const { options } = makeOrchestratorOptions({ events: [t1, t2] });
      const runner = createAgentOrchestratorRunner(options);

      await expect(collectEvents(runner, makeRunInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'duplicate_terminal_result'
      });
    });

    it('throws RunnerProtocolError(event_after_terminal) when an event is emitted after the terminal', async () => {
      const runId = 'run_test_1';
      const terminalEvent = makeTerminalEvent(runId);
      const afterTerminal = makeAssistantTurnEvent(runId);
      const { options } = makeOrchestratorOptions({ events: [terminalEvent, afterTerminal] });
      const runner = createAgentOrchestratorRunner(options);

      await expect(collectEvents(runner, makeRunInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'event_after_terminal'
      });
    });

    it('throws RunnerProtocolError(missing_terminal_result) when stream ends without terminal', async () => {
      const runId = 'run_test_1';
      const { options } = makeOrchestratorOptions({ events: [makeAssistantTurnEvent(runId)] });
      const runner = createAgentOrchestratorRunner(options);

      await expect(collectEvents(runner, makeRunInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'missing_terminal_result'
      });
    });
  });

  describe('adapter errors', () => {
    it('propagates error when startSession throws', async () => {
      const startError = new Error('Failed to connect');
      const { options } = makeOrchestratorOptions({ startSessionError: startError });
      const runner = createAgentOrchestratorRunner(options);

      await expect(collectEvents(runner, makeRunInput())).rejects.toThrow();
    });

    it('propagates error thrown mid-stream by adapter events generator', async () => {
      const runId = 'run_test_1';
      const streamError = new Error('Stream died');
      const { options } = makeOrchestratorOptions({
        events: [makeAssistantTurnEvent(runId)],
        streamError
      });
      const runner = createAgentOrchestratorRunner(options);

      await expect(collectEvents(runner, makeRunInput())).rejects.toThrow('Stream died');
    });
  });

  describe('close semantics', () => {
    it('calls session.close() and adapter.close() after successful stream', async () => {
      const runId = 'run_test_1';
      const { options, sessionCloseMock, adapterCloseMock } = makeOrchestratorOptions({
        events: [makeTerminalEvent(runId)]
      });
      const runner = createAgentOrchestratorRunner(options);
      await collectEvents(runner, makeRunInput());
      await runner.close();

      expect(sessionCloseMock).toHaveBeenCalledTimes(1);
      expect(adapterCloseMock).toHaveBeenCalledTimes(1);
    });

    it('calls session.close() and adapter.close() even when stream errors', async () => {
      const runId = 'run_test_1';
      const { options, sessionCloseMock, adapterCloseMock } = makeOrchestratorOptions({
        events: [makeAssistantTurnEvent(runId)],
        streamError: new Error('Stream error')
      });
      const runner = createAgentOrchestratorRunner(options);

      try {
        await collectEvents(runner, makeRunInput());
      } catch {
        // expected
      }
      await runner.close();

      expect(sessionCloseMock).toHaveBeenCalledTimes(1);
      expect(adapterCloseMock).toHaveBeenCalledTimes(1);
    });

    it('handles adapter.close() throwing without masking the original error', async () => {
      const runId = 'run_test_1';
      const closeError = new Error('Close failed');
      const { options } = makeOrchestratorOptions({
        events: [makeAssistantTurnEvent(runId)],
        streamError: new Error('Stream error'),
        closeError
      });
      const runner = createAgentOrchestratorRunner(options);

      // The stream error should propagate, not the close error
      await expect(collectEvents(runner, makeRunInput())).rejects.toThrow('Stream error');
    });

    it('returns { status: closed } from runner.close()', async () => {
      const runId = 'run_test_1';
      const { options } = makeOrchestratorOptions({ events: [makeTerminalEvent(runId)] });
      const runner = createAgentOrchestratorRunner(options);
      await collectEvents(runner, makeRunInput());
      const result = await runner.close();
      expect(result).toEqual({ status: 'closed' });
    });

    it('calls adapter.close() even when startSession throws', async () => {
      const startError = new Error('Failed to connect');
      const adapterCloseMock = vi.fn().mockResolvedValue(undefined);
      const profile = makeProfile();
      const adapter: AgentProviderAdapter = {
        providerKind: 'test',
        adapterId: 'test-adapter',
        supportedConnectionMechanism: 'process_environment',
        startSession() {
          throw startError;
        },
        close: adapterCloseMock
      };
      const options: CreateAgentOrchestratorRunnerOptions = {
        adapter,
        profile,
        connection: makeConnection(profile),
        telemetryContext: makeTelemetryContext(),
        clock: () => 1000
      };
      const runner = createAgentOrchestratorRunner(options);

      try {
        await collectEvents(runner, makeRunInput());
      } catch {
        // expected — startSession throws
      }

      await runner.close();
      expect(adapterCloseMock).toHaveBeenCalledTimes(1);
    });

    it('does not throw when close() is called after generator abandonment', async () => {
      const runId = 'run_test_1';
      const { options } = makeOrchestratorOptions({
        events: [makeAssistantTurnEvent(runId), makeTerminalEvent(runId)]
      });
      const runner = createAgentOrchestratorRunner(options);

      // Abandon the generator after the first event
      for await (const _event of runner.run(makeRunInput())) {
        break;
      }

      await expect(runner.close()).resolves.toEqual({ status: 'closed' });
    });
  });

  describe('telemetry end event fields', () => {
    it('emits durationMs, outcome, and degradedCapabilities in session_end', async () => {
      const runId = 'run_test_1';
      const emitMock = vi.fn();
      const profile = makeProfile();
      const { adapter } = makeFakeAdapter({
        events: [makeAssistantTurnEvent(runId), makeTerminalEvent(runId)]
      });

      let clockValue = 1000;
      const options: CreateAgentOrchestratorRunnerOptions = {
        adapter,
        profile,
        connection: makeConnection(profile),
        telemetryContext: makeTelemetryContext(),
        telemetry: { emit: emitMock },
        clock: () => {
          clockValue += 50;
          return clockValue;
        }
      };
      const runner = createAgentOrchestratorRunner(options);
      await collectEvents(runner, makeRunInput());

      const sessionEndCall = emitMock.mock.calls.find(
        ([event]) => event === 'agent_orchestrator_session_end'
      );
      expect(sessionEndCall).toBeDefined();
      const fields = sessionEndCall![1] as Record<string, unknown>;

      expect(typeof fields['durationMs']).toBe('number');
      expect((fields['durationMs'] as number) >= 0).toBe(true);
      expect(fields['outcome']).toBe('succeeded');
      expect(Array.isArray(fields['degradedCapabilities'])).toBe(true);
    });
  });

  describe('provider error safety', () => {
    it('re-throws ProviderConnectionError as a typed error (not a raw string dump)', async () => {
      const runId = 'run_test_1';
      const providerError = new ProviderConnectionError('timeout', 'raw unsafe message with credentials: secret123');
      const { options } = makeOrchestratorOptions({
        events: [makeAssistantTurnEvent(runId)],
        streamError: providerError
      });
      const runner = createAgentOrchestratorRunner(options);

      let caught: unknown;
      try {
        await collectEvents(runner, makeRunInput());
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught).toBeInstanceOf(ProviderConnectionError);
      expect((caught as ProviderConnectionError).code).toBe('timeout');
    });
  });

  describe('counters', () => {
    it('counts assistant turns and tool calls correctly via telemetry', async () => {
      const runId = 'run_test_1';
      const emitMock = vi.fn();
      const profile = makeProfile();
      const { adapter } = makeFakeAdapter({
        events: [
          makeAssistantTurnEvent(runId),
          makeAssistantTurnEvent(runId),
          makeToolActivityEvent(runId),
          makeTerminalEvent(runId)
        ]
      });
      const options: CreateAgentOrchestratorRunnerOptions = {
        adapter,
        profile,
        connection: makeConnection(profile),
        telemetryContext: makeTelemetryContext(),
        telemetry: { emit: emitMock },
        clock: () => 1000
      };
      const runner = createAgentOrchestratorRunner(options);
      await collectEvents(runner, makeRunInput());

      // session end telemetry should contain the counts
      const sessionEndCall = emitMock.mock.calls.find(
        ([event]) => event === 'agent_orchestrator_session_end' || event === 'session_end'
      );
      expect(sessionEndCall).toBeDefined();
      const fields = sessionEndCall![1] as Record<string, unknown>;
      expect(fields['assistantTurnCount']).toBe(2);
      expect(fields['toolCallCount']).toBe(1);
    });
  });

  describe('token usage telemetry', () => {
    it('emits token usage when session metadata has available: true', async () => {
      const runId = 'run_test_1';
      const emitMock = vi.fn();
      const profile = makeProfile();
      const { adapter } = makeFakeAdapter({
        events: [makeTerminalEvent(runId)],
        sessionMetadata: {
          tokenUsage: {
            available: true,
            tokens: { inputTokens: 100, outputTokens: 50 }
          }
        }
      });
      const options: CreateAgentOrchestratorRunnerOptions = {
        adapter,
        profile,
        connection: makeConnection(profile),
        telemetryContext: makeTelemetryContext(),
        telemetry: { emit: emitMock },
        clock: () => 1000
      };
      const runner = createAgentOrchestratorRunner(options);
      await collectEvents(runner, makeRunInput());

      const sessionEndCall = emitMock.mock.calls.find(
        ([event]) => event === 'agent_orchestrator_session_end' || event === 'session_end'
      );
      expect(sessionEndCall).toBeDefined();
      const fields = sessionEndCall![1] as Record<string, unknown>;
      const tokenUsage = fields['tokenUsage'] as Record<string, unknown>;
      expect(tokenUsage).toBeDefined();
      expect(tokenUsage['available']).toBe(true);
    });

    it('emits usageAvailable: false when session metadata has available: false', async () => {
      const runId = 'run_test_1';
      const emitMock = vi.fn();
      const profile = makeProfile();
      const { adapter } = makeFakeAdapter({
        events: [makeTerminalEvent(runId)],
        sessionMetadata: { tokenUsage: { available: false } }
      });
      const options: CreateAgentOrchestratorRunnerOptions = {
        adapter,
        profile,
        connection: makeConnection(profile),
        telemetryContext: makeTelemetryContext(),
        telemetry: { emit: emitMock },
        clock: () => 1000
      };
      const runner = createAgentOrchestratorRunner(options);
      await collectEvents(runner, makeRunInput());

      const sessionEndCall = emitMock.mock.calls.find(
        ([event]) => event === 'agent_orchestrator_session_end' || event === 'session_end'
      );
      expect(sessionEndCall).toBeDefined();
      const fields = sessionEndCall![1] as Record<string, unknown>;
      const tokenUsage = fields['tokenUsage'] as Record<string, unknown>;
      expect(tokenUsage['available']).toBe(false);
    });
  });

  describe('entry-point result validation handoff', () => {
    it('entry-point calls runner.close() and runs validation after orchestrator yields terminal', async () => {
      const runId = 'run_test_1';
      const profile = makeProfile();
      const { adapter } = makeFakeAdapter({ events: [makeTerminalEvent(runId)] });
      const options: CreateAgentOrchestratorRunnerOptions = {
        adapter,
        profile,
        connection: makeConnection(profile),
        telemetryContext: makeTelemetryContext(),
        clock: () => 1000
      };
      const runner = createAgentOrchestratorRunner(options);

      // Use a scratch_file config with a non-existent file to trigger validation failure
      const context: ExecutionContext = {
        run: { id: runId, workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
        task: { prompt: 'Test task', inputs: {} },
        workspaceIntent: { shape: 'none' },
        secretBindings: [],
        toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
        skills: { requested: [] },
        capabilityRequirements: {
          shell: { kind: 'bash', required: false },
          paths: { canonicalWorkspacePaths: false },
          lsp: { requested: false }
        }
      };
      const environment: MaterializedExecutionEnvironment = {
        context,
        workspace: { shape: 'none', workspaceRoots: [] },
        environment: { variables: {}, secretVariableNames: [] },
        toolPolicy: { allowedTools: ['bash'], workspaceRoots: [] },
        skills: { requested: [] },
        capabilities: {
          shell: { kind: 'bash', available: false },
          paths: {},
          lsp: { requested: false, available: false }
        }
      };
      const materialize = vi.fn().mockResolvedValue(environment);

      const entryPoint = createExecutionEntryPoint({
        runner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          schema: z.object({ value: z.string() }),
          schemaId: 'test_result',
          step: 'implement',
          resultFile: '/nonexistent/path/result.json'
        }
      });

      const collected = [];
      for await (const event of entryPoint.execute({ context })) {
        collected.push(event);
      }

      // Should yield one terminal result from the entry point (validation failure, not raw terminal)
      expect(collected).toHaveLength(1);
      expect(collected[0]).toMatchObject({ type: 'runner_terminal_result' });
      // The result should be a fail since file doesn't exist
      expect((collected[0] as RunnerTerminalResultEvent).result.directive).toBe('fail');
    });
  });
});
