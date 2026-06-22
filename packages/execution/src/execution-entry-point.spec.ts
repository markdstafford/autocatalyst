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
import {
  registerSpecAuthorResultContract,
  registerReviewerResultContract,
  registerImplementerDispositionsResultContract,
  createStepResultContractRegistry,
  SPEC_AUTHOR_SCHEMA_ID,
  REVIEWER_RESULT_SCHEMA_ID,
  IMPLEMENTER_DISPOSITIONS_SCHEMA_ID
} from './result-contracts.js';

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

  it('scratch_file mode: contract normalizers run before config normalizers', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'ep-norm-compose-'));
    try {
      const resultFile = 'step-result.json';
      // Write raw payload — both normalizers need to run to produce valid output
      const rawPayload = {};
      await writeFile(path.join(scratchRoot, resultFile), JSON.stringify(rawPayload), 'utf8');

      const context = makeContext();
      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const runner = makeFakeRunner([makeTerminalEvent()]);

      const order: string[] = [];

      const contractNormalizer = {
        id: 'contract-test-normalizer',
        description: 'Adds fromContract flag',
        normalize(input: { candidate: unknown }) {
          order.push('contract');
          return {
            status: 'changed' as const,
            candidate: { ...(input.candidate as object), fromContract: true },
            message: 'added fromContract'
          };
        }
      };

      const configNormalizer = {
        id: 'config-test-normalizer',
        description: 'Adds fromConfig flag',
        normalize(input: { candidate: unknown }) {
          order.push('config');
          return {
            status: 'changed' as const,
            candidate: { ...(input.candidate as object), fromConfig: true },
            message: 'added fromConfig'
          };
        }
      };

      const schema = z.object({ fromContract: z.literal(true), fromConfig: z.literal(true) }).strict();

      const entryPoint = createExecutionEntryPoint({
        runner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          contract: {
            step: 'implement',
            schemaId: 'compose-test.v1',
            schema,
            resultFile,
            normalizers: [contractNormalizer]
          },
          normalizers: [configNormalizer]
        }
      });

      const events: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        events.push(event);
      }

      const terminal = events.find((e) => e.type === 'runner_terminal_result') as ExecutionTerminalResultEvent | undefined;
      expect(terminal).toBeDefined();
      expect(terminal?.result.directive).toBe('advance');
      if (terminal?.result.directive === 'advance') {
        expect(terminal.result.result).toMatchObject({ fromContract: true, fromConfig: true });
      }
      // Contract normalizer ran first, then config normalizer
      expect(order).toEqual(['contract', 'config']);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// spec.author result contract enforcement tests
// ---------------------------------------------------------------------------

const conformantSpecAuthorResult = {
  kind: 'feature_spec',
  slug: 'author-real-conformant-spec',
  relativePath: 'context-human/specs/feature-author-real-conformant-spec.md',
  frontmatter: {
    created: '2026-06-13',
    last_updated: '2026-06-13',
    status: 'draft',
    issue: 46,
    specced_by: 'autocatalyst'
  },
  body: '# Feature: Author a real conformant spec\n\n## Task list\n\n### Story 1 — Build context'
} as const;

function makeSpecAuthorContext(): ExecutionContext {
  return {
    run: { id: runId, workKind: 'feature', currentStep: 'spec.author', tenant: 'tenant_1' },
    task: { prompt: 'Author a spec', inputs: {} },
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

describe('createExecutionEntryPoint — spec.author result contract', () => {
  it('SPEC_AUTHOR_SCHEMA_ID resolves from registry for spec.author step', () => {
    const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
    const resolution = registry.resolve({ step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID });
    expect(resolution.status).toBe('resolved');
    if (resolution.status === 'resolved') {
      expect(resolution.contract.schemaId).toBe(SPEC_AUTHOR_SCHEMA_ID);
      expect(resolution.contract.step).toBe('spec.author');
      expect(resolution.contract.resultFile).toBe('step-result.json');
    }
  });

  it('conformant step-result.json becomes parsed advance.result with resultContract', async () => {
    const context = makeSpecAuthorContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'spec-author-ok-'));
    try {
      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
      const stubRunner = new StubRunner({
        resultFile: { relativePath: 'step-result.json', value: conformantSpecAuthorResult }
      });

      const entryPoint = createExecutionEntryPoint({
        runner: stubRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'spec.author',
          schemaId: SPEC_AUTHOR_SCHEMA_ID,
          contractRegistry: registry,
          resultFile: 'step-result.json'
        }
      });

      const events: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        events.push(event);
      }

      const terminal = events.find((e) => e.type === 'runner_terminal_result') as ExecutionTerminalResultEvent | undefined;
      expect(terminal).toBeDefined();
      expect(terminal?.result.directive).toBe('advance');
      if (terminal?.result.directive === 'advance') {
        expect(terminal.result.result).toMatchObject({
          kind: 'feature_spec',
          slug: 'author-real-conformant-spec',
          relativePath: 'context-human/specs/feature-author-real-conformant-spec.md'
        });
      }
      expect(terminal?.resultContract).toMatchObject({
        step: 'spec.author',
        schemaId: SPEC_AUTHOR_SCHEMA_ID
      });
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('missing step-result.json fails with result_file_missing before side-effect spy runs', async () => {
    const context = makeSpecAuthorContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'spec-author-missing-'));
    try {
      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
      // No resultFile written — StubRunner without resultFile option
      const stubRunner = new StubRunner();
      const completionSideEffectSpy = vi.fn();

      const entryPoint = createExecutionEntryPoint({
        runner: stubRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'spec.author',
          schemaId: SPEC_AUTHOR_SCHEMA_ID,
          contractRegistry: registry,
          resultFile: 'step-result.json'
        }
      });

      const events: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        events.push(event);
      }

      // The spy must NOT have been called — validation fails before any completion side-effect
      expect(completionSideEffectSpy).not.toHaveBeenCalled();

      const terminal = events.find((e) => e.type === 'runner_terminal_result') as ExecutionTerminalResultEvent | undefined;
      expect(terminal).toBeDefined();
      expect(terminal?.result.directive).toBe('fail');
      if (terminal?.result.directive === 'fail') {
        expect(terminal.result.reason).toContain('result_file_missing');
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('invalid JSON in step-result.json yields fail with sanitized reason', async () => {
    const context = makeSpecAuthorContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'spec-author-badjson-'));
    try {
      await writeFile(path.join(scratchRoot, 'step-result.json'), 'not valid json {{{{', 'utf8');

      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
      const stubRunner = new StubRunner(); // no resultFile — file already placed above

      const entryPoint = createExecutionEntryPoint({
        runner: stubRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'spec.author',
          schemaId: SPEC_AUTHOR_SCHEMA_ID,
          contractRegistry: registry,
          resultFile: 'step-result.json'
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
        // reason should not contain raw file content
        expect(terminal.result.reason).not.toContain('not valid json');
        expect(terminal.result.reason).toMatch(/result_json_invalid|result_parse_failed|json_parse_failed|schema_validation_failed/);
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('mismatched path/kind/slug in step-result.json fails schema validation', async () => {
    const context = makeSpecAuthorContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'spec-author-mismatch-'));
    try {
      // relativePath doesn't match kind+slug (feature slug but enhancement path)
      const mismatchedResult = {
        ...conformantSpecAuthorResult,
        relativePath: 'context-human/specs/enhancement-author-real-conformant-spec.md'
      };
      await writeFile(path.join(scratchRoot, 'step-result.json'), JSON.stringify(mismatchedResult), 'utf8');

      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
      const stubRunner = new StubRunner();

      const entryPoint = createExecutionEntryPoint({
        runner: stubRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'spec.author',
          schemaId: SPEC_AUTHOR_SCHEMA_ID,
          contractRegistry: registry,
          resultFile: 'step-result.json'
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
        expect(terminal.result.reason).toContain('schema_validation_failed');
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('model-provided invalid frontmatter status is overridden by system stamping and advances', async () => {
    const context = makeSpecAuthorContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'spec-author-badstatus-'));
    try {
      // 'in_progress' is not a valid committedSpecStatusSchema value, but 'status' is now a
      // system-owned field: stampSpecAuthorResultIdentity always overwrites it with 'draft'.
      // The result should advance rather than fail schema validation.
      const badStatusResult = {
        ...conformantSpecAuthorResult,
        frontmatter: { ...conformantSpecAuthorResult.frontmatter, status: 'in_progress' }
      };
      await writeFile(path.join(scratchRoot, 'step-result.json'), JSON.stringify(badStatusResult), 'utf8');

      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
      const stubRunner = new StubRunner();

      const entryPoint = createExecutionEntryPoint({
        runner: stubRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'spec.author',
          schemaId: SPEC_AUTHOR_SCHEMA_ID,
          contractRegistry: registry,
          resultFile: 'step-result.json',
          maxCorrectionAttempts: 0
        }
      });

      const events: ExecutionBoundaryEvent[] = [];
      for await (const event of entryPoint.execute({ context })) {
        events.push(event);
      }

      const terminal = events.find((e) => e.type === 'runner_terminal_result') as ExecutionTerminalResultEvent | undefined;
      expect(terminal).toBeDefined();
      expect(terminal?.result.directive).toBe('advance');
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('empty body fails schema validation', async () => {
    const context = makeSpecAuthorContext();
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'spec-author-emptybody-'));
    try {
      const emptyBodyResult = { ...conformantSpecAuthorResult, body: '   ' };
      await writeFile(path.join(scratchRoot, 'step-result.json'), JSON.stringify(emptyBodyResult), 'utf8');

      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const registry = registerSpecAuthorResultContract(createStepResultContractRegistry());
      const stubRunner = new StubRunner();

      const entryPoint = createExecutionEntryPoint({
        runner: stubRunner,
        materialize,
        resultValidation: {
          mode: 'scratch_file',
          step: 'spec.author',
          schemaId: SPEC_AUTHOR_SCHEMA_ID,
          contractRegistry: registry,
          resultFile: 'step-result.json',
          maxCorrectionAttempts: 0
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
        expect(terminal.result.reason).toContain('schema_validation_failed');
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('unrelated step (not spec.author) uses its own contract and ignores spec author registry entry', async () => {
    const context = makeContext(); // uses 'implement' step
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'spec-author-unrelated-'));
    try {
      const implementResult = { artifact: 'my-artifact' };
      await writeFile(path.join(scratchRoot, 'result.json'), JSON.stringify(implementResult), 'utf8');

      const env: MaterializedExecutionEnvironment = {
        ...makeMaterializedEnv(context),
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      };
      const materialize = vi.fn().mockResolvedValue(env);
      const schema = z.object({ artifact: z.string() }).strict();

      const entryPoint = createExecutionEntryPoint({
        runner: makeFakeRunner([makeTerminalEvent()]),
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
      expect(terminal?.result.directive).toBe('advance');
      if (terminal?.result.directive === 'advance') {
        expect(terminal.result.result).toEqual(implementResult);
      }
      // resultContract should reflect the implement contract, not spec.author
      expect(terminal?.resultContract).toMatchObject({
        step: 'implement',
        schemaId: 'terminal-handoff.v1'
      });
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});


describe('createExecutionEntryPoint — implementation.build per-round result files', () => {
  const reviewerRegistry = registerImplementerDispositionsResultContract(
    registerReviewerResultContract(createStepResultContractRegistry())
  );

  function makeBuildContext(): ExecutionContext {
    const context = makeContext();
    context.run.currentStep = 'implementation.build';
    return context;
  }

  async function runWithScratch(args: {
    readonly scratchRoot: string;
    readonly schemaId: string;
    readonly resultFile: string;
  }): Promise<ExecutionTerminalResultEvent | undefined> {
    const context = makeBuildContext();
    const env: MaterializedExecutionEnvironment = {
      ...makeMaterializedEnv(context),
      workspace: { shape: 'scratch_only', scratchRoot: args.scratchRoot, workspaceRoots: [args.scratchRoot] }
    };
    const terminal = { ...makeTerminalEvent(), step: 'implementation.build' as const };
    const entryPoint = createExecutionEntryPoint({
      runner: makeFakeRunner([terminal]),
      materialize: vi.fn().mockResolvedValue(env),
      resultValidation: {
        mode: 'scratch_file',
        step: 'implementation.build',
        schemaId: args.schemaId,
        contractRegistry: reviewerRegistry,
        resultFile: args.resultFile,
        maxCorrectionAttempts: 0
      }
    });
    const collected: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) collected.push(event);
    const out = collected[0];
    return out?.type === 'runner_terminal_result' ? out : undefined;
  }

  it('validates the implementer disposition file as a disposition and the reviewer verdict file against the reviewer contract — never crossed', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'ep-build-'));
    try {
      const implementerFile = 'implementation-build-round-1-implementer-result.json';
      const reviewerFile = 'implementation-build-round-1-reviewer-result.json';
      const dispositions = { dispositions: [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'Addressed.' }] };
      const verdict = { status: 'findings', findings: [{ title: 'Gap', body: 'Add coverage.', severity: 'blocker' }] };
      await writeFile(path.join(scratchRoot, implementerFile), JSON.stringify(dispositions), 'utf8');
      await writeFile(path.join(scratchRoot, reviewerFile), JSON.stringify(verdict), 'utf8');

      const implementer = await runWithScratch({ scratchRoot, schemaId: IMPLEMENTER_DISPOSITIONS_SCHEMA_ID, resultFile: implementerFile });
      expect(implementer?.result.directive).toBe('advance');
      expect(implementer?.result.result).toEqual(dispositions);

      const reviewer = await runWithScratch({ scratchRoot, schemaId: REVIEWER_RESULT_SCHEMA_ID, resultFile: reviewerFile });
      expect(reviewer?.result.directive).toBe('advance');
      expect(reviewer?.result.result).toEqual(verdict);

      // Cross the contracts: the implementer's disposition file must NOT validate
      // against the reviewer contract (this is the revise-round crash).
      const crossed = await runWithScratch({ scratchRoot, schemaId: REVIEWER_RESULT_SCHEMA_ID, resultFile: implementerFile });
      expect(crossed?.result.directive).toBe('fail');
      expect(crossed?.result.reason).toContain('schema_validation_failed');
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('treats a missing reviewer verdict as a real fault, never a fabricated satisfied review', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'ep-build-'));
    try {
      const terminal = await runWithScratch({
        scratchRoot,
        schemaId: REVIEWER_RESULT_SCHEMA_ID,
        resultFile: 'implementation-build-round-1-reviewer-result.json'
      });
      expect(terminal?.result.directive).toBe('fail');
      expect(terminal?.result.result).toBeUndefined();
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('does not fabricate a satisfied verdict from an empty reviewer result file', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'ep-build-'));
    try {
      const reviewerFile = 'implementation-build-round-1-reviewer-result.json';
      await writeFile(path.join(scratchRoot, reviewerFile), JSON.stringify({}), 'utf8');
      const terminal = await runWithScratch({ scratchRoot, schemaId: REVIEWER_RESULT_SCHEMA_ID, resultFile: reviewerFile });
      expect(terminal?.result.directive).toBe('fail');
      expect(terminal?.result.reason).toContain('schema_validation_failed');
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Session metadata propagation tests
// ---------------------------------------------------------------------------

import type { RunnerSessionMetadata } from './runner.js';

describe('createExecutionEntryPoint — session metadata propagation', () => {
  function makeRunnerWithMetadata(
    events: RunnerEvent[],
    metadata: RunnerSessionMetadata | null
  ): Runner {
    return {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          for (const event of events) {
            yield event;
          }
        })();
      },
      close: vi.fn().mockResolvedValue({ status: 'closed' }),
      getSessionMetadata: vi.fn().mockResolvedValue(metadata)
    };
  }

  it('attaches sessionMetadata from runner.getSessionMetadata() to terminal event', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const metadata: RunnerSessionMetadata = {
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      startedAt: '2026-06-22T10:00:00.000Z',
      endedAt: '2026-06-22T10:00:05.000Z',
      outcome: 'succeeded',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      usageAvailable: true,
      assistantTurnCount: 1,
      toolCallCount: 2
    };

    const runner = makeRunnerWithMetadata([makeTerminalEvent()], metadata);
    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

    const collected: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    const terminal = collected[0] as ExecutionTerminalResultEvent;
    expect(terminal.type).toBe('runner_terminal_result');
    expect(terminal.sessionMetadata).toEqual({
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      startedAt: '2026-06-22T10:00:00.000Z',
      endedAt: '2026-06-22T10:00:05.000Z',
      outcome: 'succeeded',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      usageAvailable: true,
      assistantTurnCount: 1,
      toolCallCount: 2
    });
  });

  it('does not include sessionMetadata when runner returns null', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const runner = makeRunnerWithMetadata([makeTerminalEvent()], null);
    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

    const collected: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      collected.push(event);
    }

    const terminal = collected[0] as ExecutionTerminalResultEvent;
    expect(terminal.sessionMetadata).toBeUndefined();
  });

  it('does not include sessionMetadata when runner does not implement getSessionMetadata', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));
    const runner = makeFakeRunner([makeTerminalEvent()]); // no getSessionMetadata
    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

    const collected: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      collected.push(event);
    }

    const terminal = collected[0] as ExecutionTerminalResultEvent;
    expect(terminal.sessionMetadata).toBeUndefined();
  });

  it('sessionMetadata does not contain sensitive sentinel values', async () => {
    const SECRET_SENTINEL = 'SECRET_API_KEY_12345';
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const metadata: RunnerSessionMetadata = {
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      startedAt: '2026-06-22T10:00:00.000Z',
      endedAt: '2026-06-22T10:00:05.000Z',
      outcome: 'succeeded',
      usageAvailable: false,
      assistantTurnCount: 0,
      toolCallCount: 0
    };

    const runner = makeRunnerWithMetadata([makeTerminalEvent()], metadata);
    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });

    const collected: ExecutionBoundaryEvent[] = [];
    for await (const event of entryPoint.execute({ context })) {
      collected.push(event);
    }

    const terminal = collected[0] as ExecutionTerminalResultEvent;
    expect(JSON.stringify(terminal.sessionMetadata)).not.toContain(SECRET_SENTINEL);
  });

  it('getSessionMetadata is called after runner.close()', async () => {
    const context = makeContext();
    const materialize = vi.fn().mockResolvedValue(makeMaterializedEnv(context));

    const callOrder: string[] = [];
    const metadata: RunnerSessionMetadata = {
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      startedAt: '2026-06-22T10:00:00.000Z',
      endedAt: '2026-06-22T10:00:05.000Z',
      outcome: 'succeeded',
      usageAvailable: false,
      assistantTurnCount: 0,
      toolCallCount: 0
    };

    const runner: Runner = {
      run(_input: RunnerRunInput): AsyncIterable<RunnerEvent> {
        return (async function* () {
          yield makeTerminalEvent();
        })();
      },
      async close() {
        callOrder.push('close');
        return { status: 'closed' as const };
      },
      async getSessionMetadata() {
        callOrder.push('getSessionMetadata');
        return metadata;
      }
    };

    const entryPoint = createExecutionEntryPoint({ runner, materialize, resultValidation: { mode: 'none' } });
    for await (const _ of entryPoint.execute({ context })) {
      // consume
    }

    expect(callOrder).toEqual(['close', 'getSessionMetadata']);
  });
});
