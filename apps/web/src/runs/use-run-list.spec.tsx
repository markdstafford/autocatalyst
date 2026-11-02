/**
 * Run list state module tests with a scripted SDK client: initial load and
 * first-row selection, no-token idleness, request pass-through, non-overlapping
 * polling with fake timers, hidden-page pause, poll-driven row changes, paging with
 * dedupe, poll/page failure raising only listLost (401 excepted), unmount clearing
 * listLost, and bounded project-name refetch.
 */
import type { ListRunsOptions } from '@autocatalyst/sdk';
import type { RunListResponse } from '@autocatalyst/api-contract';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeProject, makeRun } from './run-fixtures.js';
import { createScriptedClient, unauthorizedError } from './scripted-client.js';
import { projectName } from './run-list-projects.js';
import { useRunList, type UseRunListOptions } from './use-run-list.js';

interface HarnessProps extends Omit<UseRunListOptions, 'navigateToRun' | 'onListLostChange'> {
  readonly navigateToRun: UseRunListOptions['navigateToRun'];
  readonly onListLostChange: UseRunListOptions['onListLostChange'];
}

function Harness(props: HarnessProps): ReactNode {
  const state = useRunList(props);
  return (
    <div>
      <span data-testid="phase">{state.phase}</span>
      <span data-testid="selected">{state.selectedRunId ?? ''}</span>
      <span data-testid="rows">{state.rows.map((r) => r.id).join(',')}</span>
      <span data-testid="hasNext">{String(state.hasNextPage)}</span>
      <span data-testid="paging">{String(state.isPaging)}</span>
      {state.rows.map((r) => (
        <div key={r.id}>
          <span data-testid={`proj-${r.id}`}>
            {projectName(r.projectId, state.projectNames)}
          </span>
          <button data-testid={`select-${r.id}`} onClick={() => state.select(r.id)}>
            select {r.id}
          </button>
        </div>
      ))}
      <button data-testid="next" onClick={() => state.move('next')}>
        next
      </button>
      <button data-testid="load" onClick={() => state.loadNextPage()}>
        load
      </button>
    </div>
  );
}

function defaults(): { navigateToRun: ReturnType<typeof vi.fn>; onListLostChange: ReturnType<typeof vi.fn> } {
  return { navigateToRun: vi.fn(), onListLostChange: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useRunList initial load', () => {
  it('loads the first page, renders rows in order, selects the first, and joins projects once', async () => {
    const client = createScriptedClient({
      runs: [makeRun({ id: 'r1', projectId: 'p1' }), makeRun({ id: 'r2', projectId: 'p1' })],
      projects: [makeProject({ id: 'p1', displayName: 'Alpha' })]
    });
    const spies = defaults();
    render(<Harness client={client.client} connected routeRunId={undefined} {...spies} />);

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    expect(screen.getByTestId('rows').textContent).toBe('r1,r2');
    expect(screen.getByTestId('selected').textContent).toBe('r1');
    expect(screen.getByTestId('proj-r1').textContent).toBe('Alpha');
    expect(client.listProjectsCalls).toBe(1);
    expect(spies.navigateToRun).toHaveBeenCalledWith('r1', { replace: true });

    const first = client.listRunsCalls[0];
    expect(first?.limit).toBe(50);
    expect(first?.cursor).toBeUndefined();
  });

  it('honors a matching route run id', async () => {
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' }), makeRun({ id: 'r2' })] });
    const spies = defaults();
    render(<Harness client={client.client} connected routeRunId="r2" {...spies} />);
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('r2'));
    expect(spies.navigateToRun).not.toHaveBeenCalled();
  });

  it('does nothing without a token', async () => {
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    render(<Harness client={client.client} connected={false} routeRunId={undefined} {...spies} />);
    await act(async () => {});
    expect(screen.getByTestId('phase').textContent).toBe('no-token');
    expect(client.listRunsCalls).toHaveLength(0);
    expect(client.listProjectsCalls).toBe(0);
  });

  it('passes request args through to listRuns', async () => {
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    render(
      <Harness
        client={client.client}
        connected
        routeRunId={undefined}
        requestArgs={{ projectId: 'p9' }}
        {...spies}
      />
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    expect(client.listRunsCalls[0]?.projectId).toBe('p9');
  });

  it('shows the first-page failure state and raises listLost', async () => {
    const client = createScriptedClient({ runs: [] });
    client.failRunsOnce(new Error('network down'));
    const spies = defaults();
    render(<Harness client={client.client} connected routeRunId={undefined} {...spies} />);
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('error'));
    expect(spies.onListLostChange).toHaveBeenCalledWith(true);
  });
});

describe('useRunList polling', () => {
  it('polls on the interval, not before, and skips while hidden', async () => {
    vi.useFakeTimers();
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    render(
      <Harness client={client.client} connected routeRunId={undefined} pollIntervalMs={5000} {...spies} />
    );
    // Flush the initial load (microtasks) under fake timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterLoad = client.listRunsCalls.length;
    expect(afterLoad).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(client.listRunsCalls.length).toBe(afterLoad);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.listRunsCalls.length).toBe(afterLoad + 1);

    // Hide the page: the next tick is skipped.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.listRunsCalls.length).toBe(afterLoad + 1);

    // Becoming visible runs one poll immediately.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.listRunsCalls.length).toBe(afterLoad + 2);
  });

  it('does not overlap polls while a request is in flight', async () => {
    vi.useFakeTimers();
    const releasers: (() => void)[] = [];
    let calls = 0;
    const client = {
      async listRuns(_options?: ListRunsOptions): Promise<RunListResponse> {
        calls += 1;
        if (calls === 1) {
          // Let the initial load settle normally.
          return { runs: [makeRun({ id: 'r1' })] };
        }
        return new Promise<RunListResponse>((resolve) => {
          releasers.push(() => resolve({ runs: [makeRun({ id: 'r1' })] }));
        });
      },
      async listProjects() {
        return { projects: [] };
      }
    } as unknown as import('@autocatalyst/sdk').ControlPlaneClient;
    const spies = defaults();
    render(<Harness client={client} connected routeRunId={undefined} pollIntervalMs={1000} {...spies} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);

    // First poll tick starts a request that never resolves yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls).toBe(2);

    // Further ticks are skipped while the poll is in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(calls).toBe(2);

    // Release the in-flight poll; the next tick can run again.
    await act(async () => {
      for (const release of releasers) release();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls).toBe(3);
  });

  it('reflects a new top row on the next poll without moving selection', async () => {
    vi.useFakeTimers();
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    render(
      <Harness client={client.client} connected routeRunId={undefined} pollIntervalMs={1000} {...spies} />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('selected').textContent).toBe('r1');

    client.setRuns([makeRun({ id: 'r2' }), makeRun({ id: 'r1' })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId('rows').textContent).toBe('r2,r1');
    expect(screen.getByTestId('selected').textContent).toBe('r1');
  });

  it('keeps rows and raises/clears listLost across a failing then succeeding poll', async () => {
    vi.useFakeTimers();
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    render(
      <Harness client={client.client} connected routeRunId={undefined} pollIntervalMs={1000} {...spies} />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    client.failRunsOnce(new Error('blip'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId('rows').textContent).toBe('r1');
    expect(spies.onListLostChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(spies.onListLostChange).toHaveBeenLastCalledWith(false);
  });

  it('starts polling after a first-page failure and a later successful poll renders rows and clears listLost', async () => {
    vi.useFakeTimers();
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    // The initial first-page load fails (non-401); the next poll succeeds.
    client.failRunsOnce(new Error('network down'));
    const spies = defaults();
    render(
      <Harness client={client.client} connected routeRunId={undefined} pollIntervalMs={1000} {...spies} />
    );

    // Initial load settles into the first-page failure state with listLost raised and
    // no rows rendered.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('phase').textContent).toBe('error');
    expect(screen.getByTestId('rows').textContent).toBe('');
    expect(spies.onListLostChange).toHaveBeenLastCalledWith(true);

    // The poll timer started despite the failure: the next tick reloads the first page,
    // renders rows, selects the first, moves to ready, and clears listLost.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId('phase').textContent).toBe('ready');
    expect(screen.getByTestId('rows').textContent).toBe('r1');
    expect(screen.getByTestId('selected').textContent).toBe('r1');
    expect(spies.onListLostChange).toHaveBeenLastCalledWith(false);
  });

  it('does not raise listLost on a 401 poll', async () => {
    vi.useFakeTimers();
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    render(
      <Harness client={client.client} connected routeRunId={undefined} pollIntervalMs={1000} {...spies} />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    spies.onListLostChange.mockClear();

    client.failRunsOnce(unauthorizedError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(spies.onListLostChange).not.toHaveBeenCalledWith(true);
  });
});

describe('useRunList unmount', () => {
  it('clears listLost when the page unmounts', async () => {
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    const { unmount } = render(
      <Harness client={client.client} connected routeRunId={undefined} {...spies} />
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    spies.onListLostChange.mockClear();
    unmount();
    expect(spies.onListLostChange).toHaveBeenCalledWith(false);
  });
});

describe('useRunList paging', () => {
  it('loads the next page when selection reaches the end and dedupes overlaps', async () => {
    const client = createScriptedClient({
      runs: [makeRun({ id: 'r1' }), makeRun({ id: 'r2' })]
    });
    client.setPageSize(1); // one run per page
    const spies = defaults();
    render(<Harness client={client.client} connected routeRunId={undefined} {...spies} />);
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('r1'));
    expect(screen.getByTestId('hasNext').textContent).toBe('true');

    // Move selection to the last loaded row -> triggers the next page.
    await userEvent.click(screen.getByTestId('next'));
    await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('r1,r2'));
    expect(screen.getByTestId('hasNext').textContent).toBe('false');
  });

  it('loadNextPage is a no-op without a next cursor', async () => {
    const client = createScriptedClient({ runs: [makeRun({ id: 'r1' })] });
    const spies = defaults();
    render(<Harness client={client.client} connected routeRunId={undefined} {...spies} />);
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    const before = client.listRunsCalls.length;
    await userEvent.click(screen.getByTestId('load'));
    await act(async () => {});
    expect(client.listRunsCalls.length).toBe(before);
  });
});

describe('useRunList project refetch', () => {
  it('refetches once for a newly introduced unknown project id, not every poll', async () => {
    vi.useFakeTimers();
    const client = createScriptedClient({
      runs: [makeRun({ id: 'r1', projectId: 'p1' })],
      projects: [makeProject({ id: 'p1', displayName: 'Alpha' })]
    });
    const spies = defaults();
    render(
      <Harness client={client.client} connected routeRunId={undefined} pollIntervalMs={1000} {...spies} />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.listProjectsCalls).toBe(1);

    // Poll introduces a run with an unknown project id -> exactly one refetch.
    client.setRuns([makeRun({ id: 'r1', projectId: 'p1' }), makeRun({ id: 'r2', projectId: 'p-missing' })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(client.listProjectsCalls).toBe(2);

    // The id is still missing after the refetch; further polls do not refetch again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(client.listProjectsCalls).toBe(2);
    expect(screen.getByTestId('proj-r2').textContent).toBe('—');
  });
});
