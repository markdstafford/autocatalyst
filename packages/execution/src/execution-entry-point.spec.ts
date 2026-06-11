import { describe, expect, it, vi } from 'vitest';

import type { ExecutionContext, RunnerEvent } from '@autocatalyst/api-contract';
import { createExecutionEntryPoint } from './execution-entry-point.js';
import type { ExecutionBoundaryEvent, ExecutionTerminalResultEvent } from './execution-boundary-events.js';
import { RunnerProtocolError } from './runner.js';
import { StubRunner } from './stub-runner.js';
import type { ExecutionResultValidationConfig } from './execution-entry-point.js';
import type { Runner, RunnerCloseResult, RunnerRunInput } from './runner.js';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import { ExecutionMaterializationError } from './materialized-environment.js';
import { SkillCatalogResolutionError } from './skills/skill-resolver.js';

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
    skills: { requested: [], resolved: [] },
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
    skills: { requested: [], resolved: [] },
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

    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });
    const collected: ExecutionBoundaryEvent[] = [];

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

    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });
    const events: ExecutionBoundaryEvent[] = [];
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
          yield {} as RunnerEvent; // unreachable — needed to satisfy AsyncGenerator<RunnerEvent> return type
        })();
      },
      close: vi.fn().mockResolvedValue({ status: 'closed' })
    };

    const entryPoint = createExecutionEntryPoint({ runner: throwingRunner, materialize, resultValidation: { mode: 'none' } });

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

    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'runner_close_failed'
    });
  });

  it('pre-terminal stream error + close failure → original stream error propagates', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const throwingRunner: Runner = {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          throw new Error('Pre-terminal stream error');
          yield {} as RunnerEvent; // unreachable — needed to satisfy AsyncGenerator<RunnerEvent> return type
        })();
      },
      close: vi.fn().mockRejectedValue(new Error('Also close failed'))
    };

    const entryPoint = createExecutionEntryPoint({ runner: throwingRunner, materialize, resultValidation: { mode: 'none' } });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toThrow('Pre-terminal stream error');
  });

  it('no-terminal stream + close fails → generator completes without throwing', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const noTerminalRunner: Runner = {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          // No events emitted — no terminal event
        })();
      },
      close: vi.fn().mockRejectedValue(new Error('Close failed'))
    };

    const entryPoint = createExecutionEntryPoint({ runner: noTerminalRunner, materialize, resultValidation: { mode: 'none' } });

    // Should NOT throw — the generator completes normally
    // Consumer (consumeRunnerEventStream) will then report missing_terminal_result
    const collected: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(0);
  });

  it('post-terminal stream error + close failure → original stream error propagates', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const terminal = makeTerminalEvent();
    const postTerminalError = new Error('Post-terminal stream error');
    const throwingRunner: Runner = {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          yield terminal;
          throw postTerminalError;
        })();
      },
      close: vi.fn().mockRejectedValue(new Error('Also close failed'))
    };

    const entryPoint = createExecutionEntryPoint({ runner: throwingRunner, materialize, resultValidation: { mode: 'none' } });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toThrow('Post-terminal stream error');
  });

  it('materialization error propagates before runner is invoked', async () => {
    const context = makeContext();
    const materializationError = new Error('Materialization failed');
    const materialize = vi.fn().mockRejectedValue(materializationError);
    const runner = makeFakeRunner([makeTerminalEvent()]);

    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

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

    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

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

  it('throws skill_materialization_failed before runner.run is invoked when validateSkillCatalog fails', async () => {
    const context = makeContext();
    const skillError = new SkillCatalogResolutionError(
      'skill_not_found',
      'Requested skill ref is not present in the catalog.',
      { ref: 'missing-skill' }
    );
    const materializationError = new ExecutionMaterializationError(
      'skill_materialization_failed',
      'Resolved skill bundle failed materialization validation.',
      skillError
    );
    const materialize = vi.fn().mockRejectedValue(materializationError);
    const runSpy = vi.fn();
    const spiedRunner: Runner = {
      run(input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        runSpy(input);
        return (async function* () {
          yield makeTerminalEvent();
        })();
      },
      close: vi.fn().mockResolvedValue({ status: 'closed' })
    };

    const entryPoint = createExecutionEntryPoint({ runner: spiedRunner, materialize, resultValidation: { mode: 'none' } });

    let caughtError: unknown;
    try {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ExecutionMaterializationError);
    expect((caughtError as ExecutionMaterializationError).code).toBe('skill_materialization_failed');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('non-terminal events are yielded before runner.close() is called', async () => {
    // Verifies live delivery: consumers should receive progress events while the run is
    // still active, not only after the entire stream has been buffered and close() completes.
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const progressEvent: RunnerEvent = {
      id: 'evt_progress',
      type: 'runner_progress',
      runId,
      step: 'implement',
      importance: 'normal',
      createdAt: '2026-06-09T00:00:00.000Z',
      progress: { kind: 'task_progress', label: 'Running tests', completed: 1, total: 3 }
    };

    let closeCallCount = 0;
    const runner: Runner = {
      run(_input) {
        return (async function* () {
          yield progressEvent;
          yield makeTerminalEvent();
        })();
      },
      close: vi.fn(async () => {
        closeCallCount++;
        return { status: 'closed' as const };
      })
    };

    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

    let progressReceivedBeforeClose = false;
    for await (const event of entryPoint.execute({ context })) {
      if (event.type !== 'runner_terminal_result') {
        // close() must not have been called yet — the stream is still active
        progressReceivedBeforeClose = closeCallCount === 0;
      }
    }

    expect(progressReceivedBeforeClose).toBe(true);
    expect(closeCallCount).toBe(1);
  });
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

describe('createExecutionEntryPoint — resultValidation', () => {
  it('mode: none preserves terminal directive shape', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const terminal = makeTerminalEvent();
    const runner = makeFakeRunner([terminal]);
    const entryPoint = createExecutionEntryPoint({
      runner,
      materialize,
      resultValidation: { mode: 'none' }
    });
    const collected: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      collected.push(event);
    }
    expect(collected).toHaveLength(1);
    const out = collected[0];
    expect(out?.type).toBe('runner_terminal_result');
    if (out?.type === 'runner_terminal_result') {
      expect(out.result.directive).toBe('advance');
    }
  });

  it('throws TypeError when resultValidation is missing', () => {
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(makeContext()));
    const runner = makeFakeRunner([makeTerminalEvent()]);
    expect(() => {
      createExecutionEntryPoint({ runner, materialize } as unknown as Parameters<typeof createExecutionEntryPoint>[0]);
    }).toThrow(TypeError);
  });

  it('throws TypeError when scratch_file config lacks contract source', () => {
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(makeContext()));
    const runner = makeFakeRunner([makeTerminalEvent()]);
    expect(() => {
      createExecutionEntryPoint({
        runner,
        materialize,
        resultValidation: { mode: 'scratch_file' }
      });
    }).toThrow(TypeError);
  });

  it('mode: scratch_file with valid result yields validated terminal', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'exec-entry-'));
    try {
      const resultFile = 'step-result.json';
      const payload = { ok: true, value: 42 };
      await writeFile(path.join(scratchRoot, resultFile), JSON.stringify(payload), 'utf8');

      const context = makeContext();
      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: {
          shape: 'scratch_only',
          scratchRoot,
          workspaceRoots: [scratchRoot]
        }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const terminal = makeTerminalEvent();
      const runner = makeFakeRunner([terminal]);

      const schema = z.object({ ok: z.boolean(), value: z.number() });
      const entryPoint = createExecutionEntryPoint({
        runner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'implement',
          schemaId: 'test.schema',
          schema,
          resultFile
        }
      });

      const collected: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        collected.push(event);
      }
      const out = collected[0];
      expect(out?.type).toBe('runner_terminal_result');
      if (out?.type === 'runner_terminal_result') {
        expect(out.result.directive).toBe('advance');
        expect(out.result.result).toEqual(payload);
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('mode: scratch_file with missing contract yields fail terminal', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'exec-entry-'));
    try {
      const context = makeContext();
      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: {
          shape: 'scratch_only',
          scratchRoot,
          workspaceRoots: [scratchRoot]
        }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const runner = makeFakeRunner([makeTerminalEvent()]);

      // registry-based config without matching contract → result_contract_unknown
      const { createStepResultContractRegistry } = await import('./result-contracts.js');
      const registry = createStepResultContractRegistry([]);
      const entryPoint = createExecutionEntryPoint({
        runner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'implement',
          schemaId: 'unknown.schema',
          contractRegistry: registry,
          resultFile: 'r.json'
        }
      });

      const collected: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        collected.push(event);
      }
      const out = collected[0];
      expect(out?.type).toBe('runner_terminal_result');
      if (out?.type === 'runner_terminal_result') {
        expect(out.result.directive).toBe('fail');
        expect(out.result.reason).toContain('result_contract_unknown');
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('mode: scratch_file with invalid result yields fail terminal', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'exec-entry-'));
    try {
      const resultFile = 'step-result.json';
      await writeFile(path.join(scratchRoot, resultFile), JSON.stringify({ ok: 'not-bool' }), 'utf8');

      const context = makeContext();
      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: {
          shape: 'scratch_only',
          scratchRoot,
          workspaceRoots: [scratchRoot]
        }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const runner = makeFakeRunner([makeTerminalEvent()]);

      const schema = z.object({ ok: z.boolean() });
      const entryPoint = createExecutionEntryPoint({
        runner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'implement',
          schemaId: 'test.schema',
          schema,
          resultFile,
          maxCorrectionAttempts: 0
        }
      });

      const collected: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        collected.push(event);
      }
      const out = collected[0];
      expect(out?.type).toBe('runner_terminal_result');
      if (out?.type === 'runner_terminal_result') {
        expect(out.result.directive).toBe('fail');
        expect(out.result.reason).toContain('schema_validation_failed');
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('raw duplicate terminal throws RunnerProtocolError', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const terminal = makeTerminalEvent();
    const dupTerminal: RunnerEvent = { ...terminal, id: 'evt_terminal_2' };
    const runner = makeFakeRunner([terminal, dupTerminal]);
    const entryPoint = createExecutionEntryPoint({
      runner,
      materialize,
      resultValidation: { mode: 'none' }
    });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'duplicate_terminal_result'
    });
  });

  it('wrong run id in raw stream throws RunnerProtocolError', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const terminal: RunnerEvent = { ...makeTerminalEvent(), runId: 'run_other' };
    const runner = makeFakeRunner([terminal]);
    const entryPoint = createExecutionEntryPoint({
      runner,
      materialize,
      resultValidation: { mode: 'none' }
    });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toMatchObject({
      name: 'RunnerProtocolError',
      code: 'wrong_run'
    });
  });

  it('scratch_file mode: missing result file yields synthesized fail terminal', async () => {
    const context = makeContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'ep-test-'));
    const materializedEnv: MaterializedExecutionEnvironment = {
      ...makeMaterializedEnv(context),
      workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] },
      capabilities: {
        shell: { kind: 'bash', available: false },
        paths: { scratchRoot },
        lsp: { requested: false, available: false }
      }
    };
    const materialize = vi.fn().mockResolvedValue(materializedEnv);

    const schema = z.object({ artifact: z.string() }).strict();
    const stubRunner = new StubRunner(); // no resultFile — file never written
    const entryPoint = createExecutionEntryPoint({
      runner: stubRunner,
      materialize,
      resultValidation: {
        mode: 'scratch_file',
        contract: { step: 'implement', schemaId: 'terminal-handoff.v1', schema, resultFile: 'result.json' }
      }
    });

    const events: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      events.push(event);
    }

    const terminal = events.find((e) => e.type === 'runner_terminal_result') as ExecutionTerminalResultEvent | undefined;
    expect(terminal).toBeDefined();
    expect(terminal?.result.directive).toBe('fail');
    expect(terminal?.result.reason).toContain('result_file_missing');
  });

  it('raw post-terminal event throws RunnerProtocolError', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const postTerminalRunner: Runner = {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          yield {
            id: 'evt_terminal',
            type: 'runner_terminal_result' as const,
            runId,
            step: 'implement',
            importance: 'normal' as const,
            createdAt: '2026-06-09T00:00:00.000Z',
            result: { directive: 'advance' as const }
          };
          yield {
            id: 'evt_after_terminal',
            type: 'runner_progress' as const,
            runId,
            step: 'implement',
            importance: 'normal' as const,
            createdAt: '2026-06-09T00:00:00.000Z',
            progress: { kind: 'intent' as const, summary: 'too late' }
          };
        })();
      },
      close: vi.fn().mockResolvedValue({ status: 'closed' })
    };

    const entryPoint = createExecutionEntryPoint({
      runner: postTerminalRunner,
      materialize,
      resultValidation: { mode: 'none' }
    });

    await expect(async () => {
      for await (const _ of entryPoint.execute({ context })) {
        // consume
      }
    }).rejects.toMatchObject({ name: 'RunnerProtocolError', code: 'event_after_terminal' });
  });

  it('unknown resultValidation mode throws TypeError', () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    expect(() => createExecutionEntryPoint({
      runner: makeFakeRunner([makeTerminalEvent()]),
      materialize,
      resultValidation: { mode: 'unknown_mode' } as unknown as ExecutionResultValidationConfig
    })).toThrow(TypeError);
  });

  it('scratch_file mode: needs_input terminal passes through without reading result file', async () => {
    const context = makeContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'ep-ni-test-'));
    try {
      const materializedEnv: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(materializedEnv);
      const schema = z.object({ artifact: z.string() }).strict();

      // Runner emits needs_input terminal; no result file is written.
      const needsInputRunner: Runner = {
        run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
          return (async function* () {
            yield {
              id: 'evt_ni',
              type: 'runner_terminal_result' as const,
              runId,
              step: 'implement',
              importance: 'high' as const,
              createdAt: '2026-06-09T00:00:00.000Z',
              result: { directive: 'needs_input' as const, question: 'What format?' }
            };
          })();
        },
        close: vi.fn().mockResolvedValue({ status: 'closed' })
      };

      const entryPoint = createExecutionEntryPoint({
        runner: needsInputRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          contract: { step: 'implement', schemaId: 'terminal-handoff.v1', schema, resultFile: 'result.json' }
        }
      });

      const events: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        events.push(event);
      }

      const terminal = events.find((e) => e.type === 'runner_terminal_result') as ExecutionTerminalResultEvent | undefined;
      expect(terminal).toBeDefined();
      expect(terminal?.result.directive).toBe('needs_input');
      if (terminal?.result.directive === 'needs_input') {
        expect(terminal.result.question).toBe('What format?');
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('scratch_file mode: fail terminal passes through without reading result file', async () => {
    const context = makeContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'ep-fail-test-'));
    try {
      const materializedEnv: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(materializedEnv);
      const schema = z.object({ artifact: z.string() }).strict();

      const failRunner: Runner = {
        run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
          return (async function* () {
            yield {
              id: 'evt_fail',
              type: 'runner_terminal_result' as const,
              runId,
              step: 'implement',
              importance: 'high' as const,
              createdAt: '2026-06-09T00:00:00.000Z',
              result: { directive: 'fail' as const, reason: 'Agent crashed.' }
            };
          })();
        },
        close: vi.fn().mockResolvedValue({ status: 'closed' })
      };

      const entryPoint = createExecutionEntryPoint({
        runner: failRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          contract: { step: 'implement', schemaId: 'terminal-handoff.v1', schema, resultFile: 'result.json' }
        }
      });

      const events: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        events.push(event);
      }

      const terminal = events.find((e) => e.type === 'runner_terminal_result') as ExecutionTerminalResultEvent | undefined;
      expect(terminal).toBeDefined();
      expect(terminal?.result.directive).toBe('fail');
      if (terminal?.result.directive === 'fail') {
        expect(terminal.result.reason).toBe('Agent crashed.');
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

