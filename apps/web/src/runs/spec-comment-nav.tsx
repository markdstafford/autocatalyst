/**
 * The spec comment counts and previous/next navigation controls.
 *
 * Shared by the shell footer's detail-pane zone (pane mode) and the expanded spec overlay's comment
 * column (overlay mode, where the footer is covered). Counts read `N open, M resolved`; the icon
 * buttons step the pane-level controller's selection through comments in document order. Disabled
 * buttons keep their tooltip via `aria-disabled` (soft-disable), and when there are no comments both
 * buttons are disabled with a tooltip. Tooltip key hints come from the action registry, so no key is
 * hard-coded here.
 */
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';

import { actionTooltipKey, getAction } from '../shell/action-registry.js';
import { isMacPlatform } from '../shell/key-utils.js';
import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';

export interface SpecCommentCountsProps {
  readonly openCount: number;
  readonly resolvedCount: number;
}

export function SpecCommentCounts({ openCount, resolvedCount }: SpecCommentCountsProps): ReactNode {
  return (
    <span data-testid="spec-comment-counts" className="whitespace-nowrap text-xs tabular-nums text-subtext">
      {openCount} open, {resolvedCount} resolved
    </span>
  );
}

export interface SpecCommentNavButtonsProps {
  readonly hasComments: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  onPrevious(): void;
  onNext(): void;
  /** Suppress key hints in tooltips (used in the overlay, where the dialog guard makes keys inactive). */
  readonly suppressKeyHints?: boolean;
}

export function SpecCommentNavButtons({
  hasComments,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  suppressKeyHints = false
}: SpecCommentNavButtonsProps): ReactNode {
  const isMac = isMacPlatform();
  const prevLabel = getAction('previous-comment').name;
  const nextLabel = getAction('next-comment').name;
  const prevKey = suppressKeyHints ? undefined : actionTooltipKey('previous-comment', isMac);
  const nextKey = suppressKeyHints ? undefined : actionTooltipKey('next-comment', isMac);
  const prevDisabled = !hasComments || !canPrevious;
  const nextDisabled = !hasComments || !canNext;

  return (
    <div className="flex items-center gap-1">
      <Tooltip label={prevLabel} {...(prevKey !== undefined ? { keyHint: prevKey } : {})}>
        <Button
          variant="secondary"
          size="control-sm"
          data-testid="spec-comment-previous"
          aria-label={prevLabel}
          {...(prevDisabled ? { 'aria-disabled': true } : { onClick: onPrevious })}
          className="aspect-square border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text"
        >
          <ChevronUp aria-hidden size={14} />
        </Button>
      </Tooltip>
      <Tooltip label={nextLabel} {...(nextKey !== undefined ? { keyHint: nextKey } : {})}>
        <Button
          variant="secondary"
          size="control-sm"
          data-testid="spec-comment-next"
          aria-label={nextLabel}
          {...(nextDisabled ? { 'aria-disabled': true } : { onClick: onNext })}
          className="aspect-square border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text"
        >
          <ChevronDown aria-hidden size={14} />
        </Button>
      </Tooltip>
    </div>
  );
}
