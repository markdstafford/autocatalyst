/**
 * Footer health indicator.
 *
 * Calls `getHealth` on load, every 5 seconds, and when the window regains focus.
 * `/health` needs no bearer token, so this never depends on authorization: a 401
 * from a protected call elsewhere flips the provider's authorization state but does
 * not touch this indicator. A healthy control plane shows nothing; a degraded status
 * or a failed request shows an 8 px red dot and "Connection lost" in red.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { useControlPlaneClient } from '../client/client-provider.js';

const DEFAULT_INTERVAL_MS = 5000;

export interface HealthIndicatorProps {
  /** Poll interval in ms. Defaults to 5 seconds; overridable for tests. */
  readonly intervalMs?: number;
}

export function HealthIndicator({ intervalMs = DEFAULT_INTERVAL_MS }: HealthIndicatorProps): ReactNode {
  const client = useControlPlaneClient();
  const [lost, setLost] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      try {
        const health = await client.getHealth();
        if (!cancelled) {
          setLost(health.status !== 'ok');
        }
      } catch {
        // Network/unreachable failure counts as lost; a protected-route 401 never
        // reaches here because getHealth is unauthenticated.
        if (!cancelled) {
          setLost(true);
        }
      }
    }
    void check();
    const id = window.setInterval(() => {
      void check();
    }, intervalMs);
    const onFocus = (): void => {
      void check();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [client, intervalMs]);

  if (!lost) {
    return null;
  }
  return (
    <span aria-live="polite" className="flex items-center gap-1.5 text-sm text-red">
      <span aria-hidden className="size-2 rounded-full bg-red" />
      Connection lost
    </span>
  );
}
