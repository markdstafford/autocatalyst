/**
 * The Connection settings page — write-only bearer token, applied on commit.
 *
 * An operator provides the control plane bearer token here. The field is write-only:
 * it never receives or displays the stored token, and the page is handed only the
 * token-presence boolean.
 *
 * Apply-on-commit flow (no Test/Save/Cancel controls): a non-empty typed token is
 * committed on `Enter` or an in-document blur. A commit tests the typed value through a
 * throwaway `createTestClient` (so a bad token never flips app-wide authorization and is
 * never stored), showing `Checking` while the request is in flight with the field in the
 * shared read-only busy state. On success the value is stored via `setToken`, the field
 * clears, and the status reads `Connected`; on failure nothing is stored, the typed value
 * stays editable, and `Failed` plus the mapped one-line fix is shown.
 *
 * Blur discipline: only an in-document blur commits. A blur while `document.hasFocus()`
 * is false (the window/tab lost focus — the operator switched to a password manager) or
 * while `document.activeElement` is still the field is ignored, so partial tokens are not
 * sent. Duplicate `Enter`/blur triggers are ignored while a check is in flight.
 *
 * Shell guard: while checking, the page sets shell-level `settingsCheckPending` so the
 * shared `closeSettings` keeps settings open (Back, settings toggle, empty-field Escape)
 * until the result is visible. The browser's own Back cannot be blocked, so an unmount
 * guard prevents page-local state updates after unmount.
 *
 * Escape: with a typed value it clears the field and the status and sends no request; it
 * is ignored while checking; with an empty field it falls through to shell layer handling.
 *
 * Secret-handling: the token appears in no status text, no accessible name, no log, and
 * no URL. Failure messages are mapped from the error's status/code only.
 */
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react';

import { useControlPlaneConnection } from '../client/client-provider.js';
import { hasBearerToken } from '../auth/token-store.js';
import { useConnectionStateOptional } from '../shell/connection-state.js';
import { WriteOnlySecretField } from '../ui/write-only-secret-field.js';
import { SettingsPage } from './settings-page.js';

const REJECTED_TOKEN_FIX =
  'The control plane rejected the token. Check the bearer token the server was started with.';
const UNREACHABLE_FIX = 'The control plane did not answer. Check that it is running.';

type CheckStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'failed'; readonly fix: string };

const DOT_CLASSES: Readonly<Record<Exclude<CheckStatus['kind'], 'idle'>, string>> = {
  checking: 'bg-overlay',
  connected: 'bg-green',
  failed: 'bg-red'
};

const LABELS: Readonly<Record<Exclude<CheckStatus['kind'], 'idle'>, string>> = {
  checking: 'Checking',
  connected: 'Connected',
  failed: 'Failed'
};

/** Map a thrown check error to a one-line suggested fix. Never includes the token. */
export function failureFix(error: unknown): string {
  if (error instanceof ControlPlaneClientError) {
    if (error.status === 401) {
      return REJECTED_TOKEN_FIX;
    }
    const code = error.response.error.code;
    return `Status ${error.status}${code.length > 0 ? `, ${code}` : ''}.`;
  }
  return UNREACHABLE_FIX;
}

export function ConnectionPage(): ReactNode {
  const connection = useControlPlaneConnection();
  const connectionState = useConnectionStateOptional();
  const [storedPresent, setStoredPresent] = useState<boolean>(() => hasBearerToken());
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<CheckStatus>({ kind: 'idle' });

  // Live in-flight marker, read synchronously so a second Enter/blur in the same gesture
  // cannot start a second request (state would not have re-rendered yet).
  const inFlightRef = useRef(false);
  // Defensive unmount guard: the browser's own Back cannot be blocked by the shell, so
  // a check can settle after this page unmounts; never set page-local state then.
  const mountedRef = useRef(true);
  // Hold the latest connection-state in a ref. Writing `settingsCheckPending` re-renders
  // the shell provider, changing its context value identity; keeping the dependency out
  // of the lifecycle effect (below) means that re-render does NOT fire the effect's
  // cleanup and wrongly clear the pending flag / in-flight marker mid-check. The ref
  // always points at the current provider so writes still target live state.
  const connectionStateRef = useRef(connectionState);
  connectionStateRef.current = connectionState;

  const setPending = useCallback((pending: boolean): void => {
    connectionStateRef.current?.setSettingsCheckPending(pending);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // If we unmount mid-check (e.g. browser Back), release the shell guard so settings
      // is never wedged shut by a flag no one will clear.
      if (inFlightRef.current) {
        inFlightRef.current = false;
        connectionStateRef.current?.setSettingsCheckPending(false);
      }
    };
    // Empty deps: this is a true mount/unmount lifecycle. The cleanup must run only on
    // unmount, never on a provider re-render triggered by our own pending write.
  }, []);

  const commit = useCallback((): void => {
    // Ignore duplicate commits while a check is in flight.
    if (inFlightRef.current) {
      return;
    }
    // Read the committed value once; empty values never commit or send a request.
    const committed = typed;
    if (committed.length === 0) {
      return;
    }
    inFlightRef.current = true;
    setStatus({ kind: 'checking' });
    setPending(true);
    void (async () => {
      try {
        // Throwaway client bypasses the observing fetch wrapper, so a 401 never flips
        // app-wide authorization and the typed token is not stored before success.
        const client = connection.createTestClient(committed);
        await client.listProjects();
        if (!mountedRef.current) {
          return;
        }
        connection.setToken(committed);
        setTyped('');
        setStoredPresent(true);
        setStatus({ kind: 'connected' });
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }
        setStatus({ kind: 'failed', fix: failureFix(error) });
      } finally {
        inFlightRef.current = false;
        setPending(false);
      }
    })();
  }, [connection, setPending, typed]);

  const handleValueChange = useCallback((next: string): void => {
    setTyped(next);
    // Editing retires a prior result so the status is never stale against the draft.
    setStatus((prev) =>
      prev.kind === 'connected' || prev.kind === 'failed' ? { kind: 'idle' } : prev
    );
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        // Single intended commit path. Prevent default so no native submit runs.
        event.preventDefault();
        commit();
        return;
      }
      if (event.key === 'Escape') {
        // While checking, the field is read-only and the request cannot be cancelled:
        // ignore Escape entirely (clear neither field nor status). The shell guard keeps
        // settings open if this propagates.
        if (inFlightRef.current) {
          return;
        }
        // With a typed value, Escape clears the draft and status locally and stops here
        // so no layer closes. With an empty field, let it fall through to shell handling.
        if (typed.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          setTyped('');
          setStatus({ kind: 'idle' });
        }
      }
    },
    [commit, typed]
  );

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>): void => {
      // Ignore duplicate commits and the empty field.
      if (inFlightRef.current || typed.length === 0) {
        return;
      }
      // Window/tab lost focus (operator switched apps): keep the draft, send nothing.
      if (!document.hasFocus()) {
        return;
      }
      // A spurious blur that leaves focus on the field itself is not commit intent.
      if (document.activeElement === event.currentTarget) {
        return;
      }
      // Focus moved to another in-document element or to document.body from an in-page
      // click: commit intent.
      commit();
    },
    [commit, typed]
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // Defensive only: Enter is handled in the input's onKeyDown. noValidate below keeps
    // an empty field from showing a native validation bubble.
    event.preventDefault();
  };

  const checking = status.kind === 'checking';

  return (
    <SettingsPage
      title="Connection"
      description="Provide the control plane bearer token to reach protected routes."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <WriteOnlySecretField
          hasStoredValue={storedPresent}
          value={typed}
          onValueChange={handleValueChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          loading={checking}
        />

        <div role="status" className="flex flex-col gap-1">
          {status.kind !== 'idle' ? (
            <>
              <span className="flex items-center gap-2 text-sm">
                <span aria-hidden className={`size-2 rounded-full ${DOT_CLASSES[status.kind]}`} />
                <span className={status.kind === 'failed' ? 'text-red' : 'text-subtext'}>
                  {LABELS[status.kind]}
                </span>
              </span>
              {status.kind === 'failed' ? (
                <span className="text-sm text-subtext">{status.fix}</span>
              ) : null}
            </>
          ) : null}
        </div>
      </form>
    </SettingsPage>
  );
}
