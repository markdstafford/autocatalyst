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
import { makeCreateRunResponse, makeProject, makePullRequest, makeRun, makeTransitionEvent } from '../runs/run-fixtures.js';
import { readPreferences, patchPreferences } from '../theme/preferences.js';
import { ThemeProvider } from '../theme/theme-provider.js';
import type { Project, PullRequest, Run, RunPullRequestRefreshResponse, RunStep } from '@autocatalyst/api-contract';

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
  action?: (path: string, body: unknown) => Response | Promise<Response>;
  readonly actions: { path: string; body: unknown }[];
  readonly listQueries: URLSearchParams[];
  readonly runReads: string[];
  readonly runResponses: Promise<Response>[];
  readonly stepReads: string[];
  readonly histories: Map<string, Response | Promise<Response> | RunStep[]>;
  readonly frames: Map<string, (chunk: string) => void>;
}

const seam: SeamState = {
  runs: [], projects: [], runsStatus: 200, projectsStatus: 200, filters: [], checks: [], listResponses: [],
  issueStatus: 200, createStatus: 201, issuePaths: [], creates: 0,
  actions: [], listQueries: [], runReads: [], runResponses: [], stepReads: [], histories: new Map(), frames: new Map()
};

function errorResponse(code: string, status: number): Response {
  return jsonResponse({ error: { code, message: 'x' } }, status);
}

/** An abortable, never-ending SSE response for the selected-run event stream. */
function sseResponse(id: string, init?: RequestInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      seam.frames.set(id, chunk => controller.enqueue(encoder.encode(chunk)));
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
  if (seam.action && /^\/v1\/runs\/[^/]+(?:\/(?:cancel|recover|archive|unarchive|set-step))?$/u.test(path) &&
    (init?.method === 'POST' || init?.method === 'PATCH')) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    seam.actions.push({ path, body });
    return seam.action(path, body);
  }
  // Selected-run detail reads (checked before the run collection/resource).
  const detailMatch = /\/v1\/runs\/([^/?]+)\/(pull-request\/refresh|pull-request|sessions|spec|steps|workflow|events)/u.exec(url);
  if (detailMatch !== null) {
    const kind = detailMatch[2];
    if (kind === 'events') {
      return sseResponse(detailMatch[1]!, init ?? undefined);
    }
    if (kind === 'sessions') {
      return jsonResponse({ sessions: [] }, 200);
    }
    if (kind === 'workflow') {
      return jsonResponse({ workflowId: 'fixture', workKind: 'feature', phases: [], steps: [], transitions: [] });
    }
    if (kind === 'steps') {
      const id = detailMatch[1]!;
      seam.stepReads.push(id);
      const held = seam.histories.get(id);
      return Array.isArray(held) || held === undefined ? jsonResponse({ steps: held ?? [] }) : held;
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
    seam.runReads.push(resourceMatch[1]!);
    const pending = seam.runResponses.shift();
    if (pending !== undefined) return pending;
    const run = seam.runs.find((r) => r.id === resourceMatch[1]) ??
      (seam.createdRun?.id === resourceMatch[1] ? seam.createdRun : undefined);
    if (run === undefined) {
      return errorResponse('not_found', 404);
    }
    return jsonResponse(run, 200);
  }
  if (url.includes('/v1/runs')) {
    const query = new URL(url).searchParams;
    seam.listQueries.push(query);
    const project = query.get('projectId');
    seam.filters.push(project);
    const pending = seam.listResponses.shift();
    if (pending !== undefined) return pending;
    if (seam.runsStatus !== 200) {
      return jsonResponse({ error: { code: 'internal_error', message: 'boom' } }, seam.runsStatus);
    }
    const archive = query.get('archived') === 'only';
    return jsonResponse({ runs: seam.runs.filter(run =>
      (project === null || run.projectId === project) && (run.archivedAt !== undefined) === archive) }, 200);
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
  delete seam.action;
  seam.actions.length = 0;
  seam.runReads.length = 0;
  seam.listQueries.length = 0;
  seam.runResponses.length = 0;
  seam.stepReads.length = 0;
  seam.histories.clear();
  seam.frames.clear();
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
    expect(screen.getByRole('heading', { name: 'All runs' })).toBeDefined();
    expect(screen.getByRole('banner').textContent).toContain('Alpha');
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
    expect(screen.getByRole('heading', { name: 'All runs' })).toBeDefined();
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
    patchPreferences({ ...readPreferences(), detailPaneVisible: false });
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

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const response = new Promise<Response>(finish => { resolve = finish; });
  return { response, resolve };
}

function conflict(message: string, status = 409, reason?: string): Response {
  return jsonResponse({ error: { code: 'refused', message, ...(reason ? { details: { reason, internal: 'hidden' } } : {}) } }, status);
}

function history(run: Run, step: string, index = 0): RunStep {
  return {
    id: `history-${index}`, runId: run.id, step, phase: 'spec', role: 'implementer',
    startedAt: run.createdAt, endedAt: run.createdAt, durationMs: 0,
    occurrence: { index, attempt: 1 }, checkpointResult: null
  };
}

const key = (value: string, modifiers: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: value, ...modifiers });
const updateRun = (run: Run): void => { seam.runs = seam.runs.map(row => row.id === run.id ? run : row); };
const rowMenu = (run: Run) => within(screen.getByTestId(`run-row-${run.id}`)).getByRole('button', { name: /^Run actions for/u });
const paneMenu = () => screen.getByRole('button', { name: 'Run actions', exact: true });
const menuLabels = () => within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.getAttribute('aria-label'));
const selectedPane = () => screen.getByRole('complementary', { name: 'Run detail' }).getAttribute('data-pane-run-id');

describe('RunsPage operator actions', () => {
  const a = makeRun({ id: 'a', issueTitle: 'First', projectId: 'project-1' });
  const b = makeRun({ id: 'b', issueTitle: 'Second', projectId: 'project-1' });
  const canceled = { ...a, status: 'canceled', waitingOn: 'none', terminal: true, currentStep: 'canceled' } as const;
  const archived = { ...canceled, archivedAt: '2026-01-02T00:00:00.000Z' };

  beforeEach(() => {
    writeBearerToken('token-abc');
    seam.projects = [makeProject({ id: 'project-1' })];
    seam.runs = [a, b];
    seam.histories.set(a.id, [history(a, 'spec.author')]);
  });

  it('uses row history lazily and gives confirmation the nonselected row and opener', async () => {
    const user = userEvent.setup();
    const otherHistory = deferredResponse();
    seam.histories.set(b.id, otherHistory.response);
    seam.action = () => jsonResponse({});
    renderRuns();
    await screen.findByTestId('run-row-a');
    await waitFor(() => expect(seam.stepReads).toEqual(['a']));
    await user.click(paneMenu());
    await waitFor(() => expect(menuLabels()).toEqual(['Cancel', 'Rename', 'Set step']));
    const setStep = screen.getByRole('menuitem', { name: 'Set step' });
    expect(setStep.textContent).toContain('s');
    key('X', { shiftKey: true });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.keyboard('{Escape}');
    await user.hover(screen.getByTestId('run-row-b'));
    screen.getByTestId('run-row-b').focus();
    await user.tab();
    expect(document.activeElement).toBe(rowMenu(b));
    await user.keyboard('{Enter}');
    expect(selectedPane()).toBe('a');
    expect(menuLabels()).toEqual(['Cancel', 'Rename']);
    expect(seam.stepReads).toEqual(['a', 'b']);
    await act(async () => otherHistory.resolve(jsonResponse({ steps: [history(b, 'other.step')] })));
    expect(menuLabels()).toEqual(['Cancel', 'Rename', 'Set step']);
    await user.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    const dialog = within(await screen.findByRole('alertdialog', { name: 'Cancel this run?' }));
    expect(dialog.getByText('Canceling ends this run, and it cannot be recovered.')).toBeDefined();
    const [dismiss, confirm] = dialog.getAllByRole('button');
    expect(dismiss?.textContent).toBe('Cancel');
    expect(confirm?.className).toContain('bg-red text-on-destructive');
    await waitFor(() => expect(document.activeElement).toBe(dismiss));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(rowMenu(b)));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(seam.actions).toEqual([]);
    seam.action = () => {
      const finished = { ...canceled, id: b.id, trackedIssue: b.trackedIssue };
      updateRun(finished);
      return jsonResponse({ run: finished });
    };
    seam.histories.set(b.id, conflict('History is unreadable.', 500));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(menuLabels()).toEqual(['Cancel', 'Rename']));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    await screen.findByText('Canceled', { selector: '[role=status]' });
    expect(seam.actions.map(call => call.path)).toEqual(['/v1/runs/b/cancel']);
    expect(selectedPane()).toBe('a');
    expect(within(screen.getByTestId('run-row-b')).getByText('Canceled')).toBeDefined();
  });

  it('cancels immediately, fences an older getRun and keeps canceled through late frames', async () => {
    const user = userEvent.setup();
    const oldRun = deferredResponse();
    const mutation = deferredResponse();
    seam.runResponses.push(oldRun.response);
    seam.action = () => mutation.response;
    renderRuns();
    await screen.findByTestId('run-row-a');
    await waitFor(() => expect(seam.runReads).toEqual(['a']));
    key('X', { shiftKey: true });
    const confirm = await screen.findByRole('button', { name: 'Cancel run' });
    await user.dblClick(confirm);
    expect(seam.actions).toHaveLength(1);
    updateRun(canceled);
    await act(async () => mutation.resolve(jsonResponse({ run: canceled })));
    expect(screen.getByTestId('pane-status').textContent).toBe('Canceled');
    const transition = makeTransitionEvent({ id: 'late', run: a });
    await act(async () => {
      oldRun.resolve(jsonResponse({ ...a, updatedAt: '2026-02-01T00:00:00.000Z' }));
      seam.frames.get(a.id)?.(`id: late\nevent: run_state_transition\ndata: ${JSON.stringify(transition)}\n\n`);
      const progress = { id: 'late-progress', runId: a.id, createdAt: a.createdAt, type: 'runner_progress',
        importance: 'normal', step: 'spec.author', progress: { kind: 'intent', summary: 'Finishing current work' } };
      seam.frames.get(a.id)?.(`id: late-progress\nevent: runner_progress\ndata: ${JSON.stringify(progress)}\n\n`);
    });
    await waitFor(() => expect(seam.runReads.length).toBeGreaterThan(1));
    expect(screen.getByTestId('pane-status').textContent).toBe('Canceled');
  });

  it.each([true, false])('rereads after a cancel conflict (read succeeds: %s)', async (rereadOk) => {
    seam.action = () => {
      if (rereadOk) updateRun(canceled);
      else seam.runResponses.push(Promise.resolve(conflict('Read failed.', 500)));
      return conflict('That run is already closed.');
    };
    renderRuns();
    await screen.findByTestId('run-row-a');
    await waitFor(() => expect(seam.runReads).toEqual(['a']));
    key('X', { shiftKey: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await screen.findByText('That run is already closed.', { selector: '[role=alert]' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('pane-status').textContent).toBe(rereadOk ? 'Canceled' : 'Needs review'));
    expect(seam.runReads.slice(0, 2)).toEqual(['a', 'a']);
  });

  it.each(['resume', 'start_over', 'conflict'])('submits recovery without a mode and handles %s', async mode => {
    seam.runs = [{ ...a, status: 'failed', terminal: true, waitingOn: 'none' }, b];
    seam.action = () => {
      if (mode === 'conflict') return conflict('Recovery is unavailable.');
      updateRun(a);
      return jsonResponse({ run: a, mode });
    };
    renderRuns();
    await screen.findByTestId('run-row-a');
    key('R', { shiftKey: true, altKey: true });
    key('r');
    expect(seam.actions).toEqual([]);
    key('R', { shiftKey: true });
    const expected = mode === 'resume' ? 'Recovered (resumed)' :
      mode === 'start_over' ? 'Recovered (started over)' : 'Recovery is unavailable.';
    await screen.findByText(expected);
    expect(seam.actions).toEqual([{ path: '/v1/runs/a/recover', body: {} }]);
    expect(screen.getByTestId('pane-status').textContent).toBe(mode === 'conflict' ? 'Failed' : 'Needs review');
    if (mode === 'conflict') expect(seam.runReads).toEqual(['a']);
  });

  it('loads selected history with the pane hidden and handles step refusals without losing the choice', async () => {
    const user = userEvent.setup();
    patchPreferences({ ...readPreferences(), detailPaneVisible: false });
    const moved = { ...a, currentStep: 'spec.author', waitingOn: 'none' } as const;
    seam.action = () => {
      if (seam.actions.length <= 2) return conflict('Cannot move back.', seam.actions.length === 1 ? 400 : 409, 'This step is not earlier.');
      updateRun(moved);
      return jsonResponse({ run: moved });
    };
    renderRuns();
    await screen.findByTestId('run-row-a');
    await waitFor(() => expect(seam.stepReads).toEqual(['a']));
    key('s');
    let dialog = within(await screen.findByRole('dialog', { name: 'Move the run back' }));
    expect((dialog.getByRole('button', { name: 'Move back' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(seam.actions).toEqual([]);
    key('s');
    dialog = within(await screen.findByRole('dialog', { name: 'Move the run back' }));
    const choice = dialog.getByRole<HTMLInputElement>('radio', { name: 'spec.author' });
    await user.click(choice);
    for (let i = 1; i <= 2; i++) {
      await user.click(dialog.getByRole('button', { name: 'Move back' }));
      expect((await dialog.findByRole('alert')).textContent).toBe('Cannot move back. This step is not earlier.');
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(choice.checked).toBe(true);
      expect(seam.actions).toHaveLength(i);
    }
    await user.click(dialog.getByRole('button', { name: 'Move back' }));
    await screen.findByText('Moved back', { selector: '[role=status]' });
    expect(seam.actions.every(call => call.path === '/v1/runs/a/set-step')).toBe(true);
    expect(seam.actions[2]?.body).toEqual({ step: 'spec.author' });
  });

  it('selects a row for Rename, preserves its draft on refusal and projects the title onto its topic', async () => {
    const user = userEvent.setup();
    const sibling = { ...a, topicId: b.topicId };
    seam.runs = [sibling, b, makeRun({ id: 'other', issueTitle: 'Unrelated' })];
    patchPreferences({ ...readPreferences(), detailPaneVisible: false });
    const name = 'x'.repeat(200);
    seam.action = (_path, body) => {
      expect(body).toEqual({ title: name });
      if (seam.actions.length <= 2) return conflict('Title was refused.', seam.actions.length === 1 ? 400 : 409);
      seam.runs = seam.runs.map(row => row.topicId === b.topicId ? { ...row, title: name } : row);
      return jsonResponse({ run: { ...b, title: name } });
    };
    renderRuns();
    await screen.findByTestId('run-row-b');
    await user.click(rowMenu(b));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Run title' });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Second');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
    expect(selectedPane()).toBe('b');
    key('X', { shiftKey: true });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.keyboard('{Escape}');
    expect(seam.actions).toEqual([]);
    const title = screen.getByTestId('pane-run-title');
    title.focus();
    await user.keyboard('{Enter}');
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Run title' });
    for (const value of ['   ', `  ${name}x  `]) {
      fireEvent.change(field, { target: { value } });
      await user.keyboard('{Enter}');
      expect(screen.getByRole('alert')).toBeDefined();
      expect(seam.actions).toEqual([]);
    }
    fireEvent.change(field, { target: { value: `  ${name}  ` } });
    await user.tab();
    expect(seam.actions).toEqual([]);
    field.focus();
    for (let i = 1; i <= 2; i++) {
      await user.keyboard('{Enter}');
      await screen.findByText('Title was refused.', { selector: '[role=alert]' });
      expect(field.value).toBe(`  ${name}  `);
      expect(seam.actions).toHaveLength(i);
    }
    const issue = screen.getByTestId('pane-issue-link').getAttribute('href');
    await user.keyboard('{Enter}');
    await screen.findByText('Renamed', { selector: '[role=status]' });
    expect(screen.getByTestId('pane-run-title').textContent).toBe(name);
    expect(screen.getByTestId('pane-issue-link').getAttribute('href')).toBe(issue);
    expect(screen.getByTestId('run-cell-title-a').textContent).toContain(name);
    expect(screen.getByTestId('run-cell-title-other').textContent).toContain('Unrelated');
  });

  it('uses the captured Undo target, fences old pages and preserves successor selection', async () => {
    const stalePoll = deferredResponse();
    seam.runs = [canceled, b];
    seam.action = path => {
      const run = path.endsWith('/unarchive') ? canceled : archived;
      if (seam.actions.length % 2 === 1) return conflict('Membership changed elsewhere.');
      updateRun(run);
      return jsonResponse({ run });
    };
    renderRuns();
    await screen.findByTestId('run-row-a');
    seam.listResponses.push(stalePoll.response);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(seam.listQueries).toHaveLength(2));
    key('e');
    await screen.findByText('Membership changed elsewhere.', { selector: '[role=alert]' });
    expect(selectedPane()).toBe('a');
    key('e');
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(selectedPane()).toBe('b');
    expect(screen.queryByTestId('run-row-a')).toBeNull();
    await act(async () => stalePoll.resolve(jsonResponse({ runs: [canceled, b] })));
    expect(screen.queryByTestId('run-row-a')).toBeNull();
    await userEvent.click(undo);
    await screen.findByText('Membership changed elsewhere.', { selector: '[role=alert]' });
    expect(selectedPane()).toBe('b');
    expect(seam.actions.map(call => call.path)).toEqual([
      '/v1/runs/a/archive', '/v1/runs/a/archive', '/v1/runs/a/unarchive'
    ]);
    // Archive and Undo again, this time with a successful restore.
    updateRun(canceled);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await screen.findByTestId('run-row-a');
    await userEvent.click(rowMenu(canceled));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await screen.findByRole('button', { name: 'Undo' });
    seam.action = () => { updateRun(canceled); return jsonResponse({ run: canceled }); };
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Unarchived', { selector: '[role=status]' });
    expect(selectedPane()).toBe('b');
    expect(screen.getByTestId('run-row-a')).toBeDefined();
  });

  it('opens an unfiltered archive from an empty scoped list and exposes the last-row outcome', async () => {
    const user = userEvent.setup();
    seam.runs = [archived];
    seam.action = () => {
      if (seam.actions.length === 1) return conflict('Run could not be unarchived.');
      updateRun(canceled);
      return jsonResponse({ run: canceled });
    };
    renderRuns('/runs?project=missing');
    await screen.findByText('No runs yet');
    const entry = screen.getByRole('button', { name: 'Show archived runs' });
    await user.hover(entry);
    expect(await screen.findByText('Open Archived runs')).toBeDefined();
    await user.click(entry);
    await screen.findByRole('heading', { name: 'Archived runs' });
    await screen.findByTestId('run-row-a');
    expect(screen.getByTestId('location').textContent).toBe('/runs/a?archived=only');
    expect(seam.listQueries[0]?.get('archived')).toBeNull();
    expect(seam.listQueries[1]?.get('archived')).toBe('only');
    expect(seam.listQueries[1]?.get('projectId')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show archived runs' })).toBeNull();
    expect(screen.getByTestId('pane-meta').textContent).toContain('CanceledArchived');
    key('E', { shiftKey: true });
    await screen.findByText('Run could not be unarchived.', { selector: '[role=alert]' });
    expect(selectedPane()).toBe('a');
    key('E', { shiftKey: true });
    await screen.findByText('Archived runs appear here.');
    await screen.findByText('Unarchived', { selector: '[role=status]' });
    expect(screen.getByTestId('location').textContent).toBe('/runs?archived=only');
    await user.click(within(screen.getByRole('banner')).getByRole('link', { name: 'Runs' }));
    await screen.findByTestId('run-row-a');
    expect(screen.queryByText('Unarchived')).toBeNull();
  });

  it('reconciles a late action to its own row without overwriting a newer selection editor', async () => {
    const held = deferredResponse();
    seam.action = () => held.response;
    renderRuns();
    await screen.findByTestId('run-row-a');
    key('X', { shiftKey: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('run-row-b'));
    key('n');
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Run title' });
    fireEvent.change(field, { target: { value: 'Keep my draft' } });
    updateRun(canceled);
    await act(async () => held.resolve(jsonResponse({ run: canceled })));
    expect(field.value).toBe('Keep my draft');
    expect(within(screen.getByTestId('run-row-a')).getByText('Canceled')).toBeDefined();
    expect(screen.queryByText('Canceled', { selector: '[role=status]' })).toBeNull();
  });

  it('keeps an archive navigation with no selection independent of a retired default read', async () => {
    const formerScope = deferredResponse();
    seam.listResponses.push(formerScope.response);
    seam.runs = [archived];
    renderRuns();
    await screen.findByTestId('runs-loading');
    key('A', { shiftKey: true });
    await screen.findByRole('heading', { name: 'Archived runs' });
    await screen.findByTestId('run-row-a');
    expect(screen.queryByRole('region', { name: 'Collection views' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View settings' })).toBeNull();
    await act(async () => formerScope.resolve(jsonResponse({ runs: [b] })));
    expect(screen.queryByTestId('run-row-b')).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('/runs/a?archived=only');
  });

  it('rejects a held equal-timestamp title but reconciles a later authoritative title', async () => {
    const stalePoll = deferredResponse();
    const renamed = { ...a, title: 'Renamed here' };
    seam.action = () => { updateRun(renamed); return jsonResponse({ run: renamed }); };
    renderRuns();
    await screen.findByTestId('run-row-a');
    seam.listResponses.push(stalePoll.response);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(seam.listQueries).toHaveLength(2));
    key('n');
    const field = await screen.findByRole('textbox', { name: 'Run title' });
    fireEvent.change(field, { target: { value: renamed.title } });
    await userEvent.keyboard('{Enter}');
    await screen.findByText('Renamed', { selector: '[role=status]' });
    await act(async () => stalePoll.resolve(jsonResponse({ runs: [a, b] })));
    expect(screen.getByTestId('pane-run-title').textContent).toBe(renamed.title);

    updateRun({ ...a, title: 'Renamed elsewhere' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByTestId('pane-run-title').textContent).toBe('Renamed elsewhere');
  });

  it('retires a pending mutation outcome on a collection change', async () => {
    const mutation = deferredResponse();
    const failed = makeRun({ id: 'failed', status: 'failed' });
    seam.runs = [failed, archived];
    seam.action = () => mutation.response;
    renderRuns();
    await screen.findByTestId('run-row-failed');
    key('R', { shiftKey: true });
    expect(seam.actions).toHaveLength(1);
    key('A', { shiftKey: true });
    await screen.findByTestId('run-row-a');
    await act(async () => mutation.resolve(jsonResponse({ run: { ...failed, status: 'in_progress' }, mode: 'resume' })));
    expect(screen.getByTestId('location').textContent).toBe('/runs/a?archived=only');
    expect(screen.queryByTestId('run-action-outcome')).toBeNull();
    expect(screen.queryByTestId('run-row-failed')).toBeNull();
  });
});
