/**
 * Run detail header tests: tracked vs untracked runs, the external issue link, the
 * work-kind chip, the status, and the absence of a project name.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeRun } from './run-fixtures.js';
import { RunDetailHeader } from './run-detail-header.js';

describe('RunDetailHeader', () => {
  it('shows the issue title, a safe external issue link, work kind, and status for a tracked run', () => {
    render(
      <RunDetailHeader
        run={makeRun({
          id: 'run-7',
          issueNumber: 42,
          issueTitle: 'Add the run detail pane',
          workKind: 'feature',
          status: 'in_progress',
          waitingOn: 'human'
        })}
      />
    );
    expect(screen.getByTestId('pane-run-title').textContent).toBe('Add the run detail pane');
    const link = screen.getByTestId('pane-issue-link');
    expect(link.getAttribute('href')).toBe('https://example.test/issues/101');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toBe('#42');
    expect(screen.getByTestId('pane-work-kind').textContent).toBe('feature');
    // In-progress + human → the "Waiting on you" chip.
    expect(screen.getByTestId('pane-status').textContent).toBe('Waiting on you');
  });

  it('falls back to the run id and shows no issue link without a tracked issue', () => {
    render(<RunDetailHeader run={makeRun({ id: 'run-9', withIssue: false })} />);
    expect(screen.getByTestId('pane-run-title').textContent).toBe('run-9');
    expect(screen.queryByTestId('pane-issue-link')).toBeNull();
  });

  it('shows "Working" for an ai-waiting in-progress run', () => {
    render(<RunDetailHeader run={makeRun({ status: 'in_progress', waitingOn: 'ai' })} />);
    expect(screen.getByTestId('pane-status').textContent).toBe('Working');
  });

  it('shows the colored status word for a terminal run', () => {
    render(<RunDetailHeader run={makeRun({ status: 'failed', terminal: true })} />);
    expect(screen.getByTestId('pane-status').textContent).toBe('Failed');
  });

  it('does not show the project name', () => {
    render(<RunDetailHeader run={makeRun({ projectId: 'project-1' })} />);
    expect(screen.queryByText('Fixture app')).toBeNull();
    expect(screen.queryByText('project-1')).toBeNull();
  });
});
