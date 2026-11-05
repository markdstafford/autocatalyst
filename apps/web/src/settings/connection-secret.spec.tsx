/**
 * Secret-redaction tests for the Connection page's apply-on-commit flow.
 *
 * With a sentinel token, the token must never leak into visible text, accessible
 * names, status/failure messages, or console output after a successful commit or a
 * failed commit — and after a successful check the field is cleared, so the token is
 * gone from the DOM entirely.
 *
 * The one place the typed value legitimately lives is the password control itself
 * while the operator is entering/retrying it (masked, write-only, never stored); that
 * is the field's `value`, not display text, an accessible name, a log, or a message.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBearerToken } from '../auth/token-store.js';
import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { ConnectionPage } from './connection-page.js';

const SENTINEL = 'sentinel-bearer-DO-NOT-LEAK';

type Mode = 'ok' | 'unauthorized';
let mode: Mode = 'ok';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchStub: typeof globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('/v1/projects')) {
    if (mode === 'unauthorized') {
      return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
    }
    return jsonResponse({ projects: [] }, 200);
  }
  return jsonResponse({}, 200);
};

let consoleOutput: string[] = [];

beforeEach(() => {
  mode = 'ok';
  consoleOutput = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(' '));
    });
  }
});

afterEach(() => {
  clearBearerToken();
  vi.restoreAllMocks();
});

function renderPage(): void {
  render(
    <ControlPlaneClientProvider fetch={fetchStub}>
      <ConnectionPage />
    </ControlPlaneClientProvider>
  );
}

/** The token must not appear in visible text, accessible names, or console output. */
function assertNoLeakInTextOrLogs(): void {
  expect(document.body.textContent ?? '').not.toContain(SENTINEL);
  // No element exposes the token through an accessible name / aria text.
  for (const el of Array.from(document.querySelectorAll('*'))) {
    expect(el.getAttribute('aria-label') ?? '').not.toContain(SENTINEL);
    expect(el.getAttribute('aria-describedby') ?? '').not.toContain(SENTINEL);
    expect(el.getAttribute('title') ?? '').not.toContain(SENTINEL);
  }
  // The status/failure region never echoes the token.
  const status = document.querySelector('[role="status"]');
  expect(status?.textContent ?? '').not.toContain(SENTINEL);
  expect(consoleOutput.join('\n')).not.toContain(SENTINEL);
}

describe('Connection page secret redaction', () => {
  it('clears the token from the DOM entirely on a successful commit', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Bearer token'), SENTINEL);
    fireEvent.keyDown(screen.getByLabelText('Bearer token'), { key: 'Enter' });
    expect(await screen.findByText('Connected')).toBeDefined();
    // Field cleared on success: the token is gone from the DOM, not just hidden.
    expect(document.body.innerHTML).not.toContain(SENTINEL);
    assertNoLeakInTextOrLogs();
  });

  it('does not leak the token on a successful commit', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Bearer token'), SENTINEL);
    fireEvent.keyDown(screen.getByLabelText('Bearer token'), { key: 'Enter' });
    expect(await screen.findByText('Connected')).toBeDefined();
    assertNoLeakInTextOrLogs();
  });

  it('does not leak the token on a failed commit, including in the failure message', async () => {
    mode = 'unauthorized';
    renderPage();
    await userEvent.type(screen.getByLabelText('Bearer token'), SENTINEL);
    fireEvent.keyDown(screen.getByLabelText('Bearer token'), { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeDefined();
    assertNoLeakInTextOrLogs();
  });
});
