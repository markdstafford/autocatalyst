/**
 * A scripted `ControlPlaneClient` for the detail-pane hook tests.
 *
 * It implements the five methods `useRunDetail` uses (`getRun`, `getRunPullRequest`,
 * `listRunSessions`, `getRunSpec`, `subscribeRunEvents`) and leaves the rest throwing, so
 * tests drive the real SDK interface. The reads are controllable (fixed values, queued
 * errors, and an optional gate that holds every read until released, so a test can keep a
 * refresh in flight while it delivers frames). Each `subscribeRunEvents` call creates a
 * controllable SSE stream the test pushes frames into, closes, or errors; the returned
 * `Response` body is a real `ReadableStream`, and an aborted signal errors that stream so
 * the reader wakes exactly as it would when a real fetch is aborted.
 */
import type {
  PullRequest,
  Run,
  RunPullRequestResponse,
  RunSessionListResponse,
  RunSpecResponse,
  Session
} from '@autocatalyst/api-contract';
import {
  ControlPlaneClientError,
  type ControlPlaneClient,
  type RunEventsResponse,
  type RunEventsStreamOptions
} from '@autocatalyst/sdk';

import { makeRun, makeTransitionEvent } from './run-fixtures.js';

export interface FakeStream {
  /** Push one already-formatted SSE chunk (e.g. a full `id:`/`event:`/`data:` frame). */
  push(chunk: string): void;
  /** Push a `run_state_transition` frame for the given run with the given SSE id. */
  pushTransition(input: { id: string; run?: Run }): void;
  /** End the stream cleanly. */
  close(): void;
  /** Error the stream (mid-stream failure). */
  error(reason: unknown): void;
  /** Whether the stream has been closed or errored (e.g. aborted). */
  readonly closed: boolean;
  readonly options: RunEventsStreamOptions | undefined;
}

export interface ScriptedDetailClient {
  readonly client: ControlPlaneClient;
  // Read sources.
  setRun(run: Run): void;
  setRunError(error: unknown): void;
  setPullRequest(value: PullRequest | null): void;
  setPullRequestError(error: unknown): void;
  setSessions(value: readonly Session[]): void;
  setSessionsError(error: unknown): void;
  /** 'ready' => getRunSpec resolves; 'drafting' => 404; an error => rejects. */
  setSpec(outcome: 'ready' | 'drafting'): void;
  setSpecError(error: unknown): void;
  // Gate: hold reads until released (to keep a refresh in flight).
  hold(): void;
  release(): void;
  // Subscribe control.
  /** Make the next N subscribe calls reject with this error. */
  failSubscribeOnce(error: unknown): void;
  readonly subscribeCalls: (RunEventsStreamOptions | undefined)[];
  readonly streams: FakeStream[];
  latestStream(): FakeStream | undefined;
  // Call counters.
  readonly counts: {
    getRun: number;
    pullRequest: number;
    sessions: number;
    spec: number;
    subscribe: number;
  };
}

export function notFoundError(): ControlPlaneClientError {
  return new ControlPlaneClientError(404, { error: { code: 'not_found', message: 'Not found.' } });
}

export function unauthorizedError(): ControlPlaneClientError {
  return new ControlPlaneClientError(401, { error: { code: 'unauthorized', message: 'Unauthorized.' } });
}

export function cursorExpiredError(): ControlPlaneClientError {
  return new ControlPlaneClientError(409, {
    error: { code: 'run_event_replay_cursor_expired', message: 'Cursor expired.' }
  });
}

export function cursorUnknownError(): ControlPlaneClientError {
  return new ControlPlaneClientError(409, {
    error: { code: 'run_event_replay_cursor_unknown', message: 'Cursor unknown.' }
  });
}

export function serverError(): ControlPlaneClientError {
  return new ControlPlaneClientError(500, { error: { code: 'internal', message: 'Boom.' } });
}

function notImplemented(name: string): () => never {
  return () => {
    throw new Error(`scripted detail client: ${name} is not implemented`);
  };
}

interface StreamHandle extends FakeStream {
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  closed: boolean;
}

export function createScriptedDetailClient(init?: { run?: Run }): ScriptedDetailClient {
  const encoder = new TextEncoder();
  let run: Run = init?.run ?? makeRun();
  let runError: unknown;
  let pullRequest: PullRequest | null = null;
  let pullRequestError: unknown;
  let sessions: readonly Session[] = [];
  let sessionsError: unknown;
  let specOutcome: 'ready' | 'drafting' = 'drafting';
  let specError: unknown;

  let gate: { promise: Promise<void>; resolve: () => void } | undefined;
  const subscribeErrors: unknown[] = [];
  const subscribeCalls: (RunEventsStreamOptions | undefined)[] = [];
  const streams: StreamHandle[] = [];
  const counts = { getRun: 0, pullRequest: 0, sessions: 0, spec: 0, subscribe: 0 };

  async function gated(): Promise<void> {
    if (gate !== undefined) {
      await gate.promise;
    }
  }

  function makeStream(options: RunEventsStreamOptions | undefined): StreamHandle {
    const handle: StreamHandle = {
      controller: undefined,
      closed: false,
      options,
      push(chunk: string) {
        if (!this.closed && this.controller !== undefined) {
          this.controller.enqueue(encoder.encode(chunk));
        }
      },
      pushTransition(input) {
        const event = makeTransitionEvent({ id: input.id, run: input.run ?? run });
        this.push(`id: ${input.id}\nevent: run_state_transition\ndata: ${JSON.stringify(event)}\n\n`);
      },
      close() {
        if (!this.closed && this.controller !== undefined) {
          this.closed = true;
          this.controller.close();
        }
      },
      error(reason: unknown) {
        if (!this.closed && this.controller !== undefined) {
          this.closed = true;
          this.controller.error(reason);
        }
      }
    };
    return handle;
  }

  const client: ControlPlaneClient = {
    async getRun(): Promise<Run> {
      counts.getRun += 1;
      await gated();
      if (runError !== undefined) {
        throw runError;
      }
      return run;
    },
    async getRunPullRequest(): Promise<RunPullRequestResponse> {
      counts.pullRequest += 1;
      await gated();
      if (pullRequestError !== undefined) {
        throw pullRequestError;
      }
      if (pullRequest === null) {
        throw notFoundError();
      }
      return { pullRequest };
    },
    async listRunSessions(): Promise<RunSessionListResponse> {
      counts.sessions += 1;
      await gated();
      if (sessionsError !== undefined) {
        throw sessionsError;
      }
      return { sessions: [...sessions] };
    },
    async getRunSpec(): Promise<RunSpecResponse> {
      counts.spec += 1;
      await gated();
      if (specError !== undefined) {
        throw specError;
      }
      if (specOutcome === 'drafting') {
        throw notFoundError();
      }
      // A minimal valid-enough spec response; the hook only cares that it resolved.
      return {
        artifact: { id: 'artifact-1', kind: 'feature_spec' } as unknown as RunSpecResponse['artifact'],
        markdown: '# Spec',
        frontmatter: {} as unknown as RunSpecResponse['frontmatter']
      };
    },
    async subscribeRunEvents(_id: string, options?: RunEventsStreamOptions): Promise<RunEventsResponse> {
      counts.subscribe += 1;
      subscribeCalls.push(options);
      if (subscribeErrors.length > 0) {
        throw subscribeErrors.shift();
      }
      const handle = makeStream(options);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          handle.controller = controller;
          // The control plane's first bytes are the keep-alive comment.
          controller.enqueue(encoder.encode(': connected\n\n'));
        }
      });
      if (options?.signal !== undefined) {
        const signal = options.signal;
        const onAbort = (): void => {
          handle.error(new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      streams.push(handle);
      return { kind: 'response' as const, response: new Response(stream) };
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
    listProjects: notImplemented('listProjects'),
    getProject: notImplemented('getProject'),
    updateProject: notImplemented('updateProject'),
    createConversationWithFirstRun: notImplemented('createConversationWithFirstRun'),
    listRuns: notImplemented('listRuns'),
    listRunSteps: notImplemented('listRunSteps'),
    createRunFeedback: notImplemented('createRunFeedback'),
    listRunFeedback: notImplemented('listRunFeedback'),
    appendRunFeedbackThreadReply: notImplemented('appendRunFeedbackThreadReply'),
    replyToRun: notImplemented('replyToRun'),
    recoverRun: notImplemented('recoverRun'),
    reconcilePullRequests: notImplemented('reconcilePullRequests')
  } as ControlPlaneClient;

  return {
    client,
    setRun(next) {
      run = next;
      runError = undefined;
    },
    setRunError(error) {
      runError = error;
    },
    setPullRequest(value) {
      pullRequest = value;
      pullRequestError = undefined;
    },
    setPullRequestError(error) {
      pullRequestError = error;
    },
    setSessions(value) {
      sessions = value;
      sessionsError = undefined;
    },
    setSessionsError(error) {
      sessionsError = error;
    },
    setSpec(outcome) {
      specOutcome = outcome;
      specError = undefined;
    },
    setSpecError(error) {
      specError = error;
    },
    hold() {
      if (gate === undefined) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        gate = { promise, resolve };
      }
    },
    release() {
      if (gate !== undefined) {
        gate.resolve();
        gate = undefined;
      }
    },
    failSubscribeOnce(error) {
      subscribeErrors.push(error);
    },
    subscribeCalls,
    streams,
    latestStream() {
      return streams[streams.length - 1];
    },
    counts
  };
}
