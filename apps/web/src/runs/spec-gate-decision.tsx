/**
 * Gate-specific rules compose a shared confirmation popover. Spec approval can
 * co-confirm addressed comments; implementation is an approve-only reply.
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { useRef, useState, type ReactNode } from 'react';

import { canDecideGate } from './gate-decision.js';
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
  const { run, feedback, currentPrincipalId, onApprove, onRequestChanges, side = 'bottom', popoverContainer = null } = props;
  if (!isSpecGateDecisionAvailable(run)) {
    return null;
  }

  const openCount = countOpenFeedback(feedback);
  const label = decisionLabel(openCount);
  const approve = decisionKind(openCount) === 'approve';
  const comments = openCount === 1 ? 'comment' : 'comments';
  return (
    <GateDecisionConfirmation
      key={`${run.id}:${label}`}
      testId="spec-gate-decision"
      label={label}
      prompt={approve ? 'Approve this spec?' : `Request changes on ${openCount} open ${comments}?`}
      confirmLabel={approve ? 'Approve' : 'Request changes'}
      confirmCopy={approve
        ? addressedConfirmationCopy(countAddressedByPrincipal(feedback, currentPrincipalId))
        : `This sends your ${openCount} open ${comments} back for revision.`}
      submit={approve ? onApprove : onRequestChanges}
      side={side}
      popoverContainer={popoverContainer}
    />
  );
}

export function ImplementationGateDecision({ run, onApprove }: {
  readonly run: Run;
  onApprove(): Promise<RunActionResult>;
}): ReactNode {
  return canDecideGate(run, 'implementation.human_review') ? (
    <GateDecisionConfirmation
      key={run.id}
      testId="implementation-gate-decision"
      label="Approve"
      prompt="Approve this implementation?"
      confirmLabel="Approve"
      submit={onApprove}
    />
  ) : null;
}

interface GateDecisionConfirmationProps {
  readonly testId: string;
  readonly label: string;
  readonly prompt: string;
  readonly confirmLabel: string;
  readonly confirmCopy?: string | undefined;
  readonly side?: 'top' | 'bottom';
  readonly popoverContainer?: HTMLElement | null;
  submit(): Promise<RunActionResult>;
}

function GateDecisionConfirmation({
  testId, label, prompt, confirmLabel, confirmCopy, submit, side = 'bottom', popoverContainer = null
}: GateDecisionConfirmationProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DecisionError | null>(null);
  const submitting = useRef(false);
  const confirmButton = useRef<HTMLElement | null>(null);

  async function confirm(): Promise<void> {
    if (submitting.current) {
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    const result = await submit();
    submitting.current = false;
    setBusy(false);
    if (result.status === 'ok') {
      // The run leaves the gate; close the popover (the button hides after the refresh).
      setOpen(false);
      return;
    }
    const info = decisionErrorInfo(result.error);
    setError({ message: info.message, retryable: !isFeedbackGateBlocked(result.error) });
  }

  // The Base UI Popover trigger owns the open/close toggle through `onOpenChange`; the button itself
  // carries no onClick so the two never fight over the controlled `open` state.
  const trigger = (
    <Button variant="primary" size="control-sm" data-testid={testId} disabled={busy} className="tabular-nums">
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
      initialFocus={confirmButton}
      label={prompt}
      data-testid={`${testId}-popover`}
    >
      <div className="w-64">
        <p className="text-sm text-text">{prompt}</p>
        {confirmCopy !== undefined ? (
          <p data-testid={`${testId}-copy`} className="mt-1 text-xs text-subtext">
            {confirmCopy}
          </p>
        ) : null}
        {error !== null ? (
          <p data-testid={`${testId}-error`} className="mt-2 text-xs text-red">
            {error.message}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="control-sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            ref={confirmButton}
            variant="primary"
            size="control-sm"
            data-testid={`${testId}-confirm`}
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
