/**
 * Health indicator transitions with the SDK `fetch` stubbed: ok shows nothing,
 * degraded and a network error show "Connection lost", and recovery clears it. A 401
 * on a protected call is not exercised here because the indicator only calls the
 * unauthenticated `/health` route.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { HealthIndicator } from './health-indicator.js';

type Mode = 'ok' | 'degraded' | 'network';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthIndicator', () => {
  it('shows nothing when ok, "Connection lost" on degraded/network, and clears on recovery', async () => {
    let mode: Mode = 'ok';
    const fetchStub: typeof globalThis.fetch = async (input) => {
      if (requestUrl(input).endsWith('/health')) {
        if (mode === 'network') throw new Error('down');
        if (mode === 'degraded') {
          return jsonResponse({ status: 'degraded', database: { status: 'unreachable' } }, 503);
        }
        return jsonResponse({ status: 'ok', database: { status: 'reachable' } }, 200);
      }
      return jsonResponse({}, 200);
    };

    vi.useFakeTimers();
    render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <HealthIndicator intervalMs={100} />
      </ControlPlaneClientProvider>
    );

    // Initial check (ok): no indicator.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('Connection lost')).toBeNull();

    // Degraded: indicator appears.
    mode = 'degraded';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('Connection lost')).toBeDefined();

    // Network error: still lost.
    mode = 'network';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('Connection lost')).toBeDefined();

    // Recovery: indicator clears without any token entry.
    mode = 'ok';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.queryByText('Connection lost')).toBeNull();
  });
});
