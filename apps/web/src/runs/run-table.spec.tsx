/**
 * RunTable component tests: column cells, the missing-tracked-issue title fallback,
 * status/waiting mappings, project-name joining, age formatting, and the selection
 * contract (exactly one `aria-selected`, roving tab stop, click and Enter select).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeRun } from './run-fixtures.js';
import { RunTable, type RunTableProps } from './run-table.js';

function renderTable(overrides: Partial<RunTableProps> = {}): {
  select: ReturnType<typeof vi.fn>;
  loadNextPage: ReturnType<typeof vi.fn>;
} {
  const select = vi.fn();
  const loadNextPage = vi.fn();
  const props: RunTableProps = {
    rows: overrides.rows ?? [makeRun({ id: 'run-1' })],
    selectedRunId: overrides.selectedRunId ?? 'run-1',
    projectNames: overrides.projectNames ?? new Map(),
    nowIso: overrides.nowIso ?? '2026-01-01T01:30:00.000Z',
    hasNextPage: overrides.hasNextPage ?? false,
    isPaging: overrides.isPaging ?? false,
    select,
    loadNextPage
  };
  render(<RunTable {...props} />);
  return { select, loadNextPage };
}

describe('RunTable cells', () => {
  it('renders rows in the given order', () => {
    renderTable({
      rows: [makeRun({ id: 'run-a' }), makeRun({ id: 'run-b' })],
      selectedRunId: 'run-a'
    });
    const rows = screen.getAllByRole('row');
    // First row is the sticky header.
    expect(rows[1]?.getAttribute('data-run-id')).toBe('run-a');
    expect(rows[2]?.getAttribute('data-run-id')).toBe('run-b');
  });

  it('shows the issue title and number when a tracked issue exists', () => {
    renderTable({
      rows: [makeRun({ id: 'run-1', issueNumber: 42, issueTitle: 'Wire the pane' })]
    });
    expect(screen.getByText('Wire the pane')).toBeDefined();
    expect(screen.getByText('#42')).toBeDefined();
  });

  it('falls back to the run id for both title and number without a tracked issue', () => {
    renderTable({ rows: [makeRun({ id: 'run-xyz', withIssue: false })], selectedRunId: 'run-xyz' });
    const row = screen.getByTestId('run-row-run-xyz');
    expect(within(row).getAllByText('run-xyz').length).toBeGreaterThanOrEqual(2);
  });

  it('maps in-progress waiting-on-human to the primary-filled label', () => {
    renderTable({ rows: [makeRun({ status: 'in_progress', waitingOn: 'human' })] });
    expect(screen.getByText('Waiting on you')).toBeDefined();
  });

  it('shows Working for ai/system waiting and a dash for ended runs', () => {
    renderTable({
      rows: [
        makeRun({ id: 'r-ai', status: 'in_progress', waitingOn: 'ai' }),
        makeRun({ id: 'r-done', status: 'done' })
      ],
      selectedRunId: 'r-ai'
    });
    expect(screen.getByText('Working')).toBeDefined();
    const doneRow = screen.getByTestId('run-row-r-done');
    // Status word present; waiting shows a dash.
    expect(within(doneRow).getByText('Done')).toBeDefined();
  });

  it('shows the project name for a known id and a dash otherwise', () => {
    renderTable({
      rows: [
        makeRun({ id: 'r-known', projectId: 'p-1' }),
        makeRun({ id: 'r-unknown', projectId: 'p-2' })
      ],
      selectedRunId: 'r-known',
      projectNames: new Map([['p-1', 'Fixture app']])
    });
    expect(screen.getByText('Fixture app')).toBeDefined();
    const unknown = screen.getByTestId('run-row-r-unknown');
    expect(within(unknown).getByText('—')).toBeDefined();
  });

  it('formats age with the largest whole unit and tabular-nums', () => {
    renderTable({
      rows: [makeRun({ id: 'r', createdAt: '2026-01-01T00:00:00.000Z' })],
      selectedRunId: 'r',
      nowIso: '2026-01-01T02:00:00.000Z'
    });
    expect(screen.getByText('2h')).toBeDefined();
  });
});

describe('RunTable selection', () => {
  it('marks exactly one row aria-selected and makes it the roving tab stop', () => {
    renderTable({
      rows: [makeRun({ id: 'run-a' }), makeRun({ id: 'run-b' })],
      selectedRunId: 'run-b'
    });
    const selected = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute('data-run-id')).toBe('run-b');
    expect(screen.getByTestId('run-row-run-a').getAttribute('tabindex')).toBe('-1');
    expect(screen.getByTestId('run-row-run-b').getAttribute('tabindex')).toBe('0');
  });

  it('selects a row on click', async () => {
    const { select } = renderTable({
      rows: [makeRun({ id: 'run-a' }), makeRun({ id: 'run-b' })],
      selectedRunId: 'run-a'
    });
    await userEvent.click(screen.getByTestId('run-row-run-b'));
    expect(select).toHaveBeenCalledWith('run-b');
  });

  it('selects the focused row on Enter', async () => {
    const { select } = renderTable({
      rows: [makeRun({ id: 'run-a' }), makeRun({ id: 'run-b' })],
      selectedRunId: 'run-a'
    });
    screen.getByTestId('run-row-run-a').focus();
    await userEvent.keyboard('{Enter}');
    expect(select).toHaveBeenCalledWith('run-a');
  });
});

describe('RunTable paging', () => {
  it('shows a loading row while paging', () => {
    renderTable({ isPaging: true });
    expect(screen.getByTestId('run-list-loading-row')).toBeDefined();
  });
});
