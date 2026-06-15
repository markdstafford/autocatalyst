import { describe, expect, it, vi } from 'vitest';

import type { ExecutionContext } from '@autocatalyst/api-contract';
import type { ExecutionBoundaryEvent, ExecutionEntryPoint, ExecutionEntryPointInput, DirectCallRequest } from '@autocatalyst/execution';
import { createExecutionEntryPoint, ClassifiedProviderFailureError, ExecutionMaterializationError, SkillCatalogResolutionError, ProviderConnectionError, ProviderConfigurationError } from '@autocatalyst/execution';
import type { Runner, RunnerRunInput } from '@autocatalyst/execution';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';
import type { RunWorkInput } from './orchestrator.js';
import { createExecutionRunUnitOfWork } from './execution-run-unit-of-work.js';
import type { DirectStepExecutionPort } from './execution-run-unit-of-work.js';
import { InMemoryRetainedRunEventStore } from './run-events.js';

const runId = 'run_1';
const tenant = 'tenant_1';

function makeInput(overrides: Partial<RunWorkInput> = {}): RunWorkInput {
  return {
    runId,
    run: {
      id: runId,
      topicId: 'topic_1',
      owner: { id: 'user_1', kind: 'human', tenantId: tenant },
      tenant,
      workKind: 'feature',
      currentStep: 'implement',
      terminal: false,
      createdAt: '2026-06-09T00:00:00.000Z',
      updatedAt: '2026-06-09T00:00:00.000Z'
    } as RunWorkInput['run'],
    tenant,
    ...overrides
  };
}

function makeContext(): ExecutionContext {
  return {
    run: { id: runId, workKind: 'feature', currentStep: 'implement', tenant },
    task: { prompt: 'Implement feature', inputs: {} },
    workspaceIntent: { shape: 'none' },
    secretBindings: [],
    toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
    skills: { requested: [], resolved: [] },
    capabilityRequirements: {
      shell: { kind: 'bash', required: false },
      paths: { canonicalWorkspacePaths: true },
      lsp: { requested: true }
    }
  } as ExecutionContext;
}

function makeTerminalEvent(directive: 'advance' | 'needs_input' | 'fail', overrides: Record<string, unknown> = {}): ExecutionBoundaryEvent {
  const result: Record<string, unknown> = { directive };
  if (directive === 'needs_input') result['question'] = 'What color?';
  if (directive === 'fail') result['reason'] = 'Something went wrong.';

  return {
    id: 'evt_terminal',
    type: 'runner_terminal_result',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    result: { ...result, ...overrides }
  } as ExecutionBoundaryEvent;
}

function makeProgressEvent(id = 'evt_progress'): ExecutionBoundaryEvent {
  return {
    id,
    type: 'runner_progress',
    runId,
    step: 'implement',
    importance: 'low',
    createdAt: '2026-06-09T00:00:00.000Z',
    progress: { kind: 'intent', summary: 'Working' }
  } as ExecutionBoundaryEvent;
}

function makeFakeEntryPoint(events: ExecutionBoundaryEvent[]): ExecutionEntryPoint {
  return {
    execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    }
  };
}

function makeFakeThrowingEntryPoint(error: Error): ExecutionEntryPoint {
  return {
    execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
      return (async function* () {
        throw error;
        yield {} as ExecutionBoundaryEvent;
      })();
    }
  };
}

function makeFakeThrowAfterTerminalEntryPoint(terminal: ExecutionBoundaryEvent, error: Error): ExecutionEntryPoint {
  return {
    execute(_input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
      return (async function* () {
        yield terminal;
        throw error;
      })();
    }
  };
}

function newStore() {
  return new InMemoryRetainedRunEventStore();
}

describe('createExecutionRunUnitOfWork', () => {
  describe('terminal directive mapping', () => {
    it('advance maps to { directive: advance }', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeTerminalEvent('advance')]),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      expect(await unitOfWork.run(makeInput())).toEqual({ directive: 'advance' });
    });

    it('needs_input maps with question', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeTerminalEvent('needs_input')]),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      expect(await unitOfWork.run(makeInput())).toEqual({ directive: 'needs_input', question: 'What color?' });
    });

    it('fail maps with normalized reason (unknown runner reason becomes safe fallback)', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeTerminalEvent('fail')]),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      // 'Something went wrong.' is not on the allowlist — normalized to the safe fallback code.
      expect(await unitOfWork.run(makeInput())).toEqual({ directive: 'fail', reason: 'runner_failed_before_terminal_result' });
    });

    it('fail with no reason uses fallback', async () => {
      const terminalNoReason: ExecutionBoundaryEvent = {
        id: 'evt_1', type: 'runner_terminal_result', runId, step: 'implement', importance: 'normal',
        createdAt: '2026-06-09T00:00:00.000Z', result: { directive: 'fail' }
      } as ExecutionBoundaryEvent;
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([terminalNoReason]),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      const result = await unitOfWork.run(makeInput());
      expect(result.directive).toBe('fail');
      if (result.directive === 'fail') expect(result.reason).toBeTruthy();
    });

    it('advance with result passes result through', async () => {
      const terminalWithResult: ExecutionBoundaryEvent = {
        id: 'evt_1', type: 'runner_terminal_result', runId, step: 'implement', importance: 'normal',
        createdAt: '2026-06-09T00:00:00.000Z',
        result: { directive: 'advance', result: { fileCount: 3, summary: 'done' } }
      } as ExecutionBoundaryEvent;
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([terminalWithResult]),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      expect(await unitOfWork.run(makeInput())).toEqual({
        directive: 'advance', result: { fileCount: 3, summary: 'done' }
      });
    });
  });

  describe('event retention', () => {
    it('appends every validated boundary event to the store in order', async () => {
      const store = newStore();
      const progress = makeProgressEvent();
      const terminal = makeTerminalEvent('advance');
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([progress, terminal]),
        resolveContext: async () => makeContext(),
        eventsStore: store
      });

      await unitOfWork.run(makeInput());
      const replay = await store.replayAfter({ runId, tenant });
      expect(replay).toEqual({ status: 'ok', events: [] });

      // Now query the events through a fresh subscriber+replay-by-id chain.
      // Use a brand new subscriber - it won't see past events, so verify via the
      // overall path by checking replay with a known id.
      const result = await store.replayAfter({ runId, tenant, lastEventId: 'evt_progress' });
      if (result.status !== 'ok') throw new Error(`expected ok`);
      expect(result.events.map((e) => e.id)).toEqual(['evt_terminal']);
    });
  });

  describe('error handling', () => {
    it('runner throws before terminal maps to fail with sanitized reason', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(new Error('Runner crashed')),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      const result = await unitOfWork.run(makeInput());
      expect(result).toMatchObject({ directive: 'fail', reason: 'Runner failed before terminal result.' });
    });

    it('sensitive error message does not leak into the fail reason', async () => {
      const sentinel = 'sk-SENSITIVE-KEY-12345';
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(new Error(`token=${sentinel}`)),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      const result = await unitOfWork.run(makeInput());
      expect(result.directive).toBe('fail');
      if (result.directive === 'fail') expect(result.reason).not.toContain(sentinel);
    });

    it('materialization error uses code-based reason', async () => {
      const sentinel = 'WORKSPACE-99999';
      const materializationError = new ExecutionMaterializationError(
        'workspace_provisioning_failed',
        `Workspace failed: /home/${sentinel}`,
        { cause: new Error('details') }
      );
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(materializationError),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      const result = await unitOfWork.run(makeInput());
      expect(result.directive).toBe('fail');
      if (result.directive === 'fail') {
        expect(result.reason).not.toContain(sentinel);
        expect(result.reason).toContain('workspace_provisioning_failed');
      }
    });

    it('maps classified provider auth failures to canonical fail reasons', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(new ClassifiedProviderFailureError('provider_auth_failed')),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      const result = await unitOfWork.run(makeInput());
      expect(result).toEqual({ directive: 'fail', reason: 'provider_auth_failed' });
    });

    it('does not copy raw provider errors into fail reasons', async () => {
      const sentinel = 'sk-test-secret';
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(new Error(`raw SDK body ${sentinel} /Users/mark/private`)),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      const result = await unitOfWork.run(makeInput());
      expect(result).toEqual({ directive: 'fail', reason: 'Runner failed before terminal result.' });
      expect(JSON.stringify(result)).not.toContain(sentinel);
    });

    it('returns profile_incomplete for model-routing configuration errors thrown from resolveContext', async () => {
      const unit = createExecutionRunUnitOfWork({
        resolveContext: async () => {
          throw new ModelRoutingConfigurationError('profile_incomplete', 'raw internal detail');
        },
        execute: { execute: async function* () { /* not reached */ } } as unknown as ExecutionEntryPoint,
        eventsStore: newStore()
      });

      await expect(unit.run(makeInput())).resolves.toEqual({
        directive: 'fail',
        reason: 'profile_incomplete'
      });
    });

    it('returns process_launch_failed for provider connection errors thrown from execute', async () => {
      const unit = createExecutionRunUnitOfWork({
        resolveContext: async () => makeContext(),
        execute: {
          execute: async function* () {
            throw new ProviderConnectionError('process_launch_failed', 'raw provider detail');
          }
        } as unknown as ExecutionEntryPoint,
        eventsStore: newStore()
      });

      await expect(unit.run(makeInput())).resolves.toEqual({
        directive: 'fail',
        reason: 'process_launch_failed'
      });
    });

    it('keeps classified provider failure reasons unchanged', async () => {
      const unit = createExecutionRunUnitOfWork({
        resolveContext: async () => makeContext(),
        execute: {
          execute: async function* () {
            throw new ClassifiedProviderFailureError('provider_auth_failed');
          }
        } as unknown as ExecutionEntryPoint,
        eventsStore: newStore()
      });

      await expect(unit.run(makeInput())).resolves.toEqual({
        directive: 'fail',
        reason: 'provider_auth_failed'
      });
    });

    it('resolveContext throwing SkillCatalogResolutionError propagates and runner is never invoked', async () => {
      const skillError = new SkillCatalogResolutionError(
        'skill_not_found',
        'Requested skill ref is not present in the catalog.',
        { ref: 'missing-skill' }
      );
      const executeSpy = vi.fn();
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: { execute: executeSpy },
        resolveContext: async () => { throw skillError; },
        eventsStore: newStore()
      });

      await expect(unitOfWork.run(makeInput())).rejects.toBeInstanceOf(SkillCatalogResolutionError);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('missing terminal re-throws missing_terminal_result', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeProgressEvent()]),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      await expect(unitOfWork.run(makeInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError', code: 'missing_terminal_result'
      });
    });

    it('runner throws after terminal re-throws runner_failed', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowAfterTerminalEntryPoint(makeTerminalEvent('advance'), new Error('after')),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      await expect(unitOfWork.run(makeInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError', code: 'runner_failed'
      });
    });

    it('duplicate terminal re-throws duplicate_terminal_result', async () => {
      const terminal1 = makeTerminalEvent('advance');
      const terminal2: ExecutionBoundaryEvent = {
        id: 'evt_2', type: 'runner_terminal_result', runId, step: 'implement', importance: 'normal',
        createdAt: '2026-06-09T00:00:00.000Z', result: { directive: 'advance' }
      } as ExecutionBoundaryEvent;
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([terminal1, terminal2]),
        resolveContext: async () => makeContext(),
        eventsStore: newStore()
      });
      await expect(unitOfWork.run(makeInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError', code: 'duplicate_terminal_result'
      });
    });

    it('pre-terminal append failure produces sanitized fail directive', async () => {
      const failingStore: InMemoryRetainedRunEventStore = newStore();
      const origAppend = failingStore.append.bind(failingStore);
      let n = 0;
      failingStore.append = async (input) => {
        n += 1;
        if (n === 1) throw new Error('store oom');
        return origAppend(input);
      };
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeProgressEvent(), makeTerminalEvent('advance')]),
        resolveContext: async () => makeContext(),
        eventsStore: failingStore
      });
      const result = await unitOfWork.run(makeInput());
      expect(result).toEqual({ directive: 'fail', reason: 'Control plane failed to append runner event.' });
    });
  });

  describe('ordering', () => {
    it('resolveContext runs before execute', async () => {
      const order: string[] = [];
      const resolveContext = vi.fn().mockImplementation(async () => {
        order.push('resolveContext');
        return makeContext();
      });
      const execute = vi.fn().mockImplementation((_input: ExecutionEntryPointInput) => {
        order.push('execute');
        return (async function* () { yield makeTerminalEvent('advance'); })();
      });
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: { execute }, resolveContext, eventsStore: newStore()
      });
      await unitOfWork.run(makeInput());
      expect(order).toEqual(['resolveContext', 'execute']);
    });
  });
});

describe('direct mode integration seam', () => {
  function makeDirectCall(): DirectCallRequest {
    return {
      purpose: 'intent_classification',
      input: { text: 'test' },
      resultValidation: {
        schemaId: 'intent',
        schema: { parse: (v: unknown) => v } as unknown as import('zod').ZodTypeAny
      }
    };
  }

  function makeDirectPort(result: unknown): DirectStepExecutionPort {
    return {
      call: vi.fn().mockResolvedValue({
        value: result,
        validation: { status: 'valid' },
        metadata: { outcome: 'succeeded', tokenUsage: { available: false }, degradedCapabilities: [] }
      })
    };
  }

  it('direct mode: directPort.call invoked, execute NOT invoked', async () => {
    const directCall = makeDirectCall();
    const directPort = makeDirectPort({ intent: 'review' });
    const executeSpy = vi.fn();

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: { execute: executeSpy },
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore()
    });

    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'advance', result: { intent: 'review' } });
    expect(directPort.call).toHaveBeenCalledOnce();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('direct mode: port receives step from run.currentStep, not runId', async () => {
    const directCall = makeDirectCall();
    const directPort = makeDirectPort({ intent: 'review' });

    const input = makeInput();
    // run.currentStep is 'implement', while runId is 'run_1' — they differ
    expect(input.run.currentStep).toBe('implement');
    expect(input.runId).toBe('run_1');

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([]),
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore()
    });

    await unitOfWork.run(input);
    expect(directPort.call).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'implement', runId: 'run_1' })
    );
  });

  it('direct mode: result is { directive: advance, result: value }', async () => {
    const directCall = makeDirectCall();
    const directPort = makeDirectPort({ score: 42 });

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([]),
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore()
    });

    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'advance', result: { score: 42 } });
  });

  it('direct mode: failure maps to { directive: fail, reason: Execution failed: <code> }', async () => {
    const directCall = makeDirectCall();
    const error = Object.assign(new Error('Direct call error'), { code: 'unsupported_adapter' });
    const directPort: DirectStepExecutionPort = {
      call: vi.fn().mockRejectedValue(error)
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([]),
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore()
    });

    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'fail', reason: 'Execution failed: unsupported_adapter' });
  });

  it('direct mode: generic error maps to { directive: fail, reason: Execution failed: direct_call_failed }', async () => {
    const directCall = makeDirectCall();
    const error = new Error('Something generic');
    const directPort: DirectStepExecutionPort = {
      call: vi.fn().mockRejectedValue(error)
    };

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([]),
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore()
    });

    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'fail', reason: 'Execution failed: direct_call_failed' });
  });

  it('direct mode: port not configured returns fail with direct_port_not_configured', async () => {
    const directCall = makeDirectCall();

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([]),
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      // direct not provided
      eventsStore: newStore()
    });

    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'fail', reason: 'Execution failed: direct_port_not_configured' });
  });

  it('consumeRunnerEvents NOT called in direct mode', async () => {
    // Ensure the agent path (event consumption loop) never runs during direct mode.
    // We use an entry point that would throw if called — any call to execute() would fail.
    const directCall = makeDirectCall();
    const directPort = makeDirectPort({ ok: true });

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeThrowingEntryPoint(new Error('should not be called')),
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'direct' as const, directCall }),
      direct: directPort,
      eventsStore: newStore()
    });

    // Should succeed without throwing (execute was not called)
    const result = await unitOfWork.run(makeInput());
    expect(result.directive).toBe('advance');
  });

  it('agent mode: existing behavior unchanged, execute invoked', async () => {
    const terminal = makeTerminalEvent('advance');
    const executeSpy = vi.fn().mockImplementation(() =>
      (async function* () { yield terminal; })()
    );
    const directPort = makeDirectPort({});

    const unitOfWork = createExecutionRunUnitOfWork({
      execute: { execute: executeSpy },
      resolveContext: async () => makeContext(),
      resolveExecutionMode: () => ({ mode: 'agent' as const }),
      direct: directPort,
      eventsStore: newStore()
    });

    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'advance' });
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(directPort.call).not.toHaveBeenCalled();
  });

  it('default mode (no resolveExecutionMode) uses agent path', async () => {
    const unitOfWork = createExecutionRunUnitOfWork({
      execute: makeFakeEntryPoint([makeTerminalEvent('advance')]),
      resolveContext: async () => makeContext(),
      eventsStore: newStore()
    });

    const result = await unitOfWork.run(makeInput());
    expect(result).toEqual({ directive: 'advance' });
  });
});

// Reference to suppress unused-imports lints in this minimal spec.
void createExecutionEntryPoint;
void ((null as unknown) as Runner);
void ((null as unknown) as RunnerRunInput);
