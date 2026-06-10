import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunnerEvent } from '@autocatalyst/api-contract';

import type { ResultCorrectionRequester } from './result-correction.js';
import { isFinalWriteTargetSafe, resolveScratchRootCandidatePath } from './result-file.js';
import type { Runner, RunnerCloseResult, RunnerRunInput } from './runner.js';
import type {
  NotifyToolInput,
  ReportProgressToolInput,
  UpdatePlanToolInput
} from './runner-progress-tools.js';

export type StubRunnerProgressSignal =
  | { readonly tool: 'update_plan'; readonly input: UpdatePlanToolInput }
  | { readonly tool: 'report_progress'; readonly input: ReportProgressToolInput }
  | { readonly tool: 'notify'; readonly input: NotifyToolInput };

export type StubRunnerMalformedProgressPayload =
  | { readonly degradeAs: 'omit'; readonly payload: unknown }
  | { readonly degradeAs: 'coarse_progress'; readonly summary: string; readonly payload: unknown }
  | {
      readonly degradeAs: 'notification_without_importance';
      readonly message: string;
      readonly severity?: 'debug' | 'info' | 'warn' | 'error';
      readonly payload: unknown;
    };

export interface StubRunnerOptions {
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly terminalResult?:
    | { readonly directive: 'advance' }
    | { readonly directive: 'needs_input'; readonly question?: string }
    | { readonly directive: 'fail'; readonly reason?: string };
  readonly resultFile?: { readonly relativePath: string; readonly value: unknown };
  readonly correctionResponses?: readonly unknown[];
  readonly progressSignals?: readonly StubRunnerProgressSignal[];
  readonly malformedProgressSignals?: readonly StubRunnerMalformedProgressPayload[];
}

export class StubRunner implements Runner {
  readonly #clock: () => string;
  readonly #eventIdGenerator: () => string;
  readonly #terminalResult: NonNullable<StubRunnerOptions['terminalResult']>;
  readonly #resultFile: StubRunnerOptions['resultFile'];
  readonly #correctionResponses: unknown[];
  readonly #correctionRequester: ResultCorrectionRequester;
  readonly #progressSignals: readonly StubRunnerProgressSignal[];
  readonly #malformedProgressSignals: readonly StubRunnerMalformedProgressPayload[];

  constructor(options: StubRunnerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#eventIdGenerator = options.eventIdGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);
    this.#terminalResult = options.terminalResult ?? { directive: 'advance' };
    this.#resultFile = options.resultFile;
    this.#correctionResponses = options.correctionResponses ? [...options.correctionResponses] : [];
    this.#progressSignals = options.progressSignals ?? [];
    this.#malformedProgressSignals = options.malformedProgressSignals ?? [];
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

    // Emit scripted progress tool signals first.
    for (const signal of this.#progressSignals) {
      const event = this.#progressSignalToEvent(signal, run.id, step);
      if (event !== null) yield event;
    }

    // Emit malformed/degraded progress payloads.
    for (const malformed of this.#malformedProgressSignals) {
      const event = this.#malformedProgressToEvent(malformed, run.id, step);
      if (event !== null) yield event;
    }

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

  #progressSignalToEvent(signal: StubRunnerProgressSignal, runId: string, step: string): RunnerEvent | null {
    const base = {
      id: this.#eventIdGenerator(),
      runId,
      step,
      createdAt: this.#clock()
    };
    if (signal.tool === 'update_plan') {
      return {
        ...base,
        type: 'runner_progress',
        importance: 'normal',
        progress: { kind: 'plan', title: signal.input.title, steps: [...signal.input.steps] }
      } as RunnerEvent;
    }
    if (signal.tool === 'report_progress') {
      const { completed, total, label, summary } = signal.input;
      if (completed !== undefined && total !== undefined && label !== undefined) {
        return {
          ...base,
          type: 'runner_progress',
          importance: 'normal',
          progress: { kind: 'task_progress', label, completed, total }
        } as RunnerEvent;
      }
      if (summary !== undefined) {
        return {
          ...base,
          type: 'runner_progress',
          importance: 'normal',
          progress: { kind: 'intent', summary }
        } as RunnerEvent;
      }
      return null;
    }
    // notify
    const importance = signal.input.importance ?? 'normal';
    return {
      ...base,
      type: 'runner_notification',
      importance,
      notification: { severity: signal.input.severity ?? 'info', message: signal.input.message }
    } as RunnerEvent;
  }

  #malformedProgressToEvent(p: StubRunnerMalformedProgressPayload, runId: string, step: string): RunnerEvent | null {
    if (p.degradeAs === 'omit') return null;
    const base = {
      id: this.#eventIdGenerator(),
      runId,
      step,
      createdAt: this.#clock()
    };
    if (p.degradeAs === 'coarse_progress') {
      return {
        ...base,
        type: 'runner_progress',
        importance: 'low',
        progress: { kind: 'intent', summary: p.summary }
      } as RunnerEvent;
    }
    return {
      ...base,
      type: 'runner_notification',
      importance: 'normal',
      notification: { severity: p.severity ?? 'info', message: p.message }
    } as RunnerEvent;
  }

  async #writeResultFileIfConfigured(environment: RunnerRunInput['environment']): Promise<void> {
    if (this.#resultFile === undefined) return;
    const scratchRoot =
      'scratchRoot' in environment.workspace ? environment.workspace.scratchRoot : undefined;
    if (scratchRoot === undefined) return;

    // Use the same realpath-based containment as readScratchStepResultFile so symlinked
    // directories inside scratchRoot cannot redirect the write outside it.
    const resolution = await resolveScratchRootCandidatePath(scratchRoot, this.#resultFile.relativePath);
    if (resolution === null) {
      throw new Error('StubRunner resultFile path escapes scratch root.');
    }

    // Reject an existing symlink at the final write target that resolves outside scratchRoot.
    const writeSafe = await isFinalWriteTargetSafe(resolution.resolvedCandidate, resolution.rootRealPath);
    if (!writeSafe) {
      throw new Error('StubRunner resultFile path escapes scratch root.');
    }

    try {
      await mkdir(path.dirname(resolution.resolvedCandidate), { recursive: true });
      await writeFile(resolution.resolvedCandidate, JSON.stringify(this.#resultFile.value), 'utf8');
    } catch {
      // Never surface a raw filesystem error (which may carry a host path) from the stub.
      throw new Error('StubRunner could not write the result file safely.');
    }
  }
}
