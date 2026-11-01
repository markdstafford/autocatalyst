/**
 * Foundation page rendering tests.
 *
 * With the SDK's fetch stubbed: a successful health check renders highlighted JSON
 * containing the status, a rejected call renders a concise failure message with no
 * stack trace, and the page never calls `fetch` directly (it goes through the SDK
 * client provider).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { ThemeProvider } from '../theme/theme-provider.js';
import { FoundationPage } from './foundation-page.js';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function renderPage(stub: typeof globalThis.fetch): void {
  render(
    <ThemeProvider>
      <ControlPlaneClientProvider fetch={stub}>
        <FoundationPage />
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FoundationPage', () => {
  it('shows the Autocatalyst heading and a Check connection button', () => {
    renderPage(async () => jsonResponse({ status: 'ok', database: { status: 'reachable' } }, 200));
    expect(screen.getByRole('heading', { name: 'Autocatalyst' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeDefined();
  });

  it('renders highlighted health JSON on success without calling fetch directly', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    renderPage(async () => jsonResponse({ status: 'ok', database: { status: 'reachable' } }, 200));

    await user.click(screen.getByRole('button', { name: 'Check connection' }));

    const output = await screen.findByLabelText('health response');
    expect(output.textContent ?? '').toContain('"status": "ok"');
    // The component used the injected SDK fetch, not the global fetch.
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('shows a concise failure message with no stack trace on error', async () => {
    const user = userEvent.setup();
    renderPage(async () => {
      throw new Error('network unreachable at line 42');
    });

    await user.click(screen.getByRole('button', { name: 'Check connection' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not reach the control plane.');
    expect(alert.textContent).not.toContain('line 42');
    expect(screen.queryByLabelText('health response')).toBeNull();
  });
});
