/**
 * Run detail header tests: tracked vs untracked runs, the external issue link, the
 * work-kind chip, the shared status chip for every run state, the two-line title clamp with
 * the full text in the `title` attribute, and the absence of a project name.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeRun, type MakeRunOverrides } from './run-fixtures.js';
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
    const link = screen.getByRole('link');
    expect(link.getAttribute('data-testid')).toBe('pane-issue-link');
    expect(link.getAttribute('href')).toBe('https://example.test/issues/101');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toBe('#42');
    expect(screen.getByTestId('pane-work-kind').textContent).toBe('feature');
    // In-progress + human → the "Needs review" chip.
    expect(screen.getByTestId('pane-status').textContent).toBe('Needs review');
  });

  it('shows the same header structure with a matching status chip for every run state', () => {
    const cases: Array<{ overrides: MakeRunOverrides; label: string }> = [
      { overrides: { status: 'in_progress', waitingOn: 'human' }, label: 'Needs review' },
      { overrides: { status: 'in_progress', waitingOn: 'ai' }, label: 'Working' },
      { overrides: { status: 'done', terminal: true }, label: 'Done' },
      { overrides: { status: 'failed', terminal: true }, label: 'Failed' },
      { overrides: { status: 'canceled', terminal: true }, label: 'Canceled' }
    ];
    for (const { overrides, label } of cases) {
      const { unmount } = render(<RunDetailHeader run={makeRun({ id: 'r', ...overrides })} />);
      expect(screen.getByRole('link')).toBeDefined();
      expect(screen.getByTestId('pane-work-kind')).toBeDefined();
      expect(screen.getByTestId('pane-status').textContent).toBe(label);
      unmount();
    }
  });

  it('falls back to the run id and shows no issue link without a tracked issue', () => {
    render(<RunDetailHeader run={makeRun({ id: 'run-9', withIssue: false })} />);
    expect(screen.getByTestId('pane-run-title').textContent).toBe('run-9');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('pane-issue-link')).toBeNull();
  });

  it('clamps a long title to two lines and keeps the full text in the title attribute', () => {
    const longTitle = 'x'.repeat(300);
    render(<RunDetailHeader run={makeRun({ id: 'run-long', issueTitle: longTitle })} />);
    const title = screen.getByTestId('pane-run-title');
    expect(title.className).toContain('line-clamp-2');
    expect(title.getAttribute('title')).toBe(longTitle);
    expect(title.textContent).toBe(longTitle);
  });

  it('does not show the project name', () => {
    render(<RunDetailHeader run={makeRun({ projectId: 'project-1' })} />);
    expect(screen.queryByText('Fixture app')).toBeNull();
    expect(screen.queryByText('project-1')).toBeNull();
  });
});
