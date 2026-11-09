/**
 * The spec-gate decision button and its confirm popover.
 *
 * One button communicates the whole gate state: `Approve` when no comment is open, or
 * `Request changes (N)` when N comments are open. It renders only while the run waits at
 * `spec.human_review`. Activating it opens a confirm popover that names the action; confirming sends
 * exactly one existing run-reply operation (`approve` or `request_changes`) — never `createRunFeedback`.
 *
 * The decision is derived, not stored: the label comes from the live feedback list through the pure
 * helpers in `spec-decision.ts`, so it updates in place as comments change, and an open popover resets
 * whenever the label changes. Control-plane errors keep the popover open with the returned message;
 * `feedback_gate_blocked` shows the message, other errors also offer a retry. The button is disabled
 * while a decision is in flight so a second activation sends no second request.
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { useEffect, useState, type ReactNode } from 'react';

import {
  addressedConfirmationCopy,
  countAddressedByPrincipal,
  countOpenFeedback,
  decisionErrorInfo,
  decisionKind,
  decisionLabel,
  isFeedbackGateBlocked,
  isSpecGateDecisionAvailable
} from './spec-decision.js';
import type { RunActionResult } from './use-run-detail.js';
import { Button } from '../ui/button.js';
import { Popover } from '../ui/popover.js';

export interface SpecGateDecisionProps {
  readonly run: Run;
  readonly feedback: readonly FeedbackResponse[];
  readonly currentPrincipalId: string | undefined;
  onApprove(): Promise<RunActionResult>;
  onRequestChanges(): Promise<RunActionResult>;
  /** Popover placement side; defaults to 'bottom' (under the pane-bar button). */
  readonly side?: 'top' | 'bottom';
  /** Portal the confirm popover into this element; set to a node inside the focus-trapped overlay. */
  readonly popoverContainer?: HTMLElement | null;
}

interface DecisionError {
  readonly message: string;
  readonly retryable: boolean;
}

export function SpecGateDecision(props: SpecGateDecisionProps): ReactNode {
  const { run, feedback, currentPrincipalId, onApprove, onRequestChanges, side = 'bottom', popoverContainer } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DecisionError | null>(null);

  const available = isSpecGateDecisionAvailable(run);
  const openCount = countOpenFeedback(feedback);
  const kind = decisionKind(openCount);
  const label = decisionLabel(openCount);

  // Reset the popover whenever the computed label changes (comments created/resolved, revision
  // returned). A stale confirm must never apply to a changed gate.
  useEffect(() => {
    setOpen(false);
    setError(null);
    setBusy(false);
  }, [label]);

  if (!available) {
    return null;
  }

  async function confirm(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = kind === 'approve' ? await onApprove() : await onRequestChanges();
    if (result.status === 'ok') {
      // The run leaves the gate; close the popover (the button hides after the refresh).
      setBusy(false);
      setOpen(false);
      return;
    }
    const info = decisionErrorInfo(result.error);
    setBusy(false);
    setError({ message: info.message, retryable: !isFeedbackGateBlocked(result.error) });
  }

  const addressedCount = countAddressedByPrincipal(feedback, currentPrincipalId);
  const confirmCopy =
    kind === 'approve'
      ? addressedConfirmationCopy(addressedCount)
      : `This sends your ${openCount} open ${openCount === 1 ? 'comment' : 'comments'} back for revision.`;
  const confirmLabel = kind === 'approve' ? 'Approve' : 'Request changes';
  const prompt = kind === 'approve' ? 'Approve this spec?' : `Request changes on ${openCount} open ${openCount === 1 ? 'comment' : 'comments'}?`;

  // The Base UI Popover trigger owns the open/close toggle through `onOpenChange`; the button itself
  // carries no onClick so the two never fight over the controlled `open` state.
  const trigger = (
    <Button variant="primary" size="control-sm" data-testid="spec-gate-decision" className="tabular-nums">
      {label}
    </Button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
        }
      }}
      trigger={trigger}
      side={side}
      container={popoverContainer}
      label={prompt}
      data-testid="spec-gate-decision-popover"
    >
      <div
        className="w-64"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !busy) {
            event.preventDefault();
            void confirm();
          }
        }}
      >
        <p className="text-sm text-text">{prompt}</p>
        {confirmCopy !== undefined ? (
          <p data-testid="spec-gate-decision-copy" className="mt-1 text-xs text-subtext">
            {confirmCopy}
          </p>
        ) : null}
        {error !== null ? (
          <p data-testid="spec-gate-decision-error" className="mt-2 text-xs text-red">
            {error.message}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="control-sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="control-sm"
            data-testid="spec-gate-decision-confirm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void confirm()}
          >
            {error !== null && error.retryable ? 'Try again' : confirmLabel}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
