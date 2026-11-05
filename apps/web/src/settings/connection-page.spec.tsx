/**
 * Connection page tests: the apply-on-commit flow that replaced Test/Save/Cancel.
 *
 * Covered: the page renders only the write-only field and a status line (no
 * Test/Save/Cancel/Saved controls and no native required validation); a non-empty
 * typed token commits on `Enter` or an in-document blur and nothing commits on an
 * empty field, a window-loss blur, or a blur that leaves focus on the field; a
 * successful check stores the token once through `setToken`, clears the field, shows
 * `Connected`, and switches the label; `401`, other-status, and network failures show
 * `Failed` plus the mapped fix, store nothing, keep the typed value, and never flip
 * app-wide authorization; the in-flight state is read-only/`aria-busy`, keeps focus,
 * and ignores duplicate `Enter`/blur; the status lifecycle (edit clears `Connected`,
 * `Escape` clears `Failed`, a new commit replaces the prior result); `Escape` rules;
 * the shell `settingsCheckPending` flag is set while checking and cleared after; and a
 * forced unmount mid-check sets no page-local state.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBearerToken, hasBearerToken, writeBearerToken } from '../auth/token-store.js';
import {
  ControlPlaneClientProvider,
  useControlPlaneConnection,
  type ControlPlaneConnection
} from '../client/client-provider.js';
import { ConnectionStateProvider, useConnectionState } from '../shell/connection-state.js';
import { ConnectionPage } from './connection-page.js';

const STORED_LABEL = 'Bearer token (leave blank to keep existing)';
const REJECTED_FIX =
  'The control plane rejected the token. Check the bearer token the server was started with.';
const UNREACHABLE_FIX = 'The control plane did not answer. Check that it is running.';

type Mode = 'ok' | 'unauthorized' | 'server' | 'network';

interface RecordedCall {
  readonly url: string;
  readonly authorization: string | undefined;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function authHeader(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get('authorization') ?? undefined;
  if (Array.isArray(headers)) return headers.find(([n]) => n.toLowerCase() === 'authorization')?.[1];
  const record = headers as Record<string, string>;
  return record['authorization'] ?? record['Authorization'];
}

let mode: Mode = 'ok';
const calls: RecordedCall[] = [];
let captured: ControlPlaneConnection | undefined;
// Optional gate: when set, `/v1/projects` awaits it, so a test can observe the
// in-flight ("Checking") state before releasing the check.
let gate: Promise<void> | undefined;
let releaseGate: (() => void) | undefined;

function openGate(): void {
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
}

function Capture(): ReactNode {
  captured = useControlPlaneConnection();
  return null;
}

const fetchStub: typeof globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (url.includes('/v1/projects')) {
    calls.push({ url, authorization: authHeader(init) });
    if (gate !== undefined) {
      await gate;
    }
    if (mode === 'network') throw new Error('offline');
    if (mode === 'unauthorized') {
      return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
    }
    if (mode === 'server') {
      return jsonResponse({ error: { code: 'internal_error', message: 'boom' } }, 500);
    }
    return jsonResponse({ projects: [] }, 200);
  }
  if (mode === 'network') throw new Error('offline');
  return jsonResponse({}, 200);
};

function renderPage(): void {
  render(
    <ControlPlaneClientProvider fetch={fetchStub}>
      <ConnectionPage />
      <Capture />
    </ControlPlaneClientProvider>
  );
}

/** Pending-state probe: exposes the shell `settingsCheckPending` flag as text. */
function PendingProbe(): ReactNode {
  const { settingsCheckPending } = useConnectionState();
  return <span data-testid="pending">{String(settingsCheckPending)}</span>;
}

function renderPageWithShellState(): void {
  render(
    <ControlPlaneClientProvider fetch={fetchStub}>
      <ConnectionStateProvider>
        <ConnectionPage />
        <PendingProbe />
        <Capture />
      </ConnectionStateProvider>
    </ControlPlaneClientProvider>
  );
}

function field(): HTMLInputElement {
  // Either label state maps to the same control.
  const byPlain = screen.queryByLabelText('Bearer token');
  return (byPlain ?? screen.getByLabelText(STORED_LABEL)) as HTMLInputElement;
}

beforeEach(() => {
  mode = 'ok';
  calls.length = 0;
  captured = undefined;
  gate = undefined;
  releaseGate = undefined;
  // Default: the window/tab has focus, so an in-document blur is commit intent.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  clearBearerToken();
  vi.restoreAllMocks();
});

describe('ConnectionPage rendering', () => {
  it('renders the token field and a status line, and no Test/Save/Cancel/Saved controls', () => {
    renderPage();
    expect(screen.getByLabelText('Bearer token')).toBeDefined();
    expect(screen.getByRole('status')).toBeDefined();
    for (const name of ['Test connection', 'Save', 'Cancel']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.queryByText('Not tested')).toBeNull();
  });

  it('starts with an empty status line (no stored token, no typed value, no check)', () => {
    renderPage();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('uses noValidate so Enter in an empty field shows no native validation bubble and sends no request', () => {
    const { container } = render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <ConnectionPage />
      </ControlPlaneClientProvider>
    );
    const form = container.querySelector('form');
    expect(form?.hasAttribute('novalidate')).toBe(true);
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    expect(input.hasAttribute('required')).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(calls).toHaveLength(0);
  });
});

describe('ConnectionPage commit on Enter', () => {
  it('checks the typed value through the throwaway client, stores it once, clears the field, and shows Connected', async () => {
    renderPage();
    const setTokenSpy = vi.spyOn(captured!, 'setToken');
    const testClientSpy = vi.spyOn(captured!, 'createTestClient');

    await userEvent.type(field(), 'the-token');
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(await screen.findByText('Connected')).toBeDefined();
    expect(testClientSpy).toHaveBeenCalledWith('the-token');
    expect(setTokenSpy).toHaveBeenCalledTimes(1);
    expect(setTokenSpy).toHaveBeenCalledWith('the-token');
    expect(hasBearerToken()).toBe(true);
    // The typed value rode the check.
    expect(calls.at(-1)?.authorization).toBe('Bearer the-token');
    // Field cleared and the label now reflects the stored token.
    expect((screen.getByLabelText(STORED_LABEL) as HTMLInputElement).value).toBe('');
  });

  it('sends no request for an empty field', () => {
    renderPage();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(calls).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('ConnectionPage commit on blur', () => {
  it('commits when focus moves to another element in the document', async () => {
    render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <ConnectionPage />
        <button type="button">elsewhere</button>
      </ControlPlaneClientProvider>
    );
    await userEvent.type(screen.getByLabelText('Bearer token'), 'tok');
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(await screen.findByText('Connected')).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('commits on a blur to document.body (in-page click) exactly once', async () => {
    renderPage();
    const input = field();
    await userEvent.type(input, 'tok');
    input.focus();
    // Focus leaves the field to document.body (an in-page click on blank space): the
    // real blur() moves activeElement to the body and dispatches the blur event.
    input.blur();
    expect(await screen.findByText('Connected')).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('ignores a blur while the window/tab has lost focus (document.hasFocus() is false)', async () => {
    renderPage();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const input = field();
    await userEvent.type(input, 'partial');
    fireEvent.blur(input);
    expect(calls).toHaveLength(0);
    // The draft survives the window-loss blur.
    expect(input.value).toBe('partial');
  });

  it('ignores a blur when activeElement is still the field', async () => {
    renderPage();
    const input = field();
    await userEvent.type(input, 'tok');
    input.focus();
    // A spurious blur that leaves focus on the field itself is not commit intent.
    fireEvent.blur(input, { relatedTarget: input });
    expect(calls).toHaveLength(0);
  });

  it('sends no request on blur of an empty field', async () => {
    render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <ConnectionPage />
        <button type="button">elsewhere</button>
      </ControlPlaneClientProvider>
    );
    screen.getByLabelText('Bearer token').focus();
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(calls).toHaveLength(0);
  });
});

describe('ConnectionPage failure handling', () => {
  it('maps a 401 to the rejected-token fix, keeps the value, stores nothing, and does not flip authorization', async () => {
    mode = 'unauthorized';
    renderPage();
    await userEvent.type(field(), 'wrong');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(screen.getByText(REJECTED_FIX)).toBeDefined();
    expect(field().value).toBe('wrong');
    expect(hasBearerToken()).toBe(false);
    // The throwaway-client 401 must not change app-wide authorization.
    expect(captured?.authorization).toBe('unknown');
  });

  it('maps another status to Failed with the status and error code', async () => {
    mode = 'server';
    renderPage();
    await userEvent.type(field(), 'tok');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(screen.getByText('Status 500, internal_error.')).toBeDefined();
    expect(hasBearerToken()).toBe(false);
  });

  it('maps a network failure to the unreachable fix', async () => {
    mode = 'network';
    renderPage();
    await userEvent.type(field(), 'tok');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(screen.getByText(UNREACHABLE_FIX)).toBeDefined();
  });

  it('returns the field to editable after a failed check', async () => {
    mode = 'unauthorized';
    renderPage();
    await userEvent.type(field(), 'wrong');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(field().readOnly).toBe(false);
  });
});

describe('ConnectionPage checking state', () => {
  it('is read-only, keeps focus, exposes aria-busy, and shows the spinner while checking', async () => {
    openGate();
    const { container } = render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <ConnectionPage />
      </ControlPlaneClientProvider>
    );
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(input, 'tok');
    input.focus();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Checking')).toBeDefined();
    const busy = screen.getByLabelText('Bearer token') as HTMLInputElement;
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.readOnly).toBe(true);
    expect(document.activeElement).toBe(busy);
    expect(container.querySelector('[data-testid="input-spinner"]')).not.toBeNull();

    await act(async () => {
      releaseGate?.();
    });
    expect(await screen.findByText('Connected')).toBeDefined();
  });

  it('ignores a second Enter and a blur while a check is in flight (one request only)', async () => {
    openGate();
    render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <ConnectionPage />
      </ControlPlaneClientProvider>
    );
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(input, 'tok');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Checking')).toBeDefined();

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(calls).toHaveLength(1);

    await act(async () => {
      releaseGate?.();
    });
    expect(await screen.findByText('Connected')).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe('ConnectionPage status lifecycle', () => {
  it('clears Connected when the operator edits the field', async () => {
    renderPage();
    await userEvent.type(field(), 'tok');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Connected')).toBeDefined();
    await userEvent.type(field(), 'x');
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('replaces a prior result with Checking on a new commit', async () => {
    mode = 'unauthorized';
    renderPage();
    await userEvent.type(field(), 'wrong');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeDefined();

    // A new commit (still failing here) first shows Checking, then the new result.
    openGate();
    await userEvent.clear(field());
    await userEvent.type(field(), 'again');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Checking')).toBeDefined();
    expect(screen.queryByText('Failed')).toBeNull();
    await act(async () => {
      releaseGate?.();
    });
    expect(await screen.findByText('Failed')).toBeDefined();
  });
});

describe('ConnectionPage Escape', () => {
  it('clears a typed value and the status, and sends no request', async () => {
    mode = 'unauthorized';
    renderPage();
    await userEvent.type(field(), 'wrong');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Failed')).toBeDefined();
    calls.length = 0;

    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field().value).toBe('');
    expect(screen.queryByText('Failed')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is ignored while checking (clears neither the field nor the status)', async () => {
    openGate();
    render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <ConnectionPage />
      </ControlPlaneClientProvider>
    );
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(input, 'tok');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Checking')).toBeDefined();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect((screen.getByLabelText('Bearer token') as HTMLInputElement).value).toBe('tok');
    expect(screen.getByText('Checking')).toBeDefined();

    await act(async () => {
      releaseGate?.();
    });
    expect(await screen.findByText('Connected')).toBeDefined();
  });

  it('with an empty field, does not clear status or stop propagation (falls through to the shell)', () => {
    renderPage();
    const input = field();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, 'stopPropagation');
    input.dispatchEvent(event);
    // No local handling: Escape bubbles so the shell can close the layer.
    expect(stopSpy).not.toHaveBeenCalled();
  });
});

describe('ConnectionPage shell pending flag', () => {
  it('sets settingsCheckPending while checking and clears it on success', async () => {
    openGate();
    renderPageWithShellState();
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(input, 'tok');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Checking')).toBeDefined();
    expect(screen.getByTestId('pending').textContent).toBe('true');

    await act(async () => {
      releaseGate?.();
    });
    expect(await screen.findByText('Connected')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('pending').textContent).toBe('false');
    });
  });

  it('clears settingsCheckPending on failure', async () => {
    mode = 'unauthorized';
    openGate();
    renderPageWithShellState();
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(input, 'wrong');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Checking')).toBeDefined();
    expect(screen.getByTestId('pending').textContent).toBe('true');
    await act(async () => {
      releaseGate?.();
    });
    expect(await screen.findByText('Failed')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('pending').textContent).toBe('false');
    });
  });
});

describe('ConnectionPage stored-token label', () => {
  it('shows the stored label and an empty field when a token is already stored', () => {
    writeBearerToken('stored');
    renderPage();
    expect((screen.getByLabelText(STORED_LABEL) as HTMLInputElement).value).toBe('');
  });
});

describe('ConnectionPage unmount during a check', () => {
  it('sets no page-local state after a forced unmount mid-check', async () => {
    openGate();
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const { unmount } = render(
      <ControlPlaneClientProvider fetch={fetchStub}>
        <ConnectionStateProvider>
          <ConnectionPage />
          <PendingProbe />
        </ConnectionStateProvider>
      </ControlPlaneClientProvider>
    );
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(input, 'tok');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Checking')).toBeDefined();

    unmount();
    await act(async () => {
      releaseGate?.();
      await Promise.resolve();
    });
    // No "state update on an unmounted component" warning was emitted.
    const joined = errors.map((e) => String(e)).join('\n');
    expect(joined).not.toContain('unmounted');
  });
});
