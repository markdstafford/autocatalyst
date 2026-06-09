import { describe, expect, it, vi } from 'vitest';

import type { ExecutionContext, RunnerEvent } from '@autocatalyst/api-contract';
import { createExecutionEntryPoint } from './execution-entry-point.js';
import { RunnerProtocolError } from './runner.js';
import type { Runner, RunnerCloseResult, RunnerRunInput } from './runner.js';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';

const runId = 'run_1';

function makeTerminalEvent(): RunnerEvent {
  return {
    id: 'evt_terminal',
    type: 'runner_terminal_result',
    runId,
    step: 'implement',
    importance: 'normal',
    createdAt: '2026-06-09T00:00:00.000Z',
    result: { directive: 'advance' }
  };
}

function makeContext(): ExecutionContext {
  return {
    run: { id: runId, workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
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

function makeMaterializedEnv(context: ExecutionContext): MaterializedExecutionEnvironment {
  return {
    context,
    workspace: { shape: 'none', workspaceRoots: [] },
    environment: { variables: {}, secretVariableNames: [] },
    toolPolicy: { allowedTools: ['bash'], workspaceRoots: [] },
    skills: { requested: ['stub_runner'] },
    capabilities: {
      shell: { kind: 'bash', available: false },
      paths: {},
      lsp: { requested: true, available: false }
    }
  };
}

function makeFakeRunner(events: RunnerEvent[], closeResult: RunnerCloseResult | Error = { status: 'closed' }): Runner {
  const closeMock = typeof closeResult === 'object' && closeResult instanceof Error
    ? vi.fn().mockRejectedValue(closeResult)
    : vi.fn().mockResolvedValue(closeResult);

  return {
    run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    },
    close: closeMock
  };
}

describe('createExecutionEntryPoint', () => {
  it('materializes environment and yields events from runner', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const terminal = makeTerminalEvent();
    const runner = makeFakeRunner([terminal]);

    const entryPoint = createExecutionEntryPoint({ runner, materialize });
    const collected: RunnerEvent[] = [];

    for await (const event of entryPoint.execute({ context, correlationId: runId })) {
      collected.push(event);
    }

    expect(materialize).toHaveBeenCalledWith(context);
    expect(collected).toEqual([terminal]);
  });

  it('runner.close() is called after stream completes normally', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const runner = makeFakeRunner([makeTerminalEvent()]);

    const entryPoint = createExecutionEntryPoint({ runner, materialize });
    const events: RunnerEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      events.push(event);
    }

    expect(runner.close).toHaveBeenCalledOnce();
  });

  it('runner.close() is called even when runner throws during streaming', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const runnerError = new Error('Runner crashed mid-stream');
    const throwingRunner: Runner = {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          throw runnerError;
          // eslint-disable-next-line @typescript-eslint/no-unreachable
          yield {} as RunnerEvent;
        })();
      },
      close: vi.fn().mockResolvedValue({ status: 'closed' })
    };

    const entryPoint = createExecutionEntryPoint({ runner: throwingRunner, materialize });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toThrow('Runner crashed mid-stream');

    expect(throwingRunner.close).toHaveBeenCalledOnce();
  });

  it('runner.close() throws after successful stream → RunnerProtocolError(runner_close_failed)', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const runner = makeFakeRunner([makeTerminalEvent()], new Error('Close failed'));

    const entryPoint = createExecutionEntryPoint({ runner, materialize });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'runner_close_failed'
    });
  });

  it('runner.close() throws after stream error → original stream error propagates, not close error', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const streamError = new Error('Original stream error');
    const throwingRunner: Runner = {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          throw streamError;
          // eslint-disable-next-line @typescript-eslint/no-unreachable
          yield {} as RunnerEvent;
        })();
      },
      close: vi.fn().mockRejectedValue(new Error('Also close failed'))
    };

    const entryPoint = createExecutionEntryPoint({ runner: throwingRunner, materialize });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toThrow('Original stream error');
  });

  it('materialization error propagates before runner is invoked', async () => {
    const context = makeContext();
    const materializationError = new Error('Materialization failed');
    const materialize = vi.fn().mockRejectedValue(materializationError);
    const runner = makeFakeRunner([makeTerminalEvent()]);

    const entryPoint = createExecutionEntryPoint({ runner, materialize });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toThrow('Materialization failed');

    // close should NOT be called if materialization fails before runner.run
    expect(runner.close).not.toHaveBeenCalled();
  });

  it('runner_close_failed is an instance of RunnerProtocolError', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const runner = makeFakeRunner([makeTerminalEvent()], new Error('Close failure'));

    const entryPoint = createExecutionEntryPoint({ runner, materialize });

    let caughtError: unknown;
    try {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(RunnerProtocolError);
  });
});
