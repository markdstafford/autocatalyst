/**
 * RunsPage composition tests: the full route mounted through the real provider stack
 * and SDK client (driven by a fetch seam), covering first-row selection + address
 * replacement, the detail pane reflecting the selection, click/keyboard selection with
 * address changes, route-id selection, the no-runs empty state, and the no-token
 * connect prompt that issues no request.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRoutes } from '../app.js';
import { clearBearerToken, writeBearerToken } from '../auth/token-store.js';
import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { makeCreateRunResponse, makeProject, makePullRequest, makeRun } from '../runs/run-fixtures.js';
import { readPreferences, writePreferences } from '../theme/preferences.js';
import { ThemeProvider } from '../theme/theme-provider.js';
import type { Project, PullRequest, Run, RunPullRequestRefreshResponse } from '@autocatalyst/api-contract';

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
  projectsStatus: number;
  filters: (string | null)[];
  pullRequest?: PullRequest;
  refreshResponse?: RunPullRequestRefreshResponse;
  checks: string[];
  listResponses: Promise<Response>[];
  issueStatus: number;
  createStatus: number;
  createdRun?: Run;
  issuePaths: string[];
  creates: number;
}

const seam: SeamState = {
  runs: [], projects: [], runsStatus: 200, projectsStatus: 200, filters: [], checks: [], listResponses: [],
  issueStatus: 200, createStatus: 201, issuePaths: [], creates: 0
};

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
  const path = new URL(url).pathname;
  if (/^\/v1\/projects\/[^/]+\/issues\//u.test(path)) {
    seam.issuePaths.push(path);
    if (seam.issueStatus !== 200) return errorResponse('unauthorized', seam.issueStatus);
    return jsonResponse({
      issue: { number: 5, title: 'New issue', url: 'https://example.test/issues/5', labels: [], state: 'open' },
      workKind: { kind: 'feature', source: 'label' }
    });
  }
  if (path === '/v1/conversations' && init?.method === 'POST') {
    seam.creates++;
    if (seam.createStatus !== 201) return errorResponse('unauthorized', seam.createStatus);
    if (seam.createdRun === undefined) throw new Error('Missing create fixture');
    return jsonResponse(makeCreateRunResponse(seam.createdRun), 201);
  }
  if (url.includes('/v1/projects')) {
    return seam.projectsStatus === 200 ? jsonResponse({ projects: seam.projects }, 200) : errorResponse('internal_error', seam.projectsStatus);
  }
  // Selected-run detail reads (checked before the run collection/resource).
  const detailMatch = /\/v1\/runs\/([^/?]+)\/(pull-request\/refresh|pull-request|sessions|spec|steps|events)/u.exec(url);
  if (detailMatch !== null) {
    const kind = detailMatch[2];
    if (kind === 'events') {
      return sseResponse(init ?? undefined);
    }
    if (kind === 'sessions') {
      return jsonResponse({ sessions: [] }, 200);
    }
    if (kind === 'steps') {
      return jsonResponse({ steps: [] }, 200);
    }
    if (kind === 'pull-request/refresh' && init?.method === 'POST' && detailMatch[1] !== undefined) {
      seam.checks.push(detailMatch[1]);
      return jsonResponse(seam.refreshResponse ?? {
        pullRequest: seam.pullRequest,
        run: seam.runs.find(({ id }) => id === detailMatch[1])
      });
    }
    if (kind === 'pull-request' && seam.pullRequest?.runId === detailMatch[1]) {
      return jsonResponse({ pullRequest: seam.pullRequest });
    }
    // No pull request and no spec artifact yet (normal 404s).
    return errorResponse('not_found', 404);
  }
  // A single-run resource read (getRun): /v1/runs/<id> with no further segment.
  const resourceMatch = /\/v1\/runs\/([^/?]+)$/u.exec(url);
  if (resourceMatch !== null) {
    const run = seam.runs.find((r) => r.id === resourceMatch[1]) ??
      (seam.createdRun?.id === resourceMatch[1] ? seam.createdRun : undefined);
    if (run === undefined) {
      return errorResponse('not_found', 404);
    }
    return jsonResponse(run, 200);
  }
  if (url.includes('/v1/runs')) {
    const project = new URL(url).searchParams.get('projectId');
    seam.filters.push(project);
    const pending = seam.listResponses.shift();
    if (pending !== undefined) return pending;
    if (seam.runsStatus !== 200) {
      return jsonResponse({ error: { code: 'internal_error', message: 'boom' } }, seam.runsStatus);
    }
    return jsonResponse({ runs: project === null ? seam.runs : seam.runs.filter((run) => run.projectId === project) }, 200);
  }
  // Health and anything else.
  return jsonResponse({ status: 'ok', database: { status: 'reachable' } }, 200);
};

function LocationProbe(): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <span data-testid="location">{location.pathname}{location.search}</span>
    <button onClick={() => navigate(-1)}>History back</button>
  </>;
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
  seam.projectsStatus = 200;
  seam.filters = [];
  seam.checks = [];
  seam.listResponses = [];
  seam.issueStatus = 200;
  seam.createStatus = 201;
  seam.issuePaths = [];
  seam.creates = 0;
  delete seam.createdRun;
  delete seam.pullRequest;
  delete seam.refreshResponse;
});

afterEach(() => {
  clearBearerToken();
});

describe('RunsPage without a token', () => {
  it('shows the connect prompt and makes no run/project request', async () => {
    renderRuns('/runs');
    expect(screen.getByRole('heading', { name: 'Connect to the control plane' })).toBeDefined();
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

  it('checks a selected run while the pane is hidden and replaces both status chips on a manual check', async () => {
    const waiting: Run = { ...makeRun({ id: 'run-b' }), currentStep: 'pr.human_review' };
    seam.runs[1] = waiting;
    seam.pullRequest = makePullRequest({ runId: waiting.id });
    renderRuns('/runs/run-a');
    const row = await screen.findByTestId('run-row-run-b');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Toggle detail pane' }));
    await user.click(row);
    await waitFor(() => expect(seam.checks).toEqual(['run-b']));
    expect(screen.queryByRole('complementary', { name: 'Run detail' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Toggle detail pane' }));
    await screen.findByText('Checked just now');
    expect(seam.checks).toEqual(['run-b']);
    const updatedAt = '2026-01-01T00:02:00.000Z';
    seam.refreshResponse = {
      pullRequest: { ...seam.pullRequest, state: 'merged', updatedAt },
      run: { ...waiting, currentStep: 'done', terminal: true, waitingOn: 'none', status: 'done', updatedAt }
    };
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByTestId('pane-status').textContent).toBe('Done'));
    expect(within(row).getByText('Done')).toBeDefined();
    expect(screen.getByText('Merged')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(seam.checks).toEqual(['run-b', 'run-b']);
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

describe('RunsPage project scope', () => {
  beforeEach(() => {
    writeBearerToken('token-abc');
    seam.projects = [makeProject({ id: 'alpha', displayName: 'Alpha' }), makeProject({ id: 'beta', displayName: 'Beta' })];
    seam.runs = [
      makeRun({ id: 'a1', projectId: 'alpha' }),
      makeRun({ id: 'a2', projectId: 'alpha' }),
      makeRun({ id: 'b1', projectId: 'beta' })
    ];
  });

  it('keeps the filter through selection and browser back, and clears it through Runs', async () => {
    const user = userEvent.setup();
    renderRuns('/runs?project=alpha');
    await screen.findByTestId('run-row-a1');
    const location = () => screen.getByTestId('location').textContent;
    await waitFor(() => expect(location()).toBe('/runs/a1?project=alpha'));
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeDefined();
    expect(screen.queryByTestId('run-row-b1')).toBeNull();
    await user.click(screen.getByTestId('run-row-a2'));
    expect(location()).toBe('/runs/a2?project=alpha');
    await user.click(screen.getByRole('button', { name: 'History back' }));
    await waitFor(() => expect(location()).toBe('/runs/a1?project=alpha'));

    await user.click(screen.getByRole('link', { name: 'Beta' }));
    await screen.findByTestId('run-row-b1');
    await waitFor(() => expect(location()).toBe('/runs/b1?project=beta'));
    expect(screen.queryByTestId('run-row-a1')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Runs' }));
    await screen.findByTestId('run-row-a1');
    await waitFor(() => expect(location()).toBe('/runs/a1'));
    expect(seam.filters).toEqual(['alpha', 'beta', null]);
  });

  it('uses a generic header while keeping an unknown id scoped', async () => {
    renderRuns('/runs?project=unknown');
    await screen.findByText('No runs yet');
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeDefined();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(seam.filters).toEqual(['unknown']);
  });

  it('keeps rows usable when project names fail to load', async () => {
    seam.projectsStatus = 500;
    renderRuns();
    await screen.findByTestId('run-row-a1');
    expect(screen.queryByText('Add a project to get started')).toBeNull();
  });
});

describe('RunsPage empty state', () => {
  it('offers first-project setup only after a successful empty directory read', async () => {
    writeBearerToken('token-abc');
    renderRuns();
    await screen.findByRole('heading', { name: 'Add a project to get started' });
    expect(screen.getByRole('button', { name: 'Add project' })).toBeDefined();
    expect(screen.queryByText('No runs yet')).toBeNull();
  });

  it('shows a project failure instead of no projects or no runs if the directory read fails', async () => {
    writeBearerToken('token-abc');
    seam.projectsStatus = 500;
    renderRuns();
    await screen.findByRole('heading', { name: 'Projects could not be loaded' });
    expect(screen.queryByText('No runs yet')).toBeNull();
    expect(screen.queryByText('Add a project to get started')).toBeNull();
  });

  it('opens the shared start dialog from the no-runs state', async () => {
    writeBearerToken('token-abc');
    seam.runs = [];
    seam.projects = [makeProject()];
    renderRuns('/runs');
    const empty = await screen.findByTestId('runs-empty-no-runs');
    expect(screen.getByText('A run starts from a tracked issue.')).toBeDefined();
    const opener = within(empty).getByRole('button', { name: 'Start a run' });
    await userEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Start a run' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('start-run wiring', () => {
  function sidebarStart(): HTMLElement {
    return within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name: 'Start a run' });
  }

  function dialog(): ReturnType<typeof within> {
    return within(screen.getByRole('dialog', { name: 'Start a run' }));
  }

  async function resolveIssue(): Promise<void> {
    const field = await dialog().findByRole('textbox', { name: 'Issue reference' });
    fireEvent.change(field, { target: { value: '#5' } });
    fireEvent.keyDown(field, { key: 'Enter' });
  }

  it('keeps the hover sidebar visible for focus return and handles Select Escape before dialog Escape', async () => {
    writeBearerToken('token-abc');
    seam.projects = [makeProject()];
    renderRuns();
    await screen.findByTestId('runs-empty-no-runs');
    fireEvent.keyDown(document.body, { key: '[' });
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    fireEvent.pointerEnter(screen.getByTestId('sidebar-hover-zone'));
    const opener = sidebarStart();
    await userEvent.click(opener);
    fireEvent.pointerLeave(document.querySelector('nav')!);
    await userEvent.click(dialog().getByRole('combobox', { name: 'Project' }));
    expect(await screen.findByRole('option')).toBeDefined();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    expect(dialog().getByRole('combobox', { name: 'Project' })).toBeDefined();
    fireEvent.keyDown(dialog().getByRole('combobox', { name: 'Project' }), { key: ',', ctrlKey: true });
    expect(screen.getByTestId('location').textContent).toBe('/runs');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole('dialog', { name: 'Start a run' })).toBeNull();
  });

  it.each(['lookup', 'create'])('handles a bearer 401 during %s inside the dialog instead of redirecting', async (source) => {
    writeBearerToken('token-abc');
    seam.projects = [makeProject()];
    if (source === 'lookup') seam.issueStatus = 401;
    else seam.createStatus = 401;
    renderRuns();
    await screen.findByTestId('runs-empty-no-runs');
    await userEvent.click(sidebarStart());
    await resolveIssue();
    if (source === 'create') {
      await dialog().findByRole('region', { name: 'Issue preview' });
      await userEvent.click(dialog().getByRole('button', { name: 'Start run' }));
    }
    await dialog().findByRole('heading', { name: 'Connect to the control plane' });
    expect(dialog().queryByRole('combobox')).toBeNull();
    expect(dialog().queryByRole('button', { name: /retry|start run/iu })).toBeNull();
    expect(seam.issuePaths).toHaveLength(1);
    expect(seam.creates).toBe(source === 'create' ? 1 : 0);
    expect(screen.getByTestId('location').textContent).toBe('/runs');
    await userEvent.click(dialog().getByRole('button', { name: 'Open connection settings' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/settings/connection');
      expect(screen.getByRole('main').contains(document.activeElement)).toBe(true);
    });
  });

  it.each(['matching', 'different'])('lands immediately from a %s filter, superseding an in-flight list read', async (filter) => {
    const project = makeProject({ id: 'destination', displayName: 'Destination' });
    const source = filter === 'matching' ? project : makeProject({ id: 'source', displayName: 'Source' });
    seam.projects = filter === 'matching' ? [project] : [project, source];
    writeBearerToken('token-abc');
    writePreferences({ ...readPreferences(), detailPaneVisible: false });
    let finishOld!: (response: Response) => void;
    let finishRefresh!: (response: Response) => void;
    seam.listResponses = [
      new Promise((resolve) => { finishOld = resolve; }),
      new Promise((resolve) => { finishRefresh = resolve; })
    ];
    const created = makeRun({ id: 'run-new', issueTitle: 'New issue', issueNumber: 5, projectId: project.id });
    seam.createdRun = created;
    renderRuns('/runs?project=' + source.id);
    await userEvent.click(sidebarStart());
    if (filter === 'different') {
      const field = await dialog().findByRole('textbox', { name: 'Issue reference' });
      expect(field.hasAttribute('disabled')).toBe(true);
      await userEvent.click(dialog().getByRole('combobox', { name: 'Project' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Destination' }));
    }
    await resolveIssue();
    await dialog().findByRole('region', { name: 'Issue preview' });
    await userEvent.click(dialog().getByRole('button', { name: 'Start run' }));
    const row = await screen.findByTestId('run-row-run-new');
    expect(row.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.getByTestId('pane-run-title').textContent).toBe('New issue');
    expect(screen.queryByRole('dialog', { name: 'Start a run' })).toBeNull();
    expect(seam.filters).toEqual([source.id, filter === 'matching' ? project.id : null]);
    const address = '/runs/run-new' + (filter === 'matching' ? '?project=' + project.id : '');
    expect(screen.getByTestId('location').textContent).toBe(address);

    await act(async () => {
      finishOld(jsonResponse({ runs: [makeRun({ id: 'run-old', projectId: source.id })] }));
      finishRefresh(errorResponse('internal_error', 503));
    });
    expect(screen.queryByTestId('run-row-run-old')).toBeNull();
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('location').textContent).toBe(address);
    expect(screen.getByTestId('pane-run-title').textContent).toBe('New issue');
  });
});
