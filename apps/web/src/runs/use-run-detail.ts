/**
 * The detail-pane data hook: it coordinates the selected-run reads, the independent
 * Summary fact states, the Spec discriminator, and the selected-run event subscription
 * lifecycle, and feeds authoritative run reads back into the list state through
 * `replaceRun`.
 *
 * The selected run has one source of truth — the run list state. This hook never holds a
 * second authoritative run copy: the run it displays is the `run` prop (read from list
 * state), and every transition reread flows back through `replaceRun(run)`. The hook
 * owns only the facts that come from their own reads (pull request, sessions) and the
 * Spec discriminator.
 *
 * Lifecycle, per ADR-031 (stateless client) and the spec's stream-first ordering:
 *  1. On selection or pane show, abort any previous stream, subscribe (with the current
 *     cursor), and wait for the stream response to begin BEFORE the initial reads, so a
 *     transition that lands between attach and the first read is not missed.
 *  2. Transition frames are invalidation triggers: they coalesce into at most one
 *     trailing refresh while a refresh is in flight, so three quick transitions cause at
 *     most two refreshes.
 *  3. Every read is tagged with the run id and a refresh sequence; a result is applied
 *     only when both are still current, so a late read for a previous selection is
 *     dropped and a stale poll cannot revert a transition refresh.
 *  4. Reconnect uses exponential backoff, resumes from the last frame id, and resets the
 *     backoff after any valid frame. A 409 cursor-loss clears the id, resubscribes
 *     without one, waits for attachment, then refreshes. A 401 stops and navigates to the
 *     connection page; a 404 stops and reports the run gone. An ended stream stops
 *     reconnecting only once the latest known run is terminal.
 */
import type { ControlPlaneClient } from '@autocatalyst/sdk';
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { useEffect, useRef, useState } from 'react';

import type { FrameReaderLogger } from './run-events-frame-reader.js';
import { readRunEventFrames } from './run-events-frame-reader.js';
import {
  classifyStreamError,
  RUN_EVENTS_RECONNECT_DELAY_MS,
  RUN_EVENTS_RECONNECT_MAX_DELAY_MS
} from './run-events-reconnect.js';
import type { PullRequestFact, SessionsFact, SpecDiscriminator } from './run-detail-facts.js';
import { isSpecCapableWorkKind } from './run-spec-kinds.js';
import { codePointLength } from '../features/spec/code-points.js';
import { hasOutOfBoundsArtifactAnchors } from '../features/spec/spec-comments.js';
import type { CreateCommentInput, CreateCommentResult } from '../features/spec/spec-review.js';

export interface UseRunDetailOptions {
  readonly client: ControlPlaneClient;
  /** The selected run, read from the list state. Undefined hides the pane (no stream). */
  readonly run: Run | undefined;
  /** Whether the detail pane is shown. False closes the stream. */
  readonly visible: boolean;
  /** Push an authoritative `getRun` result back into the single source of truth. */
  replaceRun(run: Run): void;
  /** Called on a 401 from the stream: navigate to the connection page. */
  onUnauthorized(): void;
  /** Base reconnect delay seam (tests). */
  readonly reconnectDelayMs?: number;
  /** Max reconnect delay seam (tests). */
  readonly reconnectMaxDelayMs?: number;
  /** Dropped-frame logger seam. */
  readonly log?: FrameReaderLogger;
}

export interface RunDetailState {
  readonly pullRequest: PullRequestFact;
  readonly sessions: SessionsFact;
  readonly spec: SpecDiscriminator;
  /** True once the run is reported gone (a 404 on the stream or a reread). */
  readonly runGone: boolean;
  /**
   * Create an anchored spec comment through the SDK. On success the returned feedback is appended
   * to the spec state immediately (no reread). Returns a typed result so the composer can keep the
   * draft and show the right message on an invalid anchor or other error.
   */
  createSpecComment(input: CreateCommentInput): Promise<CreateCommentResult>;
  /** Reread the spec and its feedback (used after an invalid anchor or out-of-bounds offsets). */
  reloadSpec(): void;
  /**
   * Decide the spec gate with the existing run-reply operation. On success the run/spec/feedback
   * are refreshed and the stream follows the next run state; on failure the raw error is returned so
   * the caller can distinguish `feedback_gate_blocked` from other control-plane errors.
   */
  replyToGate(kind: 'approve' | 'request_changes'): Promise<RunActionResult>;
  /** Resolve an addressed comment (`updateRunFeedback` with `status: 'resolved'`), then refresh. */
  resolveComment(feedbackId: string): Promise<RunActionResult>;
  /** Reopen a declined comment with a reason (`updateRunFeedback` with `status: 'open'`), then refresh. */
  reopenComment(feedbackId: string, reason: string): Promise<RunActionResult>;
}

/** The outcome of a decision/lifecycle action: `ok`, or the raw error for the caller to classify. */
export type RunActionResult = { readonly status: 'ok' } | { readonly status: 'error'; readonly error: unknown };

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ControlPlaneClientError && error.status === status;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ControlPlaneClientError ? error.response.error.message : fallback;
}

export function useRunDetail(options: UseRunDetailOptions): RunDetailState {
  const { client, run, visible, replaceRun, onUnauthorized, log } = options;
  const runId = run?.id;
  const baseDelayMs = options.reconnectDelayMs ?? RUN_EVENTS_RECONNECT_DELAY_MS;
  const maxDelayMs = options.reconnectMaxDelayMs ?? RUN_EVENTS_RECONNECT_MAX_DELAY_MS;

  const [pullRequest, setPullRequest] = useState<PullRequestFact>({ status: 'loading' });
  const [sessions, setSessions] = useState<SessionsFact>({ status: 'loading' });
  const [spec, setSpec] = useState<SpecDiscriminator>({ status: 'loading' });
  const [runGone, setRunGone] = useState(false);

  // Refs read inside async callbacks without re-subscribing the effect.
  const runRef = useRef<Run | undefined>(run);
  runRef.current = run;
  const replaceRunRef = useRef(replaceRun);
  replaceRunRef.current = replaceRun;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const logRef = useRef(log);
  logRef.current = log;

  // Per-selection coordination.
  const runIdRef = useRef<string | undefined>(runId);
  const seqRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const trailingRefreshRef = useRef(false);
  const cursorRef = useRef<string | undefined>(undefined);
  const latestTerminalRef = useRef(false);

  // Spec review state read inside the create-comment / reload callbacks.
  const specRef = useRef<SpecDiscriminator>(spec);
  specRef.current = spec;
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!visible || runId === undefined || run === undefined) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    // New selection: reset coordination, cursor, and fact states.
    runIdRef.current = runId;
    seqRef.current = 0;
    refreshInFlightRef.current = false;
    trailingRefreshRef.current = false;
    cursorRef.current = undefined;
    latestTerminalRef.current = run.terminal;
    const capable = isSpecCapableWorkKind(run.workKind);
    setPullRequest({ status: 'loading' });
    setSessions({ status: 'loading' });
    setSpec(capable ? { status: 'loading' } : { status: 'no-spec' });
    setRunGone(false);

    /** A read result applies only if the selection and refresh sequence are still current. */
    function guard(thisRunId: string, thisSeq: number): boolean {
      return !signal.aborted && runIdRef.current === thisRunId && seqRef.current === thisSeq;
    }

    function stopGone(): void {
      if (!signal.aborted) {
        setRunGone(true);
      }
    }

    async function refresh(): Promise<void> {
      if (refreshInFlightRef.current) {
        // Coalesce: one trailing refresh runs after the in-flight one completes.
        trailingRefreshRef.current = true;
        return;
      }
      refreshInFlightRef.current = true;
      const thisRunId = runId as string;
      seqRef.current += 1;
      const thisSeq = seqRef.current;
      const capableNow = isSpecCapableWorkKind(runRef.current?.workKind ?? '');

      const reads: Promise<void>[] = [];

      reads.push(
        client
          .getRun(thisRunId)
          .then((fresh) => {
            if (guard(thisRunId, thisSeq)) {
              latestTerminalRef.current = fresh.terminal;
              replaceRunRef.current(fresh);
            }
          })
          .catch((error: unknown) => {
            if (isStatus(error, 404)) {
              stopGone();
            }
          })
      );

      reads.push(
        client
          .getRunPullRequest(thisRunId)
          .then((response) => {
            if (guard(thisRunId, thisSeq)) {
              setPullRequest({ status: 'success', value: response.pullRequest });
            }
          })
          .catch((error: unknown) => {
            if (!guard(thisRunId, thisSeq)) {
              return;
            }
            if (isStatus(error, 404)) {
              setPullRequest({ status: 'success', value: null });
            } else {
              setPullRequest({ status: 'error', message: errorMessage(error, 'Pull request could not be read.') });
            }
          })
      );

      reads.push(
        client
          .listRunSessions(thisRunId)
          .then((response) => {
            if (guard(thisRunId, thisSeq)) {
              setSessions({ status: 'success', value: response.sessions });
            }
          })
          .catch((error: unknown) => {
            if (guard(thisRunId, thisSeq)) {
              setSessions({ status: 'error', message: errorMessage(error, 'Sessions could not be read.') });
            }
          })
      );

      if (capableNow) {
        reads.push(
          (async () => {
            try {
              let specResp = await client.getRunSpec(thisRunId);
              let feedback = await listFeedbackSafe(thisRunId);
              // If a returned anchor falls outside the held markdown, reread spec+feedback once; any
              // anchor still out of bounds is then shown in the stale group by the classifier.
              if (hasOutOfBoundsArtifactAnchors(feedback, codePointLength(specResp.markdown))) {
                specResp = await client.getRunSpec(thisRunId);
                feedback = await listFeedbackSafe(thisRunId);
              }
              if (guard(thisRunId, thisSeq)) {
                setSpec({ status: 'ready', markdown: specResp.markdown, artifactId: specResp.artifact.id, feedback });
              }
            } catch (error: unknown) {
              if (!guard(thisRunId, thisSeq)) {
                return;
              }
              if (isStatus(error, 404)) {
                setSpec({ status: 'drafting' });
              } else {
                setSpec({ status: 'error', message: errorMessage(error, 'Spec could not be read.') });
              }
            }
          })()
        );
      }

      /** List artifact feedback, treating a read failure as "no feedback" so the spec still renders. */
      async function listFeedbackSafe(id: string): Promise<FeedbackResponse[]> {
        try {
          return [...(await client.listRunFeedback(id)).feedback];
        } catch {
          return [];
        }
      }

      await Promise.allSettled(reads);
      refreshInFlightRef.current = false;
      if (trailingRefreshRef.current && !signal.aborted && runIdRef.current === thisRunId) {
        trailingRefreshRef.current = false;
        void refresh();
      }
    }

    function abortableDelay(ms: number): Promise<void> {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        function onAbort(): void {
          clearTimeout(timer);
          resolve();
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    // Exponential backoff honoring the test seams: start at the base, double up to the
    // max. A valid frame resets the caller's `backoff` to undefined (back to the base).
    function nextDelay(current: number | undefined): number {
      if (current === undefined) {
        return baseDelayMs;
      }
      return Math.min(current * 2, maxDelayMs);
    }

    async function streamLoop(): Promise<void> {
      let backoff: number | undefined;
      let firstAttach = true;
      let recoverAfterAttach = false;

      while (!signal.aborted) {
        let body: ReadableStream<Uint8Array> | null = null;
        try {
          const cursor = cursorRef.current;
          const { response } = await client.subscribeRunEvents(runId as string, {
            ...(cursor !== undefined ? { lastEventId: cursor } : {}),
            signal
          });
          body = response.body;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          const reaction = classifyStreamError(error);
          if (reaction === 'unauthorized') {
            onUnauthorizedRef.current();
            return;
          }
          if (reaction === 'not_found') {
            stopGone();
            return;
          }
          if (reaction === 'cursor_lost') {
            cursorRef.current = undefined;
            recoverAfterAttach = true;
            backoff = undefined;
            continue;
          }
          backoff = nextDelay(backoff);
          await abortableDelay(backoff);
          continue;
        }

        // Attached. Start the initial reads on first attach, or the recovery refresh
        // after a cursor-loss resubscribe.
        if (firstAttach) {
          firstAttach = false;
          void refresh();
        } else if (recoverAfterAttach) {
          recoverAfterAttach = false;
          void refresh();
        }

        try {
          if (body !== null) {
            for await (const frame of readRunEventFrames(body, logRef.current === undefined ? {} : { log: logRef.current })) {
              if (signal.aborted) {
                return;
              }
              backoff = undefined; // a valid frame resets the backoff
              if (frame.id !== undefined) {
                cursorRef.current = frame.id;
              }
              if (frame.event.type === 'run_state_transition') {
                void refresh();
              }
            }
          }
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          const reaction = classifyStreamError(error);
          if (reaction === 'unauthorized') {
            onUnauthorizedRef.current();
            return;
          }
          if (reaction === 'not_found') {
            stopGone();
            return;
          }
          if (reaction === 'cursor_lost') {
            cursorRef.current = undefined;
            recoverAfterAttach = true;
            backoff = undefined;
            continue;
          }
          backoff = nextDelay(backoff);
          await abortableDelay(backoff);
          continue;
        }

        // Stream ended cleanly. Stop reconnecting only once the latest run is terminal;
        // otherwise a recovery can reopen a failed run and the transition must be seen.
        if (signal.aborted) {
          return;
        }
        if (latestTerminalRef.current) {
          return;
        }
        backoff = nextDelay(backoff);
        await abortableDelay(backoff);
      }
    }


    // Expose a reload hook that rereads spec + feedback (and the other facts) on demand.
    refreshRef.current = () => {
      void refresh();
    };

    void streamLoop();

    return () => {
      controller.abort();
    };
    // The stream lifecycle keys only on the selected run id and visibility; other run
    // fields are read through refs so a row update never tears down the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, runId, visible]);

  async function createSpecComment(input: CreateCommentInput): Promise<CreateCommentResult> {
    const currentSpec = specRef.current;
    const currentRunId = runIdRef.current;
    if (currentSpec.status !== 'ready' || currentRunId === undefined) {
      return { status: 'error', message: 'The spec is not ready for comments.' };
    }
    try {
      const created = await client.createRunFeedback(currentRunId, {
        target: 'artifact',
        title: input.title,
        body: input.body,
        anchor: {
          kind: 'artifact_range',
          artifactId: currentSpec.artifactId,
          from: input.from,
          to: input.to,
          quotedText: input.quotedText
        }
      });
      // Insert the created feedback immediately so the card/marker appears without a reread.
      setSpec((previous) =>
        previous.status === 'ready'
          ? { ...previous, feedback: [...previous.feedback, created as unknown as FeedbackResponse] }
          : previous
      );
      return { status: 'created' };
    } catch (error: unknown) {
      if (
        error instanceof ControlPlaneClientError &&
        error.status === 422 &&
        error.response.error.code === 'invalid_feedback_anchor'
      ) {
        return { status: 'invalid_anchor' };
      }
      return { status: 'error', message: errorMessage(error, 'The comment could not be created.') };
    }
  }

  function reloadSpec(): void {
    refreshRef.current();
  }

  async function replyToGate(kind: 'approve' | 'request_changes'): Promise<RunActionResult> {
    const currentRunId = runIdRef.current;
    if (currentRunId === undefined) {
      return { status: 'error', error: new Error('No run is selected.') };
    }
    try {
      await client.replyToRun(currentRunId, { kind });
      // Refresh immediately; the stream transition also triggers a refresh as the run moves.
      refreshRef.current();
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  async function resolveComment(feedbackId: string): Promise<RunActionResult> {
    const currentRunId = runIdRef.current;
    if (currentRunId === undefined) {
      return { status: 'error', error: new Error('No run is selected.') };
    }
    try {
      await client.updateRunFeedback(currentRunId, feedbackId, { status: 'resolved' });
      refreshRef.current();
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  async function reopenComment(feedbackId: string, reason: string): Promise<RunActionResult> {
    const currentRunId = runIdRef.current;
    if (currentRunId === undefined) {
      return { status: 'error', error: new Error('No run is selected.') };
    }
    try {
      await client.updateRunFeedback(currentRunId, feedbackId, { status: 'open', body: reason });
      refreshRef.current();
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  return {
    pullRequest,
    sessions,
    spec,
    runGone,
    createSpecComment,
    reloadSpec,
    replyToGate,
    resolveComment,
    reopenComment
  };
}
