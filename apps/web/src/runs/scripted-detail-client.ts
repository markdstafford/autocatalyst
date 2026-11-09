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
  CreateRunFeedbackRequest,
  Feedback,
  FeedbackResponse,
  Principal,
  PrincipalDiagnosticResponse,
  PullRequest,
  Run,
  RunFeedbackListResponse,
  RunPullRequestResponse,
  RunReplyRequest,
  RunReplyResponse,
  RunSessionListResponse,
  RunSpecResponse,
  Session,
  UpdateRunFeedbackRequest
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
  /** Set the markdown returned by a successful getRunSpec. */
  setSpecMarkdown(markdown: string): void;
  /** Set the feedback returned by listRunFeedback. */
  setFeedback(feedback: readonly FeedbackResponse[]): void;
  /**
   * Set the principal returned by getPrincipal. Passing `undefined` makes getPrincipal reject
   * (simulating an unknown-identity failure).
   */
  setPrincipal(principal: Principal | undefined): void;
  /** Make the next getPrincipal call reject with an unauthorized error, then resume. */
  failPrincipalOnce(): void;
  /** Make replyToRun reject with this error until cleared with a successful setter. */
  setReplyError(error: unknown): void;
  /** Make updateRunFeedback reject with this error. */
  setFeedbackUpdateError(error: unknown): void;
  /** Every replyToRun request, in order. */
  readonly replyCalls: RunReplyRequest[];
  /** Every updateRunFeedback call, in order. */
  readonly feedbackUpdateCalls: { feedbackId: string; request: UpdateRunFeedbackRequest }[];
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
    principal: number;
    reply: number;
    feedbackUpdate: number;
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
  let specMarkdown = '# Spec';
  let feedbackList: FeedbackResponse[] = [];
  // Default principal matches createRunFeedback's synthesized owner.
  let principal: Principal | undefined = { id: 'user-1', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' };
  let failPrincipalCount = 0;
  let replyError: unknown;
  let feedbackUpdateError: unknown;
  const replyCalls: RunReplyRequest[] = [];
  const feedbackUpdateCalls: { feedbackId: string; request: UpdateRunFeedbackRequest }[] = [];

  let gate: { promise: Promise<void>; resolve: () => void } | undefined;
  const subscribeErrors: unknown[] = [];
  const subscribeCalls: (RunEventsStreamOptions | undefined)[] = [];
  const streams: StreamHandle[] = [];
  const counts = { getRun: 0, pullRequest: 0, sessions: 0, spec: 0, subscribe: 0, principal: 0, reply: 0, feedbackUpdate: 0 };

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
        markdown: specMarkdown,
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
    async createRunFeedback(_id: string, request: CreateRunFeedbackRequest): Promise<Feedback> {
      const created: FeedbackResponse = {
        id: `fb-${feedbackList.length + 1}`,
        runId: run.id,
        owner: { id: 'user-1', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' },
        tenant: 'tenant-1',
        target: request.target,
        status: 'open',
        title: request.title,
        body: request.body,
        ...(request.anchor !== undefined ? { anchor: request.anchor as FeedbackResponse['anchor'] } : {}),
        thread: [{ id: 't1', author: { id: 'user-1', kind: 'human', tenantId: 'tenant-1' }, body: request.body, createdAt: '2026-11-08T00:00:00.000Z' }],
        createdAt: '2026-11-08T00:00:00.000Z',
        updatedAt: '2026-11-08T00:00:00.000Z'
      };
      feedbackList = [...feedbackList, created];
      return created as unknown as Feedback;
    },
    async listRunFeedback(): Promise<RunFeedbackListResponse> {
      await gated();
      return { feedback: [...feedbackList] };
    },
    async getPrincipal(): Promise<PrincipalDiagnosticResponse> {
      counts.principal += 1;
      await gated();
      if (failPrincipalCount > 0) {
        failPrincipalCount -= 1;
        throw unauthorizedError();
      }
      if (principal === undefined) {
        throw unauthorizedError();
      }
      return { principal };
    },
    async updateRunFeedback(_id: string, feedbackId: string, request: UpdateRunFeedbackRequest): Promise<FeedbackResponse> {
      counts.feedbackUpdate += 1;
      feedbackUpdateCalls.push({ feedbackId, request });
      await gated();
      if (feedbackUpdateError !== undefined) {
        throw feedbackUpdateError;
      }
      const index = feedbackList.findIndex((item) => item.id === feedbackId);
      const existing = feedbackList[index];
      if (existing === undefined) {
        throw notFoundError();
      }
      const updated: FeedbackResponse = { ...existing, status: request.status };
      feedbackList = feedbackList.map((item, i) => (i === index ? updated : item));
      return updated;
    },
    appendRunFeedbackThreadReply: notImplemented('appendRunFeedbackThreadReply'),
    async replyToRun(_id: string, request: RunReplyRequest): Promise<RunReplyResponse> {
      counts.reply += 1;
      replyCalls.push(request);
      await gated();
      if (replyError !== undefined) {
        throw replyError;
      }
      const directive = request.kind === 'approve' ? 'advance' : 'revise';
      return { run, classification: { directive } } as RunReplyResponse;
    },
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
    setSpecMarkdown(markdown) {
      specMarkdown = markdown;
    },
    setFeedback(next) {
      feedbackList = [...next];
    },
    setPrincipal(next) {
      principal = next;
    },
    failPrincipalOnce() {
      failPrincipalCount += 1;
    },
    setReplyError(error) {
      replyError = error;
    },
    setFeedbackUpdateError(error) {
      feedbackUpdateError = error;
    },
    replyCalls,
    feedbackUpdateCalls,
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
