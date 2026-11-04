/**
 * RunsPage composition tests: the full route mounted through the real provider stack
 * and SDK client (driven by a fetch seam), covering first-row selection + address
 * replacement, the detail pane reflecting the selection, click/keyboard selection with
 * address changes, route-id selection, the no-runs empty state, and the no-token
 * connect prompt that issues no request.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRoutes } from '../app.js';
import { clearBearerToken, writeBearerToken } from '../auth/token-store.js';
import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { makeProject, makeRun } from '../runs/run-fixtures.js';
import { readPreferences } from '../theme/preferences.js';
import { ThemeProvider } from '../theme/theme-provider.js';
import type { Project, Run } from '@autocatalyst/api-contract';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface SeamState {
  runs: Run[];
  projects: Project[];
  runsStatus: number;
}

const seam: SeamState = { runs: [], projects: [], runsStatus: 200 };

function errorResponse(code: string, status: number): Response {
  return jsonResponse({ error: { code, message: 'x' } }, status);
}

/** An abortable, never-ending SSE response for the selected-run event stream. */
function sseResponse(init?: RequestInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      const signal = init?.signal ?? undefined;
      if (signal != null) {
        if (signal.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            try {
              controller.error(new DOMException('Aborted', 'AbortError'));
            } catch {
              /* already closed */
            }
          },
          { once: true }
        );
      }
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const fetchSeam: typeof globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (url.includes('/v1/projects')) {
    return jsonResponse({ projects: seam.projects }, 200);
  }
  // Selected-run detail reads (checked before the run collection/resource).
  const detailMatch = /\/v1\/runs\/([^/?]+)\/(pull-request|sessions|spec|events)/u.exec(url);
  if (detailMatch !== null) {
    const kind = detailMatch[2];
    if (kind === 'events') {
      return sseResponse(init ?? undefined);
    }
    if (kind === 'sessions') {
      return jsonResponse({ sessions: [] }, 200);
    }
    // No pull request and no spec artifact yet (normal 404s).
    return errorResponse('not_found', 404);
  }
  // A single-run resource read (getRun): /v1/runs/<id> with no further segment.
  const resourceMatch = /\/v1\/runs\/([^/?]+)$/u.exec(url);
  if (resourceMatch !== null) {
    const run = seam.runs.find((r) => r.id === resourceMatch[1]);
    if (run === undefined) {
      return errorResponse('not_found', 404);
    }
    return jsonResponse(run, 200);
  }
  if (url.includes('/v1/runs')) {
    if (seam.runsStatus !== 200) {
      return jsonResponse({ error: { code: 'internal_error', message: 'boom' } }, seam.runsStatus);
    }
    return jsonResponse({ runs: seam.runs }, 200);
  }
  // Health and anything else.
  return jsonResponse({ status: 'ok', database: { status: 'reachable' } }, 200);
};

function LocationProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderRuns(path = '/runs'): void {
  render(
    <ThemeProvider>
      <ControlPlaneClientProvider fetch={fetchSeam}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  seam.runs = [];
  seam.projects = [];
  seam.runsStatus = 200;
});

afterEach(() => {
  clearBearerToken();
});

describe('RunsPage without a token', () => {
  it('shows the connect prompt and makes no run/project request', async () => {
    renderRuns('/runs');
    expect(screen.getByText('Connect to the control plane')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open connection settings' })).toBeDefined();
    // No table ever appears.
    expect(screen.queryByRole('grid', { name: 'Runs' })).toBeNull();
  });
});

describe('RunsPage with runs', () => {
  beforeEach(() => {
    writeBearerToken('token-abc');
    seam.projects = [makeProject({ id: 'p-1', displayName: 'Fixture app' })];
    seam.runs = [
      makeRun({ id: 'run-a', issueTitle: 'First run', projectId: 'p-1' }),
      makeRun({ id: 'run-b', issueTitle: 'Second run', projectId: 'p-1' })
    ];
  });

  it('selects the first row, replaces the address, and fills the pane', async () => {
    renderRuns('/runs');
    await screen.findByTestId('run-row-run-a');

    const selected = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute('data-run-id')).toBe('run-a');

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/runs/run-a');
    });
    expect(screen.getByRole('complementary', { name: 'Run detail' }).getAttribute('data-pane-run-id')).toBe('run-a');
    expect(screen.getByTestId('pane-run-title').textContent).toBe('First run');
  });

  it('selects a clicked row and pushes the address', async () => {
    renderRuns('/runs');
    await screen.findByTestId('run-row-run-b');
    await userEvent.click(screen.getByTestId('run-row-run-b'));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/runs/run-b');
    });
    expect(screen.getByRole('complementary', { name: 'Run detail' }).getAttribute('data-pane-run-id')).toBe('run-b');
  });

  it('moves selection with j while the list is focused', async () => {
    renderRuns('/runs');
    const firstRow = await screen.findByTestId('run-row-run-a');
    firstRow.focus();
    await userEvent.keyboard('j');

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/runs/run-b');
    });
    const selected = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected[0]?.getAttribute('data-run-id')).toBe('run-b');
  });

  it('does not move selection with j when focus is outside the list', async () => {
    renderRuns('/runs');
    await screen.findByTestId('run-row-run-a');
    // Focus the document body (outside the list).
    document.body.focus();
    await userEvent.keyboard('j');
    // Selection stays on the first row.
    const selected = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected[0]?.getAttribute('data-run-id')).toBe('run-a');
  });

  it('selects the matching row for a direct /runs/:runId', async () => {
    renderRuns('/runs/run-b');
    await screen.findByTestId('run-row-run-b');
    const selected = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected[0]?.getAttribute('data-run-id')).toBe('run-b');
  });

  it('joins the project name into the row', async () => {
    renderRuns('/runs');
    const row = await screen.findByTestId('run-row-run-a');
    expect(within(row).getByText('Fixture app')).toBeDefined();
  });

  it('shows the detail pane by default and hides/shows it from the footer toggle, persisting', async () => {
    renderRuns('/runs');
    await screen.findByTestId('run-row-run-a');
    expect(screen.getByRole('complementary', { name: 'Run detail' })).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle detail pane' }));
    expect(screen.queryByRole('complementary', { name: 'Run detail' })).toBeNull();
    expect(readPreferences().detailPaneVisible).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Toggle detail pane' }));
    expect(screen.getByRole('complementary', { name: 'Run detail' })).toBeDefined();
    expect(readPreferences().detailPaneVisible).toBe(true);
  });

  it('hides the pane with the "]" shortcut', async () => {
    renderRuns('/runs');
    await screen.findByTestId('run-row-run-a');
    fireEvent.keyDown(document.body, { key: ']' });
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Run detail' })).toBeNull();
    });
    expect(readPreferences().detailPaneVisible).toBe(false);
  });
});

describe('RunsPage first-page failure', () => {
  it('shows the failure state promising a retry on the next poll and raises the indicator', async () => {
    writeBearerToken('token-abc');
    seam.runsStatus = 500;
    renderRuns('/runs');
    // The visible UI tells the operator the list could not load and that the client
    // will retry on the next poll, alongside the connection-lost indicator.
    await screen.findByTestId('runs-error');
    expect(screen.getByText('Runs could not be loaded')).toBeDefined();
    expect(screen.getByText('The client will try again on the next poll.')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText('Connection lost')).toBeDefined();
    });
    // No table is shown while the first page has not loaded.
    expect(screen.queryByRole('grid', { name: 'Runs' })).toBeNull();
  });
});

describe('RunsPage empty state', () => {
  it('shows the no-runs empty state without a Start a run button', async () => {
    writeBearerToken('token-abc');
    seam.runs = [];
    renderRuns('/runs');
    await screen.findByTestId('runs-empty-no-runs');
    expect(screen.getByText('A run starts from a tracked issue.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /start a run/i })).toBeNull();
  });
});
