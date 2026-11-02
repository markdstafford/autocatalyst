/**
 * A scripted `ControlPlaneClient` for run list tests.
 *
 * It implements only the methods the run list uses (`listRuns`, `listProjects`) and
 * leaves the rest throwing, so tests exercise the real SDK interface without mocking
 * client internals. The run source is cursor-paged (cursor = next start index), with
 * an optional `pageSize` cap so paging can be driven with a small fixture, and a
 * failure queue so a single poll/page/initial call can be made to fail.
 */
import type { Project, ProjectListResponse, Run, RunListResponse } from '@autocatalyst/api-contract';
import { ControlPlaneClientError, type ControlPlaneClient, type ListRunsOptions } from '@autocatalyst/sdk';

export interface ScriptedClient {
  readonly client: ControlPlaneClient;
  /** Every `listRuns` call's options, in order. */
  readonly listRunsCalls: (ListRunsOptions | undefined)[];
  /** Count of `listProjects` calls. */
  listProjectsCalls: number;
  /** Replace the run source. */
  setRuns(runs: readonly Run[]): void;
  /** Replace the projects source. */
  setProjects(projects: readonly Project[]): void;
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

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`scripted client: ${name} is not implemented`);
  };
}

export function createScriptedClient(init?: { runs?: readonly Run[]; projects?: readonly Project[] }): ScriptedClient {
  let runs: readonly Run[] = init?.runs ?? [];
  let projects: readonly Project[] = init?.projects ?? [];
  let pageSize = Number.POSITIVE_INFINITY;
  const pendingErrors: unknown[] = [];
  const listRunsCalls: (ListRunsOptions | undefined)[] = [];

  const controller: ScriptedClient = {
    listProjectsCalls: 0,
    listRunsCalls,
    setRuns(next) {
      runs = next;
    },
    setProjects(next) {
      projects = next;
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
      },
      async listProjects(): Promise<ProjectListResponse> {
        controller.listProjectsCalls += 1;
        return { projects: [...projects] };
      },
      getHealth: notImplemented('getHealth'),
      createProbeResource: notImplemented('createProbeResource'),
      getProbeResource: notImplemented('getProbeResource'),
      createConfigurationRecord: notImplemented('createConfigurationRecord'),
      listConfigurationRecords: notImplemented('listConfigurationRecords'),
      getConfigurationRecord: notImplemented('getConfigurationRecord'),
      updateConfigurationRecord: notImplemented('updateConfigurationRecord'),
      deleteConfigurationRecord: notImplemented('deleteConfigurationRecord'),
      createSecret: notImplemented('createSecret'),
      createProject: notImplemented('createProject'),
      getProject: notImplemented('getProject'),
      updateProject: notImplemented('updateProject'),
      createConversationWithFirstRun: notImplemented('createConversationWithFirstRun'),
      getRun: notImplemented('getRun'),
      listRunSteps: notImplemented('listRunSteps'),
      getRunPullRequest: notImplemented('getRunPullRequest'),
      listRunSessions: notImplemented('listRunSessions'),
      subscribeRunEvents: notImplemented('subscribeRunEvents'),
      getRunSpec: notImplemented('getRunSpec'),
      createRunFeedback: notImplemented('createRunFeedback'),
      listRunFeedback: notImplemented('listRunFeedback'),
      appendRunFeedbackThreadReply: notImplemented('appendRunFeedbackThreadReply'),
      replyToRun: notImplemented('replyToRun'),
      recoverRun: notImplemented('recoverRun'),
      reconcilePullRequests: notImplemented('reconcilePullRequests')
    } as ControlPlaneClient
  };
  return controller;
}
