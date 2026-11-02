/**
 * The Run detail pane: a side complementary region that reflects the selected row and
 * establishes the detail-pane layout later run-detail work builds on.
 *
 * For this feature the body shows only the selected run id and its issue title — no
 * tabs, and no empty state while a run is selected. With no selected run (the no-runs
 * state) it shows "No run". The pane bar is empty, `--height-pane-bar` high with 12 px
 * horizontal padding and a `--color-border` line below, so its top and bottom align
 * with the table column header row.
 */
import type { Run } from '@autocatalyst/api-contract';
import type { ReactNode } from 'react';

import { rowTitle } from './run-fields.js';

export interface RunDetailPaneProps {
  /** The selected run, or undefined in the no-runs state. */
  readonly run: Run | undefined;
}

export function RunDetailPane({ run }: RunDetailPaneProps): ReactNode {
  const title = run !== undefined ? rowTitle(run) : undefined;
  return (
    <aside
      role="complementary"
      aria-label="Run detail"
      className="flex h-full min-w-0 flex-col border-l border-border bg-background"
    >
      {/* Empty pane bar; aligns with the table column header row. */}
      <div data-testid="pane-bar" className="h-pane-bar shrink-0 border-b border-border px-3" />

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {run !== undefined && title !== undefined ? (
          <div className="flex flex-col gap-1">
            <div data-testid="pane-run-title" className="text-lg font-medium text-text">
              {title.title}
            </div>
            <div data-testid="pane-run-id" className="text-sm text-subtext">
              {run.id}
            </div>
          </div>
        ) : (
          <div data-testid="pane-no-run" className="text-sm text-subtext">
            No run
          </div>
        )}
      </div>
    </aside>
  );
}
