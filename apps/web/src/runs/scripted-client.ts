/**
 * A scripted `ControlPlaneClient` for run list tests.
 *
 * It implements the SDK listRuns method so tests exercise the public interface
 * without mocking client internals. The run source is cursor-paged (cursor = next start index), with
 * an optional `pageSize` cap so paging can be driven with a small fixture, and a
 * failure queue so a single poll/page/initial call can be made to fail.
 */
import type { Run, RunListResponse } from '@autocatalyst/api-contract';
import { ControlPlaneClientError, type ControlPlaneClient } from '@autocatalyst/sdk';

type ListRunsOptions = NonNullable<Parameters<ControlPlaneClient['listRuns']>[0]>;

export interface ScriptedClient {
  readonly client: Pick<ControlPlaneClient, 'listRuns'>;
  /** Every `listRuns` call's options, in order. */
  readonly listRunsCalls: (ListRunsOptions | undefined)[];
  /** Replace the run source. */
  setRuns(runs: readonly Run[]): void;
  /** Cap page size regardless of the requested limit (forces paging). */
  setPageSize(size: number): void;
  /** Make the next N `listRuns` calls reject with this error, then resume. */
  failRunsOnce(error: unknown): void;
}

/** A 401 error shaped like the SDK's. */
export function unauthorizedError(): ControlPlaneClientError {
  return new ControlPlaneClientError(401, { error: { code: 'unauthorized', message: 'Unauthorized' } });
}

/** A 400 error shaped like the SDK's (e.g. invalid cursor). */
export function validationError(): ControlPlaneClientError {
  return new ControlPlaneClientError(400, { error: { code: 'validation_error', message: 'Malformed cursor.' } });
}

export function createScriptedClient(init?: { runs?: readonly Run[] }): ScriptedClient {
  let runs: readonly Run[] = init?.runs ?? [];
  let pageSize = Number.POSITIVE_INFINITY;
  const pendingErrors: unknown[] = [];
  const listRunsCalls: (ListRunsOptions | undefined)[] = [];

  const controller: ScriptedClient = {
    listRunsCalls,
    setRuns(next) {
      runs = next;
    },
    setPageSize(size) {
      pageSize = size;
    },
    failRunsOnce(error) {
      pendingErrors.push(error);
    },
    client: {
      async listRuns(options?: ListRunsOptions): Promise<RunListResponse> {
        listRunsCalls.push(options);
        if (pendingErrors.length > 0) {
          throw pendingErrors.shift();
        }
        const start = options?.cursor !== undefined ? Number(options.cursor) : 0;
        const requested = options?.limit ?? runs.length;
        const limit = Math.min(requested, pageSize);
        const slice = runs.slice(start, start + limit);
        const end = start + slice.length;
        const nextCursor = end < runs.length ? String(end) : undefined;
        return { runs: [...slice], ...(nextCursor !== undefined ? { nextCursor } : {}) };
      }
    }
  };
  return controller;
}
