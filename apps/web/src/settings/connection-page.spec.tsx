/**
 * Connection page tests: write-only labels, Save gating/behavior, Cancel, Test
 * connection result states and failure mapping, typed-token safety (no store, no
 * app-wide authorization change on 401), and stored-token testing via the app client.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBearerToken, hasBearerToken, writeBearerToken } from '../auth/token-store.js';
import {
  ControlPlaneClientProvider,
  useControlPlaneConnection,
  type ControlPlaneConnection
} from '../client/client-provider.js';
import { ConnectionPage } from './connection-page.js';

const STORED_LABEL = 'Bearer token (leave blank to keep existing)';

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

function Capture(): ReactNode {
  captured = useControlPlaneConnection();
  return null;
}

const fetchStub: typeof globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  if (url.includes('/v1/projects')) {
    calls.push({ url, authorization: authHeader(init) });
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

beforeEach(() => {
  mode = 'ok';
  calls.length = 0;
  captured = undefined;
});

afterEach(() => {
  clearBearerToken();
  vi.restoreAllMocks();
});

describe('ConnectionPage labels and save gating', () => {
  it('labels "Bearer token" with nothing stored and disables Save until a value is typed', async () => {
    renderPage();
    expect(screen.getByLabelText('Bearer token')).toBeDefined();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true');

    await userEvent.type(screen.getByLabelText('Bearer token'), 'tok');
    expect(save.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('saves the token, clears the field, shows Saved, and switches to the stored label', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Bearer token'), 'the-token');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(hasBearerToken()).toBe(true);
    expect(screen.getByText('Saved')).toBeDefined();
    const field = screen.getByLabelText(STORED_LABEL) as HTMLInputElement;
    expect(field.value).toBe('');
  });

  it('cancels by clearing the field and resetting status', async () => {
    renderPage();
    const field = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(field, 'abc');
    expect(field.value).toBe('abc');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((screen.getByLabelText('Bearer token') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Not tested')).toBeDefined();
  });
});

describe('ConnectionPage test connection', () => {
  it('shows Connected on success without storing the typed token', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Bearer token'), 'typed');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected')).toBeDefined();
    // Successful test does not save.
    expect(hasBearerToken()).toBe(false);
    // The typed token rode the call.
    expect(calls.at(-1)?.authorization).toBe('Bearer typed');
  });

  it('maps a 401 to the rejected-token fix and leaves the typed value', async () => {
    mode = 'unauthorized';
    renderPage();
    const field = screen.getByLabelText('Bearer token') as HTMLInputElement;
    await userEvent.type(field, 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(
      screen.getByText('The control plane rejected the token. Check the bearer token the server was started with.')
    ).toBeDefined();
    expect((screen.getByLabelText('Bearer token') as HTMLInputElement).value).toBe('wrong');
    // Typed-token 401 does not change app-wide authorization.
    expect(captured?.authorization).toBe('unknown');
  });

  it('maps a network failure to the unreachable fix', async () => {
    mode = 'network';
    renderPage();
    await userEvent.type(screen.getByLabelText('Bearer token'), 'typed');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(
      screen.getByText('The control plane did not answer. Check that it is running.')
    ).toBeDefined();
  });

  it('maps another status to Failed with status and error code', async () => {
    mode = 'server';
    renderPage();
    await userEvent.type(screen.getByLabelText('Bearer token'), 'typed');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(screen.getByText('Status 500, internal_error.')).toBeDefined();
  });
});

describe('ConnectionPage stored-token testing', () => {
  it('is disabled when neither a typed nor a stored token exists', () => {
    renderPage();
    const test = screen.getByRole('button', { name: 'Test connection' });
    expect(test.getAttribute('aria-disabled')).toBe('true');
  });

  it('tests the stored token through the app client when the field is empty', async () => {
    writeBearerToken('stored-token');
    renderPage();
    // With a stored token, the label reflects it and the field is empty.
    expect(screen.getByLabelText(STORED_LABEL)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected')).toBeDefined();
    expect(calls.at(-1)?.authorization).toBe('Bearer stored-token');
  });

  it('flips app-wide authorization on a stored-token 401 (app client is observed)', async () => {
    writeBearerToken('stored-token');
    mode = 'unauthorized';
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Failed')).toBeDefined();
    expect(captured?.authorization).toBe('unauthorized');
  });
});
