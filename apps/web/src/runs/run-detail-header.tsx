/**
 * The run detail header: title, issue link, work-kind chip, and status chip.
 *
 * Every run state uses the same structure so the pane header is predictable: a clamped
 * title over a meta line with the issue number as a link when a tracked issue exists, the
 * neutral work-kind chip, and the shared {@link StatusChip}. The title is the tracked issue
 * title when the run has one, otherwise the run id, and it is capped at two lines with the
 * full text kept in the `title` attribute so a long title does not grow the fixed header.
 * The issue number renders as an external link only when a tracked issue exists, opening in
 * a new tab with `rel="noopener noreferrer"`. The meta line never shows the project name.
 *
 * Because the status chip comes from the same `runStateChip` mapping the list row uses, the
 * header status always matches the selected row.
 */
import type { Run } from '@autocatalyst/api-contract';
import type { ReactNode } from 'react';

import { rowTitle } from './run-fields.js';
import { StatusChip } from './status-chip.js';
import { Chip } from '../ui/chip.js';

export interface RunDetailHeaderProps {
  readonly run: Run;
}

export function RunDetailHeader({ run }: RunDetailHeaderProps): ReactNode {
  const title = rowTitle(run);
  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid="pane-run-title"
        title={title.title}
        className="line-clamp-2 text-lg font-medium text-text"
      >
        {title.title}
      </div>
      <div data-testid="pane-meta" className="flex flex-wrap items-center gap-2 text-sm text-subtext">
        {run.trackedIssue !== undefined ? (
          <a
            data-testid="pane-issue-link"
            href={run.trackedIssue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-subtext hover:text-text"
          >
            #{run.trackedIssue.number}
          </a>
        ) : null}
        <Chip tone="neutral" data-testid="pane-work-kind">
          {run.workKind}
        </Chip>
        <StatusChip run={run} data-testid="pane-status" />
      </div>
    </div>
  );
}
