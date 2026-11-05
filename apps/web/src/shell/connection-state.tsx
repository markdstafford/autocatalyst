/**
 * Shell-level connection state: independent flags the footer connection indicator
 * and the settings close guard read.
 *
 * `healthLost` is written only by the health probe (the unauthenticated `/health`
 * poll). `listLost` is written only by the run list module. The footer shows the
 * lost indicator when either is set, and each source clears only its own flag:
 * health success never clears `listLost`, list success never clears `healthLost`,
 * and the run list clears `listLost` when it unmounts (off the runs route the footer
 * follows `healthLost` alone).
 *
 * `settingsCheckPending` is written only by the Connection page while a token check
 * is in flight. The shell's `closeSettings` reads it to refuse leaving settings until
 * the result is visible, and the settings sidebar reads it to show Back as
 * soft-disabled. Because a close attempt and the blur that starts the check can land
 * in the same user gesture before React re-renders, the guard reads the live value
 * through `isSettingsCheckPending()` (a ref), not the rendered `settingsCheckPending`
 * boolean, so the refusal never depends on render timing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

export interface ConnectionState {
  readonly healthLost: boolean;
  readonly listLost: boolean;
  /** Whether the Connection page is checking a token (drives the close guard/UI). */
  readonly settingsCheckPending: boolean;
  setHealthLost(lost: boolean): void;
  setListLost(lost: boolean): void;
  setSettingsCheckPending(pending: boolean): void;
  /**
   * Read the live pending flag synchronously, unaffected by render timing. The close
   * guard uses this so a blur-started check in the same gesture as a close attempt is
   * always observed.
   */
  isSettingsCheckPending(): boolean;
}

const ConnectionStateContext = createContext<ConnectionState | undefined>(undefined);

export function ConnectionStateProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [healthLost, setHealthLost] = useState(false);
  const [listLost, setListLost] = useState(false);
  const [settingsCheckPending, setSettingsCheckPendingState] = useState(false);
  const settingsCheckPendingRef = useRef(false);

  const setSettingsCheckPending = useCallback((pending: boolean): void => {
    settingsCheckPendingRef.current = pending;
    setSettingsCheckPendingState(pending);
  }, []);
  const isSettingsCheckPending = useCallback((): boolean => settingsCheckPendingRef.current, []);

  const value = useMemo<ConnectionState>(
    () => ({
      healthLost,
      listLost,
      settingsCheckPending,
      setHealthLost,
      setListLost,
      setSettingsCheckPending,
      isSettingsCheckPending
    }),
    [healthLost, listLost, settingsCheckPending, setSettingsCheckPending, isSettingsCheckPending]
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
