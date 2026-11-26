/**
 * The detail-pane data hook: it coordinates the selected-run reads, the independent
 * Summary fact states, the Spec discriminator, and the selected-run event subscription
 * lifecycle, and feeds authoritative run reads back into the list state through
 * `replaceRun`.
 *
 * The selected run has one source of truth — the run list state. This hook never holds a
 * second authoritative run copy: the run it displays is the `run` prop (read from list
 * state), and every transition reread flows back through `replaceRun(run)`. The hook
 * owns the independent facts, the per-run Activity cache, and transient check feedback.
 *
 * Lifecycle, per ADR-031 (stateless client) and the spec's stream-first ordering:
 *  1. With the pane visible, subscribe (with the current
 *     cursor or retained replay), and wait for attachment before initial mutable reads so a
 *     transition that lands between attach and the first read is not missed. A hidden
 *     pane can still load selection facts without keeping a stream open.
 *  2. Transition and recovery frames are invalidation triggers: they coalesce into at most one
 *     trailing refresh while a refresh is in flight, so three quick transitions cause at
 *     most two refreshes.
 *  3. Reads and pull request checks belong to a selection, not to the stream. A check
 *     can supersede an older pull request read; all run updates go through replaceRun.
 *  4. Reconnect uses exponential backoff, resumes from the last frame id, and resets the
 *     backoff after any valid frame. A 409 cursor-loss clears the id, resubscribes
 *     without one, waits for attachment, then refreshes. A 401 stops and navigates to the
 *     connection page; a 404 stops and reports the run gone. An ended stream stops
 *     reconnecting only once the latest known run is terminal.
 */
import type { ControlPlaneClient } from '@autocatalyst/sdk';
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import type { FeedbackResponse, Run, RunStep, RunWorkflowResponse } from '@autocatalyst/api-contract';
import { useLayoutEffect, useRef, useState } from 'react';

import type { FrameReaderLogger } from './run-events-frame-reader.js';
import { readRunEventFrames } from './run-events-frame-reader.js';
import {
  classifyStreamError,
  RUN_EVENTS_RECONNECT_DELAY_MS,
  RUN_EVENTS_RECONNECT_MAX_DELAY_MS
} from './run-events-reconnect.js';
import { canCheckPullRequest, pullRequestCheckErrorMessage } from './pull-request-check.js';
import { RunActivityBuffer } from './run-activity-buffer.js';
import type { ActivityFacts, PullRequestCheck, PullRequestFact, SessionsFact, SpecDiscriminator } from './run-detail-facts.js';
import { isStrictlyNewer } from './run-row-merge.js';
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
  readonly principalId?: string | undefined;
  readonly authorized?: boolean;
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
  readonly specHandoff?: { readonly outcome: 'max_rounds' | 'oscillation'; readonly outstandingIds: readonly string[] };
  readonly guidancePause?:
    | { readonly kind: 'spec'; readonly stepId: string; readonly role: 'implementer' | 'reviewer'; readonly question: string }
    | { readonly kind: 'repair'; readonly stepId: string; readonly question: string };
  declineFinding?(feedbackId: string, reason: string): Promise<RunActionResult>;
  answerGuidance?(pauseStepId: string, body: string): Promise<RunActionResult>;
  readonly pullRequest: PullRequestFact;
  readonly pullRequestCheck: PullRequestCheck;
  readonly checkPullRequest?: () => void;
  readonly sessions: SessionsFact;
  readonly activity: ActivityFacts;
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
   * Decide a gate with the existing run-reply operation. On success the run/spec/feedback
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

function latestProjection(detailRun: Run | undefined, listRun: Run | undefined): Run | undefined {
  if (detailRun === undefined || detailRun.id !== listRun?.id) {
    return undefined;
  }
  return isStrictlyNewer(listRun, detailRun) ? listRun : detailRun;
}

function pullRequestIdentity(fact: PullRequestFact): string | undefined {
  return fact.status === 'success' ? fact.value?.id : undefined;
}

interface HeldRunDetail {
  workflow?: RunWorkflowResponse;
  steps?: readonly RunStep[];
  sessions?: Extract<SessionsFact, { status: 'success' }>;
  readonly buffer: RunActivityBuffer;
  cursor?: string | undefined;
  replayGap: boolean;
}

const emptyActivity: ActivityFacts = {
  workflow: { pending: true }, steps: { pending: true }, buffer: new RunActivityBuffer(),
  connection: 'connecting', replayGap: false
};

export function useRunDetail(options: UseRunDetailOptions): RunDetailState {
  const { client, run, visible, replaceRun, onUnauthorized, log, principalId, authorized = true } = options;
  const runId = run?.id;
  const baseDelayMs = options.reconnectDelayMs ?? RUN_EVENTS_RECONNECT_DELAY_MS;
  const maxDelayMs = options.reconnectMaxDelayMs ?? RUN_EVENTS_RECONNECT_MAX_DELAY_MS;

  const [pullRequest, setPullRequest] = useState<PullRequestFact>({ status: 'loading' });
  const [pullRequestCheck, setPullRequestCheck] = useState<PullRequestCheck>({});
  // For eligibility only; the list row remains the displayed run.
  const [projectedRun, setProjectedRun] = useState<Run>();
  const [sessions, setSessions] = useState<SessionsFact>({ status: 'loading' });
  const [activity, setActivity] = useState<ActivityFacts>(emptyActivity);
  const cacheRef = useRef<{ client: ControlPlaneClient; authorized: boolean; principalId: string | undefined; runs: Map<string, HeldRunDetail> } | undefined>(undefined);
  if (cacheRef.current === undefined || cacheRef.current.client !== client || cacheRef.current.authorized !== authorized ||
    (principalId !== undefined && cacheRef.current.principalId !== undefined && cacheRef.current.principalId !== principalId)) {
    cacheRef.current = { client, authorized, principalId, runs: new Map() };
  } else if (principalId !== undefined) {
    cacheRef.current.principalId = principalId;
  }
  const cache = cacheRef.current.runs;
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

  // Spec review state read inside the create-comment / reload callbacks.
  const specRef = useRef<SpecDiscriminator>(spec);
  specRef.current = spec;
  const selectionRef = useRef<{
    refresh(): void;
    readIfInitial(): void;
    skipSelectionCheck(): void;
    streamLoop(controller: AbortController): Promise<void>;
    check(): Promise<void>;
  } | undefined>(undefined);

  const currentStep = run?.currentStep;
  const steps = activity.steps.value ?? [];
  const activeStep = steps.reduce<RunStep | undefined>((latest, step) =>
    step.step === currentStep && step.endedAt === null && (!latest || step.occurrence.index > latest.occurrence.index)
      ? step : latest, undefined);
  const priorAuthor = activeStep && [...steps].sort((a, b) => b.occurrence.index - a.occurrence.index)
    .find(step => step.step === 'spec.author' && step.occurrence.index < activeStep.occurrence.index);
  const audit = priorAuthor?.checkpointResult as { producingStep?: string; outcome?: string; openFeedbackIds?: string[] } | null;
  const pause = (activeStep?.checkpointResult as { pause?: { kind?: string; role?: string; question?: string } } | null)?.pause;
  const specHandoff: RunDetailState['specHandoff'] = currentStep === 'spec.human_review' && audit?.producingStep === 'spec.author' &&
    (audit.outcome === 'max_rounds' || audit.outcome === 'oscillation')
    ? { outcome: audit.outcome, outstandingIds: audit.openFeedbackIds ?? [] } : undefined;
  const guidancePause: RunDetailState['guidancePause'] = currentStep === 'spec.awaiting_input' && activeStep && pause?.kind === 'spec_question' &&
    (pause.role === 'implementer' || pause.role === 'reviewer') && typeof pause.question === 'string'
    ? { kind: 'spec', stepId: activeStep.id, role: pause.role, question: pause.question }
    : currentStep === 'implementation.awaiting_input' && activeStep && pause?.kind === 'convergence_escalation' &&
      typeof pause.question === 'string' && activeStep.systemActivity?.some(entry => entry.kind === 'ci_guidance')
      ? { kind: 'repair', stepId: activeStep.id, question: pause.question } : undefined;

  useLayoutEffect(() => {
    if (runId === undefined || !authorized) {
      setActivity(emptyActivity);
      setSessions({ status: 'loading' });
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    // New selection (including A → B → A): all async work closes over this owner.
    const id = runId;
    const held: HeldRunDetail = cache.get(id) ?? { buffer: new RunActivityBuffer(), replayGap: false };
    cache.set(id, held);
    function publishActivity(patch: Partial<ActivityFacts> = {}): void {
      if (!signal.aborted) setActivity(previous => ({ ...previous, ...patch }));
    }
    setActivity({
      workflow: { pending: true, ...(held.workflow ? { value: held.workflow } : {}) },
      steps: { pending: true, ...(held.steps ? { value: held.steps } : {}) },
      buffer: held.buffer, connection: 'connecting', replayGap: held.replayGap
    });
    void (async () => {
      // A Strict Mode effect probe is cleaned up before starting its read.
      await Promise.resolve();
      if (signal.aborted) return;
      try {
        const workflow = await client.getRunWorkflow(id);
        if (signal.aborted) return;
        held.workflow = workflow;
        publishActivity({ workflow: { pending: false, value: workflow } });
      } catch (error: unknown) {
        publishActivity({ workflow: { pending: false, error: errorMessage(error, 'Workflow read failed.') } });
      }
    })();
    let refreshInFlight = false;
    let trailingRefresh = false;
    let initialRead = true;
    let skipSelectionCheck = false;
    let readRun: Run | undefined;
    let gone = false;
    let stopStream: (() => void) | undefined;
    let fact: PullRequestFact = { status: 'loading' };
    let checkInfo: PullRequestCheck = {};
    let checkInFlight = false;
    let checkVersion = 0; // Successful checks supersede GETs already in flight.
    setPullRequest(fact);
    setPullRequestCheck(checkInfo);
    setProjectedRun(undefined);
    setSessions(held.sessions ?? { status: 'loading' });
    setSpec(isSpecCapableWorkKind(runRef.current?.workKind ?? '') ? { status: 'loading' } : { status: 'no-spec' });
    setRunGone(false);

    function publishCheck(next: PullRequestCheck): void {
      checkInfo = next;
      setPullRequestCheck(next);
    }

    function publishFact(next: PullRequestFact): void {
      if (pullRequestIdentity(next) !== pullRequestIdentity(fact)) {
        publishCheck(checkInFlight ? { locked: true } : {});
      }
      fact = next;
      setPullRequest(next);
    }

    function applyRun(fresh: Run): void {
      if (readRun === undefined || isStrictlyNewer(fresh, readRun)) {
        readRun = fresh;
        setProjectedRun(fresh);
      }
      replaceRunRef.current(fresh);
    }

    async function check(): Promise<void> {
      if (
        signal.aborted || gone || checkInFlight ||
        !canCheckPullRequest(latestProjection(readRun, runRef.current), fact) ||
        fact.status !== 'success' || fact.value === null
      ) {
        return;
      }
      const pr = fact.value;
      checkInFlight = true;
      const { checkedAt } = checkInfo;
      const lastCheck = checkedAt === undefined ? {} : { checkedAt };
      publishCheck({ ...lastCheck, pending: true });
      // An intervening identity change clears the check info, even if that identity returns.
      const pendingInfo = checkInfo;
      const isCurrent = (): boolean => !signal.aborted && !gone && checkInfo === pendingInfo;
      try {
        const result = await client.refreshRunPullRequest(id);
        if (!isCurrent()) {
          return;
        }
        if (result.pullRequest.id !== pr.id || result.pullRequest.runId !== id || result.run.id !== id) {
          publishCheck(lastCheck);
          return;
        }
        if (
          fact.status === 'success' && fact.value !== null &&
          Date.parse(fact.value.updatedAt) <= Date.parse(result.pullRequest.updatedAt)
        ) {
          checkVersion += 1;
          publishFact({ status: 'success', value: result.pullRequest });
        }
        applyRun(result.run);
        publishCheck(
          result.pullRequest.state === 'open' && fact.status === 'success' && fact.value?.state === 'open'
            ? { checkedAt: new Date().toISOString() }
            : {}
        );
      } catch (error: unknown) {
        if (isCurrent()) {
          publishCheck({ ...lastCheck, error: pullRequestCheckErrorMessage(error) });
        }
      } finally {
        checkInFlight = false;
        if (!signal.aborted && checkInfo.locked) {
          publishCheck({});
        }
      }
    }

    function stopGone(): void {
      if (!signal.aborted) {
        gone = true;
        stopStream?.();
        setRunGone(true);
      }
    }

    async function refresh(): Promise<void> {
      if (signal.aborted || gone) {
        return;
      }
      if (refreshInFlight) {
        // Coalesce: one trailing refresh runs after the in-flight one completes.
        trailingRefresh = true;
        return;
      }
      refreshInFlight = true;
      const trySelectionCheck = initialRead;
      initialRead = false;
      const readVersion = checkVersion;
      const capableNow = isSpecCapableWorkKind(runRef.current?.workKind ?? '');

      const reads: Promise<void>[] = [];

      const runRead = client.getRun(id).then((fresh) => {
        if (signal.aborted || fresh.id !== id) {
          return undefined;
        }
        applyRun(fresh);
        publishActivity({ runError: undefined });
        return fresh;
      }).catch((error: unknown) => {
        if (isStatus(error, 404)) {
          stopGone();
        } else {
          publishActivity({ runError: errorMessage(error, 'Run read failed.') });
        }
        return undefined;
      });

      const prRead = client.getRunPullRequest(id).then(({ pullRequest: fresh }) => {
        if (!signal.aborted && readVersion === checkVersion && fresh.runId === id) {
          const stored = fact.status === 'success' ? fact.value : null;
          if (stored?.id !== fresh.id || Date.parse(fresh.updatedAt) > Date.parse(stored.updatedAt)) {
            publishFact({ status: 'success', value: fresh });
          }
          return true;
        }
        return false;
      }).catch((error: unknown) => {
        if (!signal.aborted && readVersion === checkVersion) {
          if (isStatus(error, 404)) {
            publishFact({ status: 'success', value: null });
          } else if (!checkInFlight || fact.status !== 'success' || fact.value === null) {
            // A transient GET error must not invalidate a check of an already loaded PR.
            publishFact({ status: 'error', message: errorMessage(error, 'Pull request could not be read.') });
          }
        }
        return false;
      });

      reads.push(Promise.all([runRead, prRead]).then(([loadedRun, loadedPr]) => {
        if (trySelectionCheck && !skipSelectionCheck && loadedPr && canCheckPullRequest(loadedRun, fact)) {
          void check();
        }
      }));

      publishActivity({ steps: { pending: true, ...(held.steps ? { value: held.steps } : {}) } });
      reads.push((async () => {
        try {
          const { steps } = await client.listRunSteps(id);
          if (signal.aborted) return;
          held.steps = steps;
          held.buffer.reconcile(steps);
          publishActivity({ steps: { pending: false, value: steps } });
        } catch (error: unknown) {
          publishActivity({ steps: { pending: false, ...(held.steps ? { value: held.steps } : {}),
            error: errorMessage(error, 'Steps read failed.') } });
        }
      })());

      reads.push(
        client
          .listRunSessions(id)
          .then((response) => {
            if (!signal.aborted) {
              held.sessions = { status: 'success', value: response.sessions,
                ...(response.costTotals === undefined ? {} : { runCost: response.costTotals.run }) };
              setSessions(held.sessions);
            }
          })
          .catch((error: unknown) => {
            if (!signal.aborted) {
              setSessions({ status: 'error', message: errorMessage(error, 'Sessions could not be read.'),
                ...(held.sessions ? { value: held.sessions.value } : {}) });
            }
          })
      );

      if (capableNow) {
        reads.push(
          (async () => {
            try {
              let specResp = await client.getRunSpec(id);
              let feedback = await listFeedbackSafe(id);
              // If a returned anchor falls outside the held markdown, reread spec+feedback once; any
              // anchor still out of bounds is then shown in the stale group by the classifier.
              if (hasOutOfBoundsArtifactAnchors(feedback, codePointLength(specResp.markdown))) {
                specResp = await client.getRunSpec(id);
                feedback = await listFeedbackSafe(id);
              }
              if (!signal.aborted) {
                setSpec({ status: 'ready', markdown: specResp.markdown, artifactId: specResp.artifact.id, feedback });
              }
            } catch (error: unknown) {
              if (signal.aborted) {
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
      refreshInFlight = false;
      if (trailingRefresh) {
        trailingRefresh = false;
        void refresh();
      }
    }

    function abortableDelay(ms: number, streamSignal: AbortSignal): Promise<void> {
      return new Promise((resolve) => {
        if (streamSignal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          streamSignal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        function onAbort(): void {
          clearTimeout(timer);
          resolve();
        }
        streamSignal.addEventListener('abort', onAbort, { once: true });
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

    async function streamLoop(controller: AbortController): Promise<void> {
      stopStream = () => controller.abort();
      const streamSignal = controller.signal;
      let backoff: number | undefined;
      let firstAttach = true;
      let recoverAfterAttach = false;
      publishActivity({ connection: 'connecting' });

      while (!streamSignal.aborted && !signal.aborted && !gone) {
        let body: ReadableStream<Uint8Array> | null = null;
        try {
          const { response } = await client.subscribeRunEvents(id, {
            ...(held.cursor ? { lastEventId: held.cursor } : { replay: 'retained' }),
            signal: streamSignal
          });
          if (streamSignal.aborted || signal.aborted) {
            return;
          }
          body = response.body;
        } catch (error) {
          if (streamSignal.aborted || signal.aborted) {
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
            if (!held.cursor) {
              publishActivity({ connection: 'ended' });
              if (initialRead) void refresh();
              return;
            }
            held.cursor = undefined;
            held.replayGap = true;
            publishActivity({ replayGap: true, connection: 'reconnecting' });
            recoverAfterAttach = true;
            backoff = undefined;
            continue;
          }
          if (initialRead) void refresh();
          publishActivity({ connection: 'reconnecting' });
          backoff = nextDelay(backoff);
          await abortableDelay(backoff, streamSignal);
          continue;
        }

        // Attached. Start the initial reads on first attach, or the recovery refresh
        // after a cursor-loss resubscribe.
        publishActivity({ connection: 'attached' });
        if (firstAttach || recoverAfterAttach) {
          firstAttach = false;
          recoverAfterAttach = false;
          void refresh();
        }

        try {
          if (body !== null) {
            const updateCursor = (id: string): void => {
              if (streamSignal.aborted || signal.aborted) return;
              held.cursor = id;
              backoff = undefined;
            };
            const log = logRef.current;
            for await (const frame of readRunEventFrames(body, { onCursor: updateCursor, ...(log ? { log } : {}) })) {
              if (streamSignal.aborted || signal.aborted) return;
              backoff = undefined;
              if (frame.id !== undefined) updateCursor(frame.id);
              if (frame.event.runId !== id) continue;
              const invalidated = frame.event.type === 'run_state_transition' || frame.event.type === 'run_recovery' ||
                (frame.event.type === 'runner_step_checkpoint' && frame.event.checkpoint.name === 'pr_ci_activity');
              const display = held.buffer.add(frame.event, held.steps ?? []);
              if (display || invalidated) publishActivity();
              if (invalidated) void refresh();
            }
          }
        } catch (error) {
          if (streamSignal.aborted || signal.aborted) {
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
            if (!held.cursor) {
              publishActivity({ connection: 'ended' });
              if (initialRead) void refresh();
              return;
            }
            held.cursor = undefined;
            held.replayGap = true;
            publishActivity({ replayGap: true, connection: 'reconnecting' });
            recoverAfterAttach = true;
            backoff = undefined;
            continue;
          }
          if (initialRead) void refresh();
          publishActivity({ connection: 'reconnecting' });
          backoff = nextDelay(backoff);
          await abortableDelay(backoff, streamSignal);
          continue;
        }

        // Stream ended cleanly. Stop reconnecting only once the latest run is terminal;
        // otherwise a recovery can reopen a failed run and the transition must be seen.
        if (streamSignal.aborted || signal.aborted) {
          return;
        }
        if ((latestProjection(readRun, runRef.current) ?? runRef.current)?.terminal) {
          publishActivity({ connection: 'ended' });
          return;
        }
        publishActivity({ connection: 'reconnecting' });
        backoff = nextDelay(backoff);
        await abortableDelay(backoff, streamSignal);
      }
    }


    selectionRef.current = {
      refresh: () => void refresh(),
      readIfInitial: () => {
        if (initialRead) {
          void refresh();
        }
      },
      skipSelectionCheck: () => { skipSelectionCheck = true; },
      streamLoop,
      check
    };
    return () => {
      controller.abort();
      selectionRef.current = undefined;
    };
  }, [client, cache, authorized, runId, baseDelayMs, maxDelayMs]);

  useLayoutEffect(() => {
    const selection = selectionRef.current;
    if (selection === undefined) {
      return;
    }
    if (!visible) {
      selection.readIfInitial();
      return;
    }
    const stream = new AbortController();
    void selection.streamLoop(stream);
    return () => stream.abort();
  }, [client, cache, authorized, runId, visible, baseDelayMs, maxDelayMs]);

  async function createSpecComment(input: CreateCommentInput): Promise<CreateCommentResult> {
    const currentSpec = specRef.current;
    const currentRunId = runId;
    const selection = selectionRef.current;
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
      if (selection === selectionRef.current) {
        // Insert the created feedback immediately so the card/marker appears without a reread.
        setSpec((previous) =>
          previous.status === 'ready'
            ? { ...previous, feedback: [...previous.feedback, created as unknown as FeedbackResponse] }
            : previous
        );
      }
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
    selectionRef.current?.refresh();
  }

  async function replyToGate(kind: 'approve' | 'request_changes'): Promise<RunActionResult> {
    const currentRunId = runId;
    const selection = selectionRef.current;
    if (currentRunId === undefined) {
      return { status: 'error', error: new Error('No run is selected.') };
    }
    if (kind === 'approve' && run?.currentStep === 'implementation.human_review') {
      // Even if the initial reads are delayed, a PR opened by this approval is manual-only.
      selection?.skipSelectionCheck();
    }
    try {
      await client.replyToRun(currentRunId, { kind });
      // Refresh immediately; the stream transition also triggers a refresh as the run moves.
      selection?.refresh();
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  async function resolveComment(feedbackId: string): Promise<RunActionResult> {
    const currentRunId = runId;
    const selection = selectionRef.current;
    if (currentRunId === undefined) {
      return { status: 'error', error: new Error('No run is selected.') };
    }
    try {
      await client.updateRunFeedback(currentRunId, feedbackId, { status: 'resolved' });
      selection?.refresh();
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  async function reopenComment(feedbackId: string, reason: string): Promise<RunActionResult> {
    const currentRunId = runId;
    const selection = selectionRef.current;
    if (currentRunId === undefined) {
      return { status: 'error', error: new Error('No run is selected.') };
    }
    try {
      await client.updateRunFeedback(currentRunId, feedbackId, { status: 'open', body: reason });
      selection?.refresh();
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  async function declineFinding(feedbackId: string, reason: string): Promise<RunActionResult> {
    if (runId === undefined) return { status: 'error', error: new Error('No run is selected.') };
    const selection = selectionRef.current;
    try {
      const updated = await client.updateRunFeedback(runId, feedbackId, { status: 'wont_fix', body: reason });
      if (selection === selectionRef.current) {
        setSpec(previous => previous.status === 'ready' ? {
          ...previous, feedback: previous.feedback.map(item => item.id === feedbackId ? updated : item)
        } : previous);
        selection?.refresh();
      }
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  async function answerGuidance(pauseStepId: string, body: string): Promise<RunActionResult> {
    if (runId === undefined) return { status: 'error', error: new Error('No run is selected.') };
    const selection = selectionRef.current;
    try {
      await client.replyToRun(runId, { kind: 'guidance', pauseStepId, body });
      selection?.refresh();
      return { status: 'ok' };
    } catch (error: unknown) {
      return { status: 'error', error };
    }
  }

  const selectedOwner = selectionRef.current;
  return {
    pullRequest,
    pullRequestCheck,
    ...(selectedOwner !== undefined && !runGone && canCheckPullRequest(latestProjection(projectedRun, run), pullRequest)
      ? { checkPullRequest: () => void selectedOwner.check() }
      : {}),
    sessions,
    activity,
    spec,
    runGone,
    createSpecComment,
    reloadSpec,
    replyToGate,
    resolveComment,
    reopenComment,
    declineFinding,
    answerGuidance,
    ...(specHandoff ? { specHandoff } : {}),
    ...(guidancePause ? { guidancePause } : {})
  };
}
