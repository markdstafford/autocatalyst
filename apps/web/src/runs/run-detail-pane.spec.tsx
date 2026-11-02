/**
 * RunDetailPane tests: the complementary semantics, the selected-run id/title content,
 * the absence of tabs, and the no-run state.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeRun } from './run-fixtures.js';
import { RunDetailPane } from './run-detail-pane.js';

describe('RunDetailPane', () => {
  it('exposes a complementary region named "Run detail"', () => {
    render(<RunDetailPane run={makeRun()} />);
    expect(screen.getByRole('complementary', { name: 'Run detail' })).toBeDefined();
  });

  it('shows the selected run id and issue title and nothing else', () => {
    render(<RunDetailPane run={makeRun({ id: 'run-7', issueTitle: 'Add the run list' })} />);
    expect(screen.getByTestId('pane-run-title').textContent).toBe('Add the run list');
    expect(screen.getByTestId('pane-run-id').textContent).toBe('run-7');
    // No tabs in this feature.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('falls back to the run id as the title without a tracked issue', () => {
    render(<RunDetailPane run={makeRun({ id: 'run-9', withIssue: false })} />);
    const region = screen.getByRole('complementary', { name: 'Run detail' });
    expect(within(region).getByTestId('pane-run-title').textContent).toBe('run-9');
  });

  it('shows no run in the no-runs state', () => {
    render(<RunDetailPane run={undefined} />);
    expect(screen.getByTestId('pane-no-run')).toBeDefined();
    expect(screen.queryByTestId('pane-run-id')).toBeNull();
  });
});
