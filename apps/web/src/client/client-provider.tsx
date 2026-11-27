/**
 * Control-plane SDK client provider.
 *
 * Components reach the control plane only through the typed SDK client supplied
 * here — never a direct `fetch` — so authorization and error handling stay in one
 * place. The client is built from `window.location.origin` and the current bearer
 * token, and is rebuilt whenever the token changes.
 *
 * Authorization state: the provider observes 401 responses. Collection reads
 * report their own 401 after checking ownership, so a retired view cannot
 * change the authorization state. The wrapper never exposes the token.
 */
import { runCollectionPath } from '@autocatalyst/api-contract';
import { createControlPlaneClient, type ControlPlaneClient } from '@autocatalyst/sdk';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

import { clearBearerToken, readBearerToken, writeBearerToken } from '../auth/token-store.js';

const UNAUTHORIZED_STATUS = 401;

/** Connection authorization state, readable by connection UI. */
export type AuthorizationState = 'unknown' | 'authorized' | 'unauthorized';

export interface ControlPlaneConnection {
  /** The typed SDK client. Rebuilt when the token changes. */
  readonly client: ControlPlaneClient;
  /** Current authorization state; `unauthorized` after a current 401. */
  readonly authorization: AuthorizationState;
  /** Report a 401 from a still-current run list read. */
  reportListUnauthorized(client: ControlPlaneClient): void;
  /** Store a new bearer token and rebuild the client. */
  setToken(token: string): void;
  /** Clear the bearer token and rebuild the client. */
  clearToken(): void;
  /**
   * Build a throwaway client scoped to `token`, over the same base fetch seam
   * but **without** the provider's observing wrapper. The Connection page uses
   * this to test a typed token: a 401 from this client must not flip app-wide
   * `authorization`, and the typed token is never stored. Discard after the call.
   */
  createTestClient(token: string): ControlPlaneClient;
}

const ConnectionContext = createContext<ControlPlaneConnection | undefined>(undefined);

export interface ControlPlaneClientProviderProps {
  readonly children: ReactNode;
  /**
   * Test seam: the underlying fetch implementation. Defaults to the global
   * `fetch`. Production never sets this.
   */
  readonly fetch?: typeof globalThis.fetch;
}

export function ControlPlaneClientProvider({
  children,
  fetch: fetchImpl
}: ControlPlaneClientProviderProps): ReactNode {
  const [token, setTokenState] = useState<string | undefined>(() => readBearerToken());
  const [unauthorizedClient, setUnauthorizedClient] = useState<ControlPlaneClient>();
  const activeClient = useRef<ControlPlaneClient | undefined>(undefined);

  const baseFetch = fetchImpl ?? globalThis.fetch;

  const client = useMemo<ControlPlaneClient>(() => {
    const observingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (response.status === UNAUTHORIZED_STATUS && activeClient.current === scopedClient) {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method !== 'GET' || new URL(url, window.location.origin).pathname !== runCollectionPath) {
          setUnauthorizedClient(scopedClient);
        }
      }
      return response;
    };
    const scopedClient = createControlPlaneClient({
      baseUrl: window.location.origin,
      fetch: observingFetch,
      ...(token !== undefined ? { bearerToken: token } : {})
    });
    return scopedClient;
  }, [token, baseFetch]);

  useLayoutEffect(() => {
    activeClient.current = client;
    return () => { activeClient.current = undefined; };
  }, [client]);
  const authorization: AuthorizationState = unauthorizedClient === client ? 'unauthorized' : 'unknown';

  const reportListUnauthorized = useCallback((source: ControlPlaneClient): void => {
    if (activeClient.current === source) setUnauthorizedClient(source);
  }, []);

  const setToken = useCallback((next: string): void => {
    writeBearerToken(next);
    setUnauthorizedClient(undefined);
    setTokenState(next);
  }, []);

  const clearToken = useCallback((): void => {
    clearBearerToken();
    setUnauthorizedClient(undefined);
    setTokenState(undefined);
  }, []);

  const createTestClient = useCallback(
    (testToken: string): ControlPlaneClient =>
      createControlPlaneClient({
        baseUrl: window.location.origin,
        fetch: baseFetch,
        bearerToken: testToken
      }),
    [baseFetch]
  );

  const value = useMemo<ControlPlaneConnection>(
    () => ({ client, authorization, reportListUnauthorized, setToken, clearToken, createTestClient }),
    [client, authorization, reportListUnauthorized, setToken, clearToken, createTestClient]
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/** Read the full connection (client, authorization state, token controls). */
export function useControlPlaneConnection(): ControlPlaneConnection {
  const value = useContext(ConnectionContext);
  if (value === undefined) {
    throw new Error('useControlPlaneConnection must be used within a ControlPlaneClientProvider.');
  }
  return value;
}

/** Convenience hook for the common case of needing only the SDK client. */
export function useControlPlaneClient(): ControlPlaneClient {
  return useControlPlaneConnection().client;
}
