import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunnerEvent } from '@autocatalyst/api-contract';

import type { ResultCorrectionRequester } from './result-correction.js';
import type { Runner, RunnerCloseResult, RunnerRunInput } from './runner.js';

export interface StubRunnerOptions {
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly terminalResult?:
    | { readonly directive: 'advance' }
    | { readonly directive: 'needs_input'; readonly question?: string }
    | { readonly directive: 'fail'; readonly reason?: string };
  readonly resultFile?: { readonly relativePath: string; readonly value: unknown };
  readonly correctionResponses?: readonly unknown[];
}

export class StubRunner implements Runner {
  readonly #clock: () => string;
  readonly #eventIdGenerator: () => string;
  readonly #terminalResult: NonNullable<StubRunnerOptions['terminalResult']>;
  readonly #resultFile: StubRunnerOptions['resultFile'];
  readonly #correctionResponses: unknown[];
  readonly #correctionRequester: ResultCorrectionRequester;

  constructor(options: StubRunnerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#eventIdGenerator = options.eventIdGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);
    this.#terminalResult = options.terminalResult ?? { directive: 'advance' };
    this.#resultFile = options.resultFile;
    this.#correctionResponses = options.correctionResponses ? [...options.correctionResponses] : [];
    const queue = this.#correctionResponses;
    this.#correctionRequester = {
      async requestCorrection() {
        if (queue.length === 0) {
          throw new Error('StubRunner correction responses are exhausted.');
        }
        return queue.shift();
      }
    };
  }

  getCorrectionRequester(): ResultCorrectionRequester {
    return this.#correctionRequester;
  }

  async *run(input: RunnerRunInput): AsyncIterable<RunnerEvent> {
    const { environment } = input;
    const { run } = environment.context;
    const step = run.currentStep;
    const createdAt = this.#clock();

    // Event 1: progress - received task
    yield {
      id: this.#eventIdGenerator(),
      type: 'runner_progress',
      runId: run.id,
      step,
      importance: 'normal',
      createdAt,
      progress: {
        kind: 'intent',
        summary: `Stub runner received task for step: ${step}`
      }
    };

    // Event 2: assistant turn with deterministic text
    yield {
      id: this.#eventIdGenerator(),
      type: 'runner_assistant_turn',
      runId: run.id,
      step,
      importance: 'normal',
      createdAt: this.#clock(),
      message: {
        role: 'assistant',
        content: `Stub response for run ${run.id} at step ${step}.`
      }
    };

    // Event 3: step checkpoint with workspace/capability facts
    yield {
      id: this.#eventIdGenerator(),
      type: 'runner_step_checkpoint',
      runId: run.id,
      step,
      importance: 'low',
      createdAt: this.#clock(),
      checkpoint: {
        durable: true,
        name: 'stub_runner_checkpoint',
        data: {
          step,
          workspaceShape: environment.workspace.shape,
          workspaceRootCount: environment.workspace.workspaceRoots.length,
          shellAvailable: environment.capabilities.shell.available,
          lspAvailable: environment.capabilities.lsp.available
        }
      }
    };

    // Optionally write the scripted result file before the terminal event.
    await this.#writeResultFileIfConfigured(environment);

    // Event 4: terminal result
    yield {
      id: this.#eventIdGenerator(),
      type: 'runner_terminal_result',
      runId: run.id,
      step,
      importance: 'high',
      createdAt: this.#clock(),
      result: this.#buildResult()
    };
  }

  async close(): Promise<RunnerCloseResult> {
    return { status: 'closed' };
  }

  #buildResult(): { directive: 'advance' } | { directive: 'needs_input'; question?: string } | { directive: 'fail'; reason?: string } {
    return this.#terminalResult;
  }

  async #writeResultFileIfConfigured(environment: RunnerRunInput['environment']): Promise<void> {
    if (this.#resultFile === undefined) return;
    const scratchRoot =
      'scratchRoot' in environment.workspace ? environment.workspace.scratchRoot : undefined;
    if (scratchRoot === undefined) return;

    const candidate = path.resolve(scratchRoot, this.#resultFile.relativePath);
    const rootResolved = path.resolve(scratchRoot);
    const rel = path.relative(rootResolved, candidate);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('StubRunner resultFile path escapes scratch root.');
    }

    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, JSON.stringify(this.#resultFile.value), 'utf8');
  }
}
