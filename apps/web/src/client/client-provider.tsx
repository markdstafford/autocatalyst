/**
 * Control-plane SDK client provider.
 *
 * Components reach the control plane only through the typed SDK client supplied
 * here — never a direct `fetch` — so authorization and error handling stay in one
 * place. The client is built from `window.location.origin` and the current bearer
 * token, and is rebuilt whenever the token changes.
 *
 * Authorization state: the provider wraps the client's `fetch` so that a `401`
 * from any call flips connection state to `unauthorized` without throwing the
 * `401` up to the route. #132's connection UI reads this state. The wrapper only
 * observes status codes; it never logs, stores, or exposes the token.
 */
import { createControlPlaneClient, type ControlPlaneClient } from '@autocatalyst/sdk';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
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
  /** Current authorization state; `unauthorized` after any 401. */
  readonly authorization: AuthorizationState;
  /** Store a new bearer token and rebuild the client. */
  setToken(token: string): void;
  /** Clear the bearer token and rebuild the client. */
  clearToken(): void;
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
  const [authorization, setAuthorization] = useState<AuthorizationState>('unknown');

  const baseFetch = fetchImpl ?? globalThis.fetch;

  const client = useMemo<ControlPlaneClient>(() => {
    const observingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (response.status === UNAUTHORIZED_STATUS) {
        setAuthorization('unauthorized');
      }
      return response;
    };
    return createControlPlaneClient({
      baseUrl: window.location.origin,
      fetch: observingFetch,
      ...(token !== undefined ? { bearerToken: token } : {})
    });
  }, [token, baseFetch]);

  const setToken = useCallback((next: string): void => {
    writeBearerToken(next);
    setAuthorization('unknown');
    setTokenState(next);
  }, []);

  const clearToken = useCallback((): void => {
    clearBearerToken();
    setAuthorization('unknown');
    setTokenState(undefined);
  }, []);

  const value = useMemo<ControlPlaneConnection>(
    () => ({ client, authorization, setToken, clearToken }),
    [client, authorization, setToken, clearToken]
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
