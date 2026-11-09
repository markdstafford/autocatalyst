/**
 * The Spec tab body.
 *
 * For the empty discriminators (no-spec / drafting / loading / error) it maps straight to the shared
 * copy from #135. For `ready` it renders the review surface (`SpecReview`): the rendered document,
 * the anchored/stale/no-range comments, and — only while the run waits at `spec.human_review` — the
 * selection-driven composer. Comment creation and reload flow back through the data hook's
 * `onCreateComment` / `onReloadNeeded` callbacks so all SDK traffic stays in one place.
 */
import type { Run } from '@autocatalyst/api-contract';
import type { ReactNode } from 'react';

import { SPEC_EMPTY_STATES } from './run-detail-empty-states.js';
import type { SpecDiscriminator } from './run-detail-facts.js';
import type { SpecReviewController } from './use-spec-review-controller.js';
import { EmptyState } from '../ui/empty-state.js';
import { SpecReview, type CreateCommentInput, type CreateCommentResult } from '../features/spec/spec-review.js';

const SPEC_GATE_STEP = 'spec.human_review';

export interface RunDetailSpecTabProps {
  readonly spec: SpecDiscriminator;
  /** The selected run, used to decide whether commenting is allowed (spec gate only). */
  readonly run: Run;
  /** The pane-level controller shared with the footer and overlay (selection, nav, lifecycle). */
  readonly controller?: SpecReviewController;
  onCreateComment(input: CreateCommentInput): Promise<CreateCommentResult>;
  onReloadNeeded(): void;
}

export function RunDetailSpecTab({ spec, run, controller, onCreateComment, onReloadNeeded }: RunDetailSpecTabProps): ReactNode {
  switch (spec.status) {
    case 'no-spec':
      return <EmptyState data-testid="pane-spec-empty" title={SPEC_EMPTY_STATES.noSpec.title} message={SPEC_EMPTY_STATES.noSpec.line} />;
    case 'drafting':
      return <EmptyState data-testid="pane-spec-empty" title={SPEC_EMPTY_STATES.drafting.title} message={SPEC_EMPTY_STATES.drafting.line} />;
    case 'ready':
      return (
        <SpecReview
          markdown={spec.markdown}
          artifactId={spec.artifactId}
          feedback={spec.feedback}
          canComment={run.currentStep === SPEC_GATE_STEP}
          {...(controller !== undefined ? { controller } : {})}
          onCreateComment={onCreateComment}
          onReloadNeeded={onReloadNeeded}
        />
      );
    case 'error':
      return (
        <div data-testid="pane-spec-error" className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
          <div className="text-md font-medium text-text">Spec could not be loaded</div>
          <p className="text-sm text-subtext">{spec.message}</p>
        </div>
      );
    case 'loading':
    default:
      return (
        <div data-testid="pane-spec-loading" className="flex h-full items-center justify-center p-6 text-sm text-subtext">
          Loading spec…
        </div>
      );
  }
}
