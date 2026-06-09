import type { RunnerEvent } from '@autocatalyst/api-contract';
import type { Runner, RunnerCloseResult, RunnerRunInput } from './runner.js';

export interface StubRunnerOptions {
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly terminalResult?:
    | { readonly directive: 'advance' }
    | { readonly directive: 'needs_input'; readonly question?: string }
    | { readonly directive: 'fail'; readonly reason?: string };
}

export class StubRunner implements Runner {
  readonly #clock: () => string;
  readonly #eventIdGenerator: () => string;
  readonly #terminalResult: NonNullable<StubRunnerOptions['terminalResult']>;

  constructor(options: StubRunnerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#eventIdGenerator = options.eventIdGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);
    this.#terminalResult = options.terminalResult ?? { directive: 'advance' };
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
}
