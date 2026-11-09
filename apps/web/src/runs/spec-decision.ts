/**
 * The pure decision logic behind the spec human-review gate's Approve / Request-changes
 * control, kept free of React and the SDK so the gating, counting, labelling, and error
 * shaping are unit-tested in isolation and reused by the gate button and its popover
 * without duplication.
 *
 * Spec comments live on the `artifact` feedback target, so every count helper here ignores
 * feedback for other targets (`implementation`, `docs`, `pr`). The gate's primary action is
 * `Approve` only when nothing artifact-targeted is still `open`; otherwise the operator is
 * requesting changes, and the label carries the open count. The approve popover separately
 * co-confirms the operator's own `addressed` comments — those authored by the current
 * principal (the originator is `thread[0].author.id`).
 *
 * {@link decisionErrorInfo} and {@link isFeedbackGateBlocked} shape a decision failure into a
 * safe display message plus the control-plane error code, so the UI can special-case the
 * `feedback_gate_blocked` rejection without leaking internal fault detail.
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';

/** The workflow step at which a run waits for the operator's spec decision. */
export const SPEC_GATE_STEP = 'spec.human_review';

/**
 * Decision button visible only when the run is *waiting* at the spec human-review gate.
 *
 * `currentStep === 'spec.human_review'` alone is not sufficient: a stale or derived run object
 * can retain that step while already terminal (`terminal: true`), in a finished `status`
 * (`done` | `failed` | `canceled`), or waiting on a non-human actor (`waitingOn` of `system` |
 * `ai` | `none`). Exposing Approve / Request-changes (and the originator-only Resolve / Reopen
 * controls that gate on this helper) against such a run would offer a decision the control plane
 * no longer accepts. The gate is available only when the run is at the step, not terminal, still
 * in progress, and waiting on the human operator.
 *
 * `status` and `waitingOn` are optional on the resource schema (persisted rows and event payloads
 * parse without them), so an absent value is treated as compatible and the authoritative checks
 * fall back to `terminal` plus the step. The control plane remains authoritative for the decision
 * itself; this is a client-side visibility guard only.
 */
export function isSpecGateDecisionAvailable(run: Run): boolean {
  return (
    run.currentStep === SPEC_GATE_STEP &&
    run.terminal === false &&
    (run.status === undefined || run.status === 'in_progress') &&
    (run.waitingOn === undefined || run.waitingOn === 'human')
  );
}

/** Count of artifact-target feedback with status 'open'. */
export function countOpenFeedback(feedback: readonly FeedbackResponse[]): number {
  return feedback.filter((item) => item.target === 'artifact' && item.status === 'open').length;
}

/** Count of artifact-target feedback with status 'addressed' | 'resolved' | 'wont_fix'. */
export function countResolvedFeedback(feedback: readonly FeedbackResponse[]): number {
  return feedback.filter(
    (item) =>
      item.target === 'artifact' &&
      (item.status === 'addressed' || item.status === 'resolved' || item.status === 'wont_fix')
  ).length;
}

/** 'Approve' when openCount === 0, otherwise `Request changes (N)`. */
export function decisionLabel(openCount: number): string {
  return openCount === 0 ? 'Approve' : `Request changes (${openCount})`;
}

/** The SDK reply kind implied by the open count. */
export function decisionKind(openCount: number): 'approve' | 'request_changes' {
  return openCount === 0 ? 'approve' : 'request_changes';
}

/**
 * Count of artifact-target 'addressed' feedback whose originator (thread[0].author.id)
 * is the current operator. Returns 0 when principalId is undefined (unknown identity).
 */
export function countAddressedByPrincipal(
  feedback: readonly FeedbackResponse[],
  principalId: string | undefined
): number {
  if (principalId === undefined) {
    return 0;
  }
  return feedback.filter((item) => {
    if (item.target !== 'artifact' || item.status !== 'addressed') {
      return false;
    }
    const originator = item.thread[0];
    return originator !== undefined && originator.author.id === principalId;
  }).length;
}

/**
 * The approve popover's co-confirmation copy, or undefined when count === 0.
 * EXACT text: `Approving also confirms ${count} of your addressed comments`
 */
export function addressedConfirmationCopy(count: number): string | undefined {
  if (count === 0) {
    return undefined;
  }
  return `Approving also confirms ${count} of your addressed comments`;
}

/**
 * Extract a safe display message and the control-plane error code from a decision error.
 * For a {@link ControlPlaneClientError} return the server's message and code; for anything
 * else return the fallback message and an undefined code.
 */
export function decisionErrorInfo(
  error: unknown,
  fallback = 'The request could not be completed.'
): { message: string; code: string | undefined } {
  if (error instanceof ControlPlaneClientError) {
    return { message: error.response.error.message, code: error.response.error.code };
  }
  return { message: fallback, code: undefined };
}

/** True when the decision error is the gate-blocked error (code 'feedback_gate_blocked'). */
export function isFeedbackGateBlocked(error: unknown): boolean {
  return decisionErrorInfo(error).code === 'feedback_gate_blocked';
}
