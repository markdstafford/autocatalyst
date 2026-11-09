/**
 * The expanded (full-screen) spec reading view.
 *
 * A full-screen `Dialog` overlay that covers the viewport including the footer, so the gate decision,
 * comment counts, and previous/next controls move into the overlay's top row (the footer is hidden).
 * It composes one `SpecReview` instance wired to the same pane-level controller and SDK callbacks as
 * the pane, so a decision or comment made here is reflected in the pane after it closes, and only one
 * `SpecReview` (one `spec-document`/composer) is mounted at a time.
 *
 * Escape handling is owned by Base UI: a nested confirm popover closes on the first Escape, and the
 * overlay closes on the next. The shell `close-layer` binding does not act here. The document column is
 * at most `--width-reading-column`; the comment column keeps `--width-comment-column`.
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { SpecGateDecision } from './spec-gate-decision.js';
import { SpecCommentCounts, SpecCommentNavButtons } from './spec-comment-nav.js';
import { isSpecGateDecisionAvailable } from './spec-decision.js';
import type { RunActionResult } from './use-run-detail.js';
import type { SpecReviewController } from './use-spec-review-controller.js';
import { firstLineTitle } from '../features/spec/spec-title.js';
import { SpecReview, type CreateCommentInput, type CreateCommentResult } from '../features/spec/spec-review.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Tooltip } from '../ui/tooltip.js';

const SPEC_GATE_STEP = 'spec.human_review';

export interface RunDetailSpecOverlayProps {
  readonly open: boolean;
  onClose(): void;
  readonly run: Run;
  readonly markdown: string;
  readonly artifactId: string;
  readonly feedback: readonly FeedbackResponse[];
  readonly controller: SpecReviewController;
  readonly currentPrincipalId: string | undefined;
  onApprove(): Promise<RunActionResult>;
  onRequestChanges(): Promise<RunActionResult>;
  onCreateComment(input: CreateCommentInput): Promise<CreateCommentResult>;
  onReloadNeeded(): void;
}

export function RunDetailSpecOverlay(props: RunDetailSpecOverlayProps): ReactNode {
  const {
    open,
    onClose,
    run,
    markdown,
    artifactId,
    feedback,
    controller,
    currentPrincipalId,
    onApprove,
    onRequestChanges,
    onCreateComment,
    onReloadNeeded
  } = props;

  const title = firstLineTitle(markdown) || 'Spec';
  const selectedIndex = controller.order.findIndex((item) => item.id === controller.selectedId);
  const position = selectedIndex >= 0 ? `${selectedIndex + 1} of ${controller.order.length}` : null;
  // The overlay is a focus-trapped modal; the decision popover must portal into a node inside it so the
  // modal layer does not treat the popover as inert and swallow pointer clicks.
  const [popoverContainer, setPopoverContainer] = useState<HTMLDivElement | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      fullScreen
      titleVisuallyHidden
      title={title}
      data-testid="spec-overlay"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-md font-medium text-text">{title}</span>
          {position !== null ? (
            <span data-testid="spec-overlay-position" className="shrink-0 text-xs tabular-nums text-subtext">
              {position}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <SpecCommentCounts openCount={controller.openCount} resolvedCount={controller.resolvedCount} />
          <SpecCommentNavButtons
            hasComments={controller.hasComments}
            canPrevious={controller.canPrevious}
            canNext={controller.canNext}
            onPrevious={controller.selectPrevious}
            onNext={controller.selectNext}
            suppressKeyHints
          />
          {isSpecGateDecisionAvailable(run) ? (
            <SpecGateDecision
              run={run}
              feedback={feedback}
              currentPrincipalId={currentPrincipalId}
              onApprove={onApprove}
              onRequestChanges={onRequestChanges}
              popoverContainer={popoverContainer}
            />
          ) : null}
          <Tooltip label="Close">
            <Button
              variant="secondary"
              size="control-sm"
              data-testid="spec-overlay-close"
              aria-label="Close"
              onClick={onClose}
              className="aspect-square border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text"
            >
              <X aria-hidden size={16} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <div
          className="mx-auto"
          style={{ width: 'calc(var(--width-reading-column) + var(--width-comment-column) + 1rem)', maxWidth: '100%' }}
        >
          <SpecReview
            markdown={markdown}
            artifactId={artifactId}
            feedback={feedback}
            canComment={run.currentStep === SPEC_GATE_STEP}
            controller={controller}
            onCreateComment={onCreateComment}
            onReloadNeeded={onReloadNeeded}
          />
        </div>
      </div>

      {/* Portal target for the decision confirm popover, kept inside the modal subtree. */}
      <div ref={setPopoverContainer} data-testid="spec-overlay-popover-layer" />
    </Dialog>
  );
}
