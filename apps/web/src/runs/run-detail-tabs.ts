/**
 * The run detail tab model: the four tab ids and labels in order, the per-run tab
 * availability, and the kept-tab fallback rule.
 *
 * Pure and React-free so the order, labels, and fallback are unit-tested in isolation
 * and shared by the pane and its tests without duplication. Every run in this feature
 * has all four tabs, but the model accepts a per-run tab list so future item types can
 * drop a tab and still reuse the fallback rule.
 */
export type RunDetailTabId = 'summary' | 'spec' | 'acceptance' | 'activity';

export interface RunDetailTab {
  readonly id: RunDetailTabId;
  readonly label: string;
}

/** The tab shown when a kept tab is not available on the current run. */
export const DEFAULT_TAB_ID: RunDetailTabId = 'summary';

/** The four tabs, in display order: Summary, Spec, Acceptance, Activity. */
export const RUN_DETAIL_TABS: readonly RunDetailTab[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'spec', label: 'Spec' },
  { id: 'acceptance', label: 'Acceptance' },
  { id: 'activity', label: 'Activity' }
];

/** All four tab ids, in order. */
export const ALL_TAB_IDS: readonly RunDetailTabId[] = RUN_DETAIL_TABS.map((tab) => tab.id);

/**
 * The tabs available on a run. Every run in this feature carries all four; the
 * signature takes the run so a future item type can narrow the set without changing
 * callers.
 */
export function tabsForRun(): readonly RunDetailTabId[] {
  return ALL_TAB_IDS;
}

/**
 * The tab actually shown for a run: the kept tab when the run has it, otherwise the
 * default (Summary). The caller keeps its own record of the kept choice; this never
 * changes it, so moving to a run that lacks the kept tab shows Summary without losing
 * the preference for the next run that has it.
 */
export function resolveVisibleTab(
  keptTabId: RunDetailTabId,
  availableTabIds: readonly RunDetailTabId[]
): RunDetailTabId {
  return availableTabIds.includes(keptTabId) ? keptTabId : DEFAULT_TAB_ID;
}
