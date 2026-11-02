/**
 * The reusable tab empty-state component.
 *
 * Follows the design-system empty-state pattern: centered in its region, a title in
 * `--text-md`, one explanatory line in `--text-sm` and `--color-subtext`, no button, and
 * no illustration. The copy comes from the shared descriptors in
 * `run-detail-empty-states.ts`, so component tests assert against those descriptors
 * instead of duplicating the wording.
 */
import type { ReactNode } from 'react';

import type { EmptyStateCopy } from './run-detail-empty-states.js';

export interface RunDetailEmptyStateProps {
  readonly copy: EmptyStateCopy;
  /** Test id for the surrounding region, so a test can scope to a specific tab's state. */
  readonly testId?: string;
}

export function RunDetailEmptyState({ copy, testId }: RunDetailEmptyStateProps): ReactNode {
  return (
    <div
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center"
    >
      <div className="text-md font-medium text-text">{copy.title}</div>
      <p className="text-sm text-subtext" style={{ maxWidth: 'var(--width-reading-column)' }}>
        {copy.line}
      </p>
    </div>
  );
}
