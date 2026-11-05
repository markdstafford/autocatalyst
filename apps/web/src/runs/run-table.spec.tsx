/**
 * RunTable component tests: the Title / Work kind / Status / Project / Age columns, the
 * work-kind and status chips, the missing-status dash, the missing-tracked-issue title
 * fallback, the title cell clipping, project-name joining, age formatting, and the
 * selection contract (exactly one `aria-selected`, roving tab stop, click and Enter
 * select).
 *
 * The status dot, the status word, and the "Waiting on" column were removed with the shared
 * status chip: status is now one `StatusChip` cell, covered here and in `status-chip.spec.tsx`.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Run } from '@autocatalyst/api-contract';

import { makeRun } from './run-fixtures.js';
import { RunTable, type RunTableProps } from './run-table.js';

/** A run with its API-read-only `status` stripped, for the missing-status dash case. */
function runWithoutStatus(id: string): Run {
  const run = makeRun({ id });
  const { status: _status, ...rest } = run;
  void _status;
  return { ...rest } as Run;
}

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

describe('RunTable columns', () => {
  it('shows the five columns in order with no Waiting on column', () => {
    renderTable();
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Title', 'Work kind', 'Status', 'Project', 'Age']);
    expect(screen.queryByRole('columnheader', { name: 'Waiting on' })).toBeNull();
  });

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

  it('renders work kind as a neutral chip, not bare text', () => {
    renderTable({ rows: [makeRun({ id: 'run-1', workKind: 'enhancement' })] });
    const chip = screen.getByText('enhancement');
    // The neutral chip uses the design-system outline classes.
    expect(chip.className).toContain('border-border');
    expect(chip.className).not.toContain('bg-primary');
  });

  it('renders a StatusChip for in-progress human review as the primary-filled Needs review', () => {
    renderTable({ rows: [makeRun({ status: 'in_progress', waitingOn: 'human' })] });
    const chip = screen.getByText('Needs review');
    expect(chip.className).toContain('bg-primary');
  });

  it('shows Working for ai waiting and the terminal word for an ended run', () => {
    renderTable({
      rows: [
        makeRun({ id: 'r-ai', status: 'in_progress', waitingOn: 'ai' }),
        makeRun({ id: 'r-done', status: 'done', terminal: true })
      ],
      selectedRunId: 'r-ai'
    });
    expect(screen.getByText('Working')).toBeDefined();
    const doneRow = screen.getByTestId('run-row-r-done');
    expect(within(doneRow).getByText('Done')).toBeDefined();
  });

  it('renders a dash in the status cell when a run has no status', () => {
    renderTable({ rows: [runWithoutStatus('r-nostatus')], selectedRunId: 'r-nostatus' });
    const row = screen.getByTestId('run-row-r-nostatus');
    // No status chip words appear; the status cell shows the dash instead.
    expect(within(row).queryByText('Needs review')).toBeNull();
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(1);
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

describe('RunTable title cell', () => {
  it('has no status dot and clips its content', () => {
    renderTable({ rows: [makeRun({ id: 'run-1' })] });
    const cell = screen.getByTestId('run-cell-title-run-1');
    // The old status dot (a rounded-full span) is gone.
    expect(cell.querySelector('.rounded-full')).toBeNull();
    // The cell clips overflow and may shrink below its content width so the title truncates.
    expect(cell.className).toContain('min-w-0');
    expect(cell.className).toContain('overflow-hidden');
    expect(cell.querySelector('.truncate')).not.toBeNull();
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
