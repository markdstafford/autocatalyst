/**
 * The Connection settings page.
 *
 * An operator provides the control plane bearer token here. The field is write-only:
 * it never receives or displays the stored token, and the page is handed only the
 * token-presence boolean. Saving writes through the #131 token store (which rebuilds
 * the SDK client), clears the field, and shows "Saved". Testing calls `listProjects`:
 * a typed token is tested through a throwaway `createTestClient`, so a typed-token 401
 * never changes app-wide authorization and the typed value is never stored.
 *
 * Secret-handling: the token appears in no status text, no accessible name, no log,
 * and no URL. Failure messages are mapped from the error's status/code only.
 */
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';

import { useControlPlaneConnection } from '../client/client-provider.js';
import { hasBearerToken } from '../auth/token-store.js';
import { Button } from '../ui/button.js';
import { WriteOnlySecretField } from '../ui/write-only-secret-field.js';
import { SettingsPage } from './settings-page.js';

const REJECTED_TOKEN_FIX =
  'The control plane rejected the token. Check the bearer token the server was started with.';
const UNREACHABLE_FIX = 'The control plane did not answer. Check that it is running.';

type TestStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'testing' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'failed'; readonly fix: string };

const DOT_CLASSES: Readonly<Record<TestStatus['kind'], string>> = {
  idle: 'bg-overlay',
  testing: 'bg-overlay',
  connected: 'bg-green',
  failed: 'bg-red'
};

const LABELS: Readonly<Record<TestStatus['kind'], string>> = {
  idle: 'Not tested',
  testing: 'Testing',
  connected: 'Connected',
  failed: 'Failed'
};

/** Map a thrown test error to a one-line suggested fix. Never includes the token. */
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
  const [storedPresent, setStoredPresent] = useState<boolean>(() => hasBearerToken());
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<TestStatus>({ kind: 'idle' });
  const [saved, setSaved] = useState(false);

  const hasTyped = typed.length > 0;
  const testDisabled = !hasTyped && !storedPresent;
  const running = status.kind === 'testing';

  const handleSave = useCallback((): void => {
    if (!hasTyped) {
      return;
    }
    connection.setToken(typed);
    setTyped('');
    setStoredPresent(true);
    setSaved(true);
    setStatus({ kind: 'idle' });
  }, [connection, hasTyped, typed]);

  const handleCancel = useCallback((): void => {
    setTyped('');
    setSaved(false);
    setStatus({ kind: 'idle' });
  }, []);

  const handleTest = useCallback(async (): Promise<void> => {
    if (testDisabled || running) {
      return;
    }
    setSaved(false);
    setStatus({ kind: 'testing' });
    try {
      // Typed value: throwaway client that bypasses the observing fetch wrapper, so a
      // 401 never flips app-wide authorization and the typed token is not stored.
      // Empty field with a stored token: the app client (its 401 is observed).
      const client = hasTyped ? connection.createTestClient(typed) : connection.client;
      await client.listProjects();
      setStatus({ kind: 'connected' });
    } catch (error) {
      setStatus({ kind: 'failed', fix: failureFix(error) });
    }
  }, [connection, hasTyped, running, testDisabled, typed]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
  };

  return (
    <SettingsPage
      title="Connection"
      description="Provide the control plane bearer token to reach protected routes."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <WriteOnlySecretField
          hasStoredValue={storedPresent}
          value={typed}
          onValueChange={(next) => {
            setTyped(next);
          }}
          required
        />

        <div role="status" className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-sm">
            <span aria-hidden className={`size-2 rounded-full ${DOT_CLASSES[status.kind]}`} />
            <span className={status.kind === 'failed' ? 'text-red' : 'text-subtext'}>
              {LABELS[status.kind]}
            </span>
          </span>
          {status.kind === 'failed' ? <span className="text-sm text-subtext">{status.fix}</span> : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            aria-disabled={testDisabled || running}
            onClick={() => {
              void handleTest();
            }}
          >
            Test connection
          </Button>
          <div className="flex-1" />
          {saved ? <span className="text-sm text-green">Saved</span> : null}
          <Button type="button" variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            aria-disabled={!hasTyped}
            onClick={handleSave}
          >
            Save
          </Button>
        </div>
      </form>
    </SettingsPage>
  );
}
