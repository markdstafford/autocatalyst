/**
 * Tab-model tests: order, availability, and the kept-tab fallback rule, including a
 * synthetic run that lacks the kept tab.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_TAB_IDS,
  DEFAULT_TAB_ID,
  RUN_DETAIL_TABS,
  resolveVisibleTab,
  tabsForRun,
  type RunDetailTabId
} from './run-detail-tabs.js';

describe('run detail tab model', () => {
  it('lists the four tabs in order with their labels', () => {
    expect(RUN_DETAIL_TABS.map((tab) => tab.id)).toEqual(['summary', 'spec', 'acceptance', 'activity']);
    expect(RUN_DETAIL_TABS.map((tab) => tab.label)).toEqual(['Summary', 'Spec', 'Acceptance', 'Activity']);
  });

  it('makes every tab available for a run', () => {
    expect(tabsForRun()).toEqual(ALL_TAB_IDS);
    expect(ALL_TAB_IDS).toEqual(['summary', 'spec', 'acceptance', 'activity']);
  });

  it('keeps the kept tab when the run has it', () => {
    expect(resolveVisibleTab('activity', ALL_TAB_IDS)).toBe('activity');
    expect(resolveVisibleTab('spec', ALL_TAB_IDS)).toBe('spec');
  });

  it('falls back to Summary for a run missing the kept tab without changing the kept choice', () => {
    // A synthetic run that lacks the Activity tab.
    const available: readonly RunDetailTabId[] = ['summary', 'spec'];
    const keptTab: RunDetailTabId = 'activity';
    expect(resolveVisibleTab(keptTab, available)).toBe(DEFAULT_TAB_ID);
    // The caller's kept choice is untouched: resolving again against a run that has it
    // returns Activity.
    expect(resolveVisibleTab(keptTab, ALL_TAB_IDS)).toBe('activity');
  });
});
