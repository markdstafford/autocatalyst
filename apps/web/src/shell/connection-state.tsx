/**
 * Shell-level connection state: two independent flags the footer connection
 * indicator reads.
 *
 * `healthLost` is written only by the health probe (the unauthenticated `/health`
 * poll). `listLost` is written only by the run list module. The footer shows the
 * lost indicator when either is set, and each source clears only its own flag:
 * health success never clears `listLost`, list success never clears `healthLost`,
 * and the run list clears `listLost` when it unmounts (off the runs route the footer
 * follows `healthLost` alone).
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export interface ConnectionState {
  readonly healthLost: boolean;
  readonly listLost: boolean;
  setHealthLost(lost: boolean): void;
  setListLost(lost: boolean): void;
}

const ConnectionStateContext = createContext<ConnectionState | undefined>(undefined);

export function ConnectionStateProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [healthLost, setHealthLost] = useState(false);
  const [listLost, setListLost] = useState(false);
  const value = useMemo<ConnectionState>(
    () => ({ healthLost, listLost, setHealthLost, setListLost }),
    [healthLost, listLost]
  );
  return <ConnectionStateContext.Provider value={value}>{children}</ConnectionStateContext.Provider>;
}

/** Read the connection state, or `undefined` when no provider is present. */
export function useConnectionStateOptional(): ConnectionState | undefined {
  return useContext(ConnectionStateContext);
}

/** Read the connection state; throws when used outside a provider. */
export function useConnectionState(): ConnectionState {
  const value = useConnectionStateOptional();
  if (value === undefined) {
    throw new Error('useConnectionState must be used within a ConnectionStateProvider.');
  }
  return value;
}
