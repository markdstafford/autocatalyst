/**
 * SDK client provider security tests.
 *
 * With the SDK's `fetch` stubbed, these assert: protected calls carry
 * `Authorization: Bearer <token>`, `getHealth` carries none, a 401 flips
 * connection state to `unauthorized` without crashing the provider, and the
 * bearer token never leaks into request URLs, console output, thrown error
 * messages, or the DOM — including when the server is unreachable.
 */
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBearerToken, writeBearerToken } from '../auth/token-store.js';
import {
  ControlPlaneClientProvider,
  useControlPlaneConnection,
  type ControlPlaneConnection
} from './client-provider.js';

// A value that must never appear anywhere observable outside an Authorization header.
const SENTINEL_TOKEN = 'sentinel-bearer-DO-NOT-LEAK';

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

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

function authHeader(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get('authorization') ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([name]) => name.toLowerCase() === 'authorization');
    return found?.[1];
  }
  const record = headers as Record<string, string>;
  return record['authorization'] ?? record['Authorization'];
}

let connection: ControlPlaneConnection | undefined;

function Grab(): ReactNode {
  connection = useControlPlaneConnection();
  return <span data-testid="auth">{connection.authorization}</span>;
}

function renderWithStub(stub: typeof globalThis.fetch): void {
  render(
    <ControlPlaneClientProvider fetch={stub}>
      <Grab />
    </ControlPlaneClientProvider>
  );
}

function conn(): ControlPlaneConnection {
  if (connection === undefined) throw new Error('connection not captured');
  return connection;
}

beforeEach(() => {
  writeBearerToken(SENTINEL_TOKEN);
});

afterEach(() => {
  connection = undefined;
  clearBearerToken();
  vi.restoreAllMocks();
});

describe('ControlPlaneClientProvider', () => {
  it('sends no Authorization header on getHealth', async () => {
    const calls: RecordedCall[] = [];
    const stub: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return jsonResponse({ status: 'ok', database: { status: 'reachable' } }, 200);
    };
    renderWithStub(stub);

    await act(async () => {
      await conn().client.getHealth();
    });

    const healthCall = calls.find((c) => c.url.endsWith('/health'));
    expect(healthCall).toBeDefined();
    expect(authHeader(healthCall?.init)).toBeUndefined();
  });

  it('sends Authorization: Bearer <token> on protected calls', async () => {
    const calls: RecordedCall[] = [];
    const stub: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return jsonResponse({ projects: [] }, 200);
    };
    renderWithStub(stub);

    await act(async () => {
      await conn().client.listProjects();
    });

    const projectsCall = calls.find((c) => c.url.includes('/v1/projects'));
    expect(projectsCall).toBeDefined();
    expect(authHeader(projectsCall?.init)).toBe(`Bearer ${SENTINEL_TOKEN}`);
  });

  it('marks the connection unauthorized on a 401 without crashing the provider', async () => {
    const stub: typeof globalThis.fetch = async () =>
      jsonResponse({ error: { code: 'unauthorized', message: 'Unauthorized' } }, 401);
    renderWithStub(stub);

    expect(conn().authorization).toBe('unknown');

    await act(async () => {
      await conn()
        .client.listProjects()
        .catch(() => {
          // The route reads connection state; it does not rely on this throw.
        });
    });

    expect(conn().authorization).toBe('unauthorized');
  });

  it('never leaks the bearer token into URLs, console, errors, or the DOM', async () => {
    const consoleOutput: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((a) => String(a)).join(' '));
      });
    }

    const calls: RecordedCall[] = [];

    // Scenario 1: a 401 from a protected call.
    const unauthorizedStub: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return jsonResponse({ error: { code: 'unauthorized', message: 'Unauthorized' } }, 401);
    };
    renderWithStub(unauthorizedStub);
    let caughtMessage = '';
    await act(async () => {
      await conn()
        .client.listProjects()
        .catch((error: unknown) => {
          caughtMessage = error instanceof Error ? error.message : String(error);
        });
    });
    expect(caughtMessage).not.toContain(SENTINEL_TOKEN);

    // Scenario 2: the server is unreachable.
    const unreachableStub: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: requestUrl(input), init });
      throw new Error('network unreachable');
    };
    connection = undefined;
    render(
      <ControlPlaneClientProvider fetch={unreachableStub}>
        <Grab />
      </ControlPlaneClientProvider>
    );
    let unreachableMessage = '';
    await act(async () => {
      await conn()
        .client.getHealth()
        .catch((error: unknown) => {
          unreachableMessage = error instanceof Error ? error.message : String(error);
        });
    });
    expect(unreachableMessage).not.toContain(SENTINEL_TOKEN);

    // The token appears in no request URL, no console output, and no rendered DOM.
    for (const call of calls) {
      expect(call.url).not.toContain(SENTINEL_TOKEN);
    }
    expect(consoleOutput.join('\n')).not.toContain(SENTINEL_TOKEN);
    expect(document.body.innerHTML).not.toContain(SENTINEL_TOKEN);
  });
});
