import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import type { InferenceSettings, ModelIdentity, TokenBreakdown, RunnerEvent } from '@autocatalyst/api-contract';

export type RunnerProtocolErrorCode =
  | 'invalid_event'
  | 'wrong_run'
  | 'duplicate_terminal_result'
  | 'event_after_terminal'
  | 'missing_terminal_result'
  | 'runner_failed'
  | 'runner_close_failed';

export class RunnerProtocolError extends Error {
  readonly code: RunnerProtocolErrorCode;
  readonly details?: unknown;

  constructor(code: RunnerProtocolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RunnerProtocolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface RunnerCloseResult {
  readonly status: 'closed';
}

export interface RunnerRunInput {
  readonly environment: MaterializedExecutionEnvironment;
  readonly correlationId?: string;
}

export interface RunnerSessionMetadata {
  readonly model: ModelIdentity;
  readonly inferenceSettings: InferenceSettings;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  readonly tokens?: TokenBreakdown;
  readonly usageAvailable?: boolean;
  readonly assistantTurnCount?: number;
  readonly toolCallCount?: number;
}

export interface Runner {
  run(input: RunnerRunInput): AsyncIterable<RunnerEvent>;
  close(): Promise<RunnerCloseResult>;
  getSessionMetadata?(): Promise<RunnerSessionMetadata | null>;
}
