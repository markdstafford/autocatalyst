/**
 * The foundation page served at `/runs`.
 *
 * This is a deliberately minimal placeholder (issue #132 replaces it with the
 * shell) whose job is to prove the browser runtime end to end: theme tokens,
 * routing, the client-owned `Button`/`Tooltip` wrappers, the typed SDK client,
 * and lazy Shiki highlighting.
 *
 * Clicking the icon-only connection button calls `getHealth()` through the SDK
 * client provider — never a direct `fetch` — and renders the response as
 * highlighted JSON once the lazy Shiki chunk loads. While the call is pending the
 * button is `aria-disabled` (not natively disabled) so its tooltip stays
 * available. On failure the page shows a concise message, never a stack trace.
 */
import type { HealthResponse } from '@autocatalyst/api-contract';
import { PlugZap } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';

import { useControlPlaneClient } from '../client/client-provider.js';
import { highlightJson } from '../highlight/highlight.js';
import { useTheme } from '../theme/theme-provider.js';
import { Button } from '../ui/button.js';
import { Tooltip } from '../ui/tooltip.js';

const CHECK_CONNECTION_LABEL = 'Check connection';
const FAILURE_MESSAGE = 'Could not reach the control plane.';

export function FoundationPage(): ReactNode {
  const client = useControlPlaneClient();
  const { resolvedTheme } = useTheme();
  const [pending, setPending] = useState(false);
  const [markup, setMarkup] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const checkConnection = useCallback(async (): Promise<void> => {
    setPending(true);
    setError(undefined);
    try {
      const health: HealthResponse = await client.getHealth();
      const json = JSON.stringify(health, null, 2);
      const html = await highlightJson(json, resolvedTheme.mode);
      setMarkup(html);
    } catch {
      // Show a concise message only; never surface a stack trace.
      setMarkup(undefined);
      setError(FAILURE_MESSAGE);
    } finally {
      setPending(false);
    }
  }, [client, resolvedTheme.mode]);

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 bg-background px-6 py-16 text-text">
      <h1 className="text-xl font-semibold tracking-tight">Autocatalyst</h1>

      <Tooltip label={CHECK_CONNECTION_LABEL}>
        <Button
          variant="secondary"
          aria-label={CHECK_CONNECTION_LABEL}
          aria-disabled={pending}
          onClick={() => {
            if (pending) {
              return;
            }
            void checkConnection();
          }}
          className="aspect-square px-0"
        >
          <PlugZap aria-hidden size={16} />
        </Button>
      </Tooltip>

      {markup !== undefined ? (
        <div
          aria-label="health response"
          className="w-full max-w-reading-column overflow-auto rounded-sm text-sm"
          // Trusted Shiki output generated from app-local JSON (the typed health
          // response); not user-controlled HTML.
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      ) : null}

      {error !== undefined ? (
        <p role="alert" className="text-subtext">
          {error}
        </p>
      ) : null}
    </main>
  );
}
