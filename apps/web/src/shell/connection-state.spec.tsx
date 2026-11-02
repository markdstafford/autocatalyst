/**
 * Connection-state tests: the footer indicator reflects healthLost || listLost, and
 * each source clears only its own flag — health success does not clear listLost, and
 * list success does not clear healthLost.
 */
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { ConnectionStateProvider, useConnectionState } from './connection-state.js';
import { HealthIndicator } from './health-indicator.js';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function Controls(): ReactNode {
  const { setHealthLost, setListLost } = useConnectionState();
  return (
    <>
      <button onClick={() => setListLost(true)}>list lost</button>
      <button onClick={() => setListLost(false)}>list ok</button>
      <button onClick={() => setHealthLost(true)}>health lost</button>
      <button onClick={() => setHealthLost(false)}>health ok</button>
    </>
  );
}

function renderWithProviders(fetchStub: typeof globalThis.fetch, intervalMs = 100000): void {
  render(
    <ControlPlaneClientProvider fetch={fetchStub}>
      <ConnectionStateProvider>
        <HealthIndicator intervalMs={intervalMs} />
        <Controls />
      </ConnectionStateProvider>
    </ControlPlaneClientProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('connection state', () => {
  it('shows the indicator when either flag is set and health success does not clear listLost', async () => {
    const okFetch: typeof globalThis.fetch = async () =>
      jsonResponse({ status: 'ok', database: { status: 'reachable' } }, 200);
    vi.useFakeTimers();
    renderWithProviders(okFetch, 100);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('Connection lost')).toBeNull();

    // List reports lost; indicator appears.
    await act(async () => {
      screen.getByText('list lost').click();
    });
    expect(screen.getByText('Connection lost')).toBeDefined();

    // A successful health poll must not clear the list flag.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('Connection lost')).toBeDefined();

    // Clearing the list flag (list success) removes the indicator.
    await act(async () => {
      screen.getByText('list ok').click();
    });
    expect(screen.queryByText('Connection lost')).toBeNull();
  });

  it('list success does not clear a health-driven lost state', async () => {
    const downFetch: typeof globalThis.fetch = async () => {
      throw new Error('down');
    };
    vi.useFakeTimers();
    renderWithProviders(downFetch, 100);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Connection lost')).toBeDefined();

    // List success clears only listLost; health is still lost.
    await act(async () => {
      screen.getByText('list ok').click();
    });
    expect(screen.getByText('Connection lost')).toBeDefined();
  });
});
