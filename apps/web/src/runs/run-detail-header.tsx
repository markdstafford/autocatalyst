/**
 * The run detail header: title, issue link, work-kind chip, and status.
 *
 * The title is the tracked issue title when the run has one, otherwise the run id. The
 * issue number renders as an external link only when a tracked issue exists, opening in
 * a new tab with `rel="noopener noreferrer"`. The meta line shows the work-kind chip and
 * the status; it never shows the project name. In-progress runs show the waiting chip
 * ("Waiting on you" filled, "Working" outline); terminal runs show the colored status
 * word.
 */
import type { Run } from '@autocatalyst/api-contract';
import type { ReactNode } from 'react';

import { rowTitle, statusWord, waitingCell } from './run-fields.js';

export interface RunDetailHeaderProps {
  readonly run: Run;
}

const TERMINAL_STATUS_CLASS: Readonly<Record<string, string>> = {
  done: 'text-green',
  failed: 'text-red',
  canceled: 'text-subtext'
};

export function RunDetailHeader({ run }: RunDetailHeaderProps): ReactNode {
  const title = rowTitle(run);
  return (
    <div className="flex flex-col gap-1">
      <div data-testid="pane-run-title" className="text-lg font-medium text-text">
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
        <span
          data-testid="pane-work-kind"
          className="inline-flex items-center rounded-sm border border-border px-1.5 py-0.5 text-xs text-text"
        >
          {run.workKind}
        </span>
        {renderStatus(run)}
      </div>
    </div>
  );
}

function renderStatus(run: Run): ReactNode {
  if (run.status === 'in_progress') {
    const waiting = waitingCell(run);
    if (waiting.primary) {
      return (
        <span
          data-testid="pane-status"
          className="inline-flex items-center rounded-sm bg-primary px-1.5 py-0.5 text-xs font-medium text-on-primary"
        >
          {waiting.label}
        </span>
      );
    }
    return (
      <span
        data-testid="pane-status"
        className="inline-flex items-center rounded-sm border border-border px-1.5 py-0.5 text-xs text-subtext"
      >
        {waiting.label}
      </span>
    );
  }
  const colorClass = run.status !== undefined ? TERMINAL_STATUS_CLASS[run.status] ?? 'text-text' : 'text-text';
  return (
    <span data-testid="pane-status" className={`text-sm ${colorClass}`}>
      {statusWord(run.status)}
    </span>
  );
}
