import type { Run } from '@autocatalyst/api-contract';
import type { ControlPlaneClient } from '@autocatalyst/sdk';

import type { RunView } from './run-views.js';

export type RunViewRequest = Omit<NonNullable<Parameters<ControlPlaneClient['listRuns']>[0]>, 'limit' | 'cursor'>;

/** Combine view filters and address scope by AND. Null means do not query. */
export function buildRunViewRequest(_view: RunView, projectId: string | undefined): RunViewRequest | null {
  return projectId === undefined ? {} : { projectId };
}

/** Apply presentation to the accumulated, deduplicated server rows. */
export function projectRunViewRows(_view: RunView, loadedRows: readonly Run[]): readonly Run[] {
  return loadedRows;
}
