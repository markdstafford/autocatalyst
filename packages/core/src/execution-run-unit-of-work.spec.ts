import { describe, expect, it, vi } from 'vitest';

import type { ExecutionContext, RunnerEvent } from '@autocatalyst/api-contract';
import type { ExecutionEntryPoint, ExecutionEntryPointInput } from '@autocatalyst/execution';
import { ExecutionMaterializationError } from '@autocatalyst/execution';
import type { RunWorkInput } from './orchestrator.js';
import { createExecutionRunUnitOfWork } from './execution-run-unit-of-work.js';

const runId = 'run_1';
const tenant = 'tenant_1';

function makeInput(overrides: Partial<RunWorkInput> = {}): RunWorkInput {
  return {
    runId,
    run: {
      id: runId,
      owner: { id: 'user_1', kind: 'user', tenant },
      tenant,
      workKind: 'feature',
      currentStep: 'implement',
      terminal: false,
      createdAt: '2026-06-09T00:00:00.000Z',
      updatedAt: '2026-06-09T00:00:00.000Z'
    },
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
    skills: { requested: ['stub_runner'] },
    capabilityRequirements: {
      shell: { kind: 'bash', required: false },
      paths: { canonicalWorkspacePaths: true },
      lsp: { requested: true }
    }
  };
}

function makeTerminalEvent(directive: 'advance' | 'needs_input' | 'fail', overrides: Record<string, unknown> = {}): RunnerEvent {
  const result: Record<string, unknown> = { directive };
  if (directive === 'needs_input') result['question'] = 'What color?';
  if (directive === 'fail') result['reason'] = 'Something went wrong.';

  return {
    id: 'evt_1',
    type: 'runner_terminal_result',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    result: { ...result, ...overrides }
  } as RunnerEvent;
}

function makeProgressEvent(): RunnerEvent {
  return {
    id: 'evt_progress',
    type: 'runner_progress',
    runId,
    step: 'implement',
    importance: 'low',
    createdAt: '2026-06-09T00:00:00.000Z',
    progress: { kind: 'intent', summary: 'Working' }
  } as RunnerEvent;
}

function makeFakeEntryPoint(events: RunnerEvent[]): ExecutionEntryPoint {
  return {
    execute(_input: ExecutionEntryPointInput): AsyncIterable<RunnerEvent> {
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
    execute(_input: ExecutionEntryPointInput): AsyncIterable<RunnerEvent> {
      return (async function* () {
        throw error;
        yield {} as RunnerEvent; // unreachable — needed to satisfy AsyncGenerator<RunnerEvent> return type
      })();
    }
  };
}

function makeFakeThrowAfterTerminalEntryPoint(terminal: RunnerEvent, error: Error): ExecutionEntryPoint {
  return {
    execute(_input: ExecutionEntryPointInput): AsyncIterable<RunnerEvent> {
      return (async function* () {
        yield terminal;
        throw error;
      })();
    }
  };
}

describe('createExecutionRunUnitOfWork', () => {
  describe('terminal directive mapping', () => {
    it('advance terminal directive maps to { directive: advance }', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeTerminalEvent('advance')]),
        resolveContext: async () => makeContext()
      });

      const result = await unitOfWork.run(makeInput());
      expect(result).toEqual({ directive: 'advance' });
    });

    it('needs_input terminal directive maps to { directive: needs_input, question }', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeTerminalEvent('needs_input')]),
        resolveContext: async () => makeContext()
      });

      const result = await unitOfWork.run(makeInput());
      expect(result).toEqual({ directive: 'needs_input', question: 'What color?' });
    });

    it('fail terminal directive maps to { directive: fail, reason }', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeTerminalEvent('fail')]),
        resolveContext: async () => makeContext()
      });

      const result = await unitOfWork.run(makeInput());
      expect(result).toEqual({ directive: 'fail', reason: 'Something went wrong.' });
    });

    it('fail terminal directive with no reason uses fallback reason', async () => {
      const terminalNoReason: RunnerEvent = {
        id: 'evt_1',
        type: 'runner_terminal_result',
        runId,
        step: 'implement',
        importance: 'normal',
        createdAt: '2026-06-09T00:00:00.000Z',
        result: { directive: 'fail' }
      };

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([terminalNoReason]),
        resolveContext: async () => makeContext()
      });

      const result = await unitOfWork.run(makeInput());
      expect(result).toMatchObject({ directive: 'fail' });
      if (result.directive === 'fail') {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  describe('onEvent', () => {
    it('onEvent is called for each validated event', async () => {
      const onEvent = vi.fn();
      const progress = makeProgressEvent();
      const terminal = makeTerminalEvent('advance');

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([progress, terminal]),
        resolveContext: async () => makeContext(),
        onEvent
      });

      await unitOfWork.run(makeInput());

      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(onEvent).toHaveBeenNthCalledWith(1, progress);
      expect(onEvent).toHaveBeenNthCalledWith(2, terminal);
    });

    it('onEvent throwing re-throws RunnerProtocolError(runner_failed)', async () => {
      const onEvent = vi.fn().mockRejectedValue(new Error('telemetry fail'));
      const terminal = makeTerminalEvent('advance');

      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([terminal]),
        resolveContext: async () => makeContext(),
        onEvent
      });

      await expect(unitOfWork.run(makeInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'runner_failed'
      });
    });
  });

  describe('error handling', () => {
    it('runner throws before terminal maps to { directive: fail } with static reason', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(new Error('Runner crashed')),
        resolveContext: async () => makeContext()
      });

      const result = await unitOfWork.run(makeInput());
      expect(result).toMatchObject({ directive: 'fail', reason: 'Runner failed before terminal result.' });
    });

    it('runner throw with sensitive message → fail reason does not contain sensitive value', async () => {
      const sentinel = 'sk-SENSITIVE-API-KEY-12345';
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(new Error(`Connection failed: token=${sentinel}`)),
        resolveContext: async () => makeContext()
      });

      const result = await unitOfWork.run(makeInput());
      expect(result.directive).toBe('fail');
      if (result.directive === 'fail') {
        expect(result.reason).not.toContain(sentinel);
      }
    });

    it('materialization failure with sensitive message → fail reason does not contain sensitive value', async () => {
      const sentinel = 'sk-SENSITIVE-WORKSPACE-PATH-99999';
      const materializationError = new ExecutionMaterializationError(
        'workspace_provisioning_failed',
        `Workspace provisioning failed: /home/${sentinel}/repos`,
        { cause: new Error('sensitive details') }
      );
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowingEntryPoint(materializationError),
        resolveContext: async () => makeContext()
      });

      const result = await unitOfWork.run(makeInput());
      expect(result.directive).toBe('fail');
      if (result.directive === 'fail') {
        expect(result.reason).not.toContain(sentinel);
        // Should use code-based reason, not the raw message
        expect(result.reason).toContain('workspace_provisioning_failed');
      }
    });

    it('missing terminal result re-throws RunnerProtocolError(missing_terminal_result)', async () => {
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([makeProgressEvent()]), // no terminal
        resolveContext: async () => makeContext()
      });

      await expect(unitOfWork.run(makeInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'missing_terminal_result'
      });
    });

    it('runner throws after terminal re-throws RunnerProtocolError(runner_failed)', async () => {
      const terminal = makeTerminalEvent('advance');
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeThrowAfterTerminalEntryPoint(terminal, new Error('crash after terminal')),
        resolveContext: async () => makeContext()
      });

      await expect(unitOfWork.run(makeInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'runner_failed'
      });
    });

    it('duplicate terminal result re-throws RunnerProtocolError(duplicate_terminal_result)', async () => {
      const terminal1 = makeTerminalEvent('advance');
      const terminal2: RunnerEvent = {
        id: 'evt_2',
        type: 'runner_terminal_result',
        runId,
        step: 'implement',
        importance: 'normal',
        createdAt: '2026-06-09T00:00:00.000Z',
        result: { directive: 'advance' }
      };
      const unitOfWork = createExecutionRunUnitOfWork({
        execute: makeFakeEntryPoint([terminal1, terminal2]),
        resolveContext: async () => makeContext()
      });

      await expect(unitOfWork.run(makeInput())).rejects.toMatchObject({
        name: 'RunnerProtocolError',
        code: 'duplicate_terminal_result'
      });
    });
  });

  describe('ordering', () => {
    it('resolveContext is called before execute', async () => {
      const callOrder: string[] = [];

      const resolveContext = vi.fn().mockImplementation(async () => {
        callOrder.push('resolveContext');
        return makeContext();
      });

      const execute = vi.fn().mockImplementation((_input: ExecutionEntryPointInput) => {
        callOrder.push('execute');
        return (async function* () {
          yield makeTerminalEvent('advance');
        })();
      });

      const unitOfWork = createExecutionRunUnitOfWork({ execute: { execute }, resolveContext });

      await unitOfWork.run(makeInput());

      expect(callOrder).toEqual(['resolveContext', 'execute']);
    });
  });
});
