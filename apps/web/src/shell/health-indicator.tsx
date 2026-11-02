/**
 * Footer connection indicator.
 *
 * It polls the unauthenticated `/health` route on load, every 5 seconds, and on
 * window focus, and writes only the `healthLost` flag of the shell connection state
 * (a protected-route 401 never reaches here). It renders "Connection lost" whenever
 * *either* connection flag is set — `healthLost || listLost` — so the run list's
 * `listLost` shows through the same indicator. Used without a connection-state
 * provider (isolated tests), it falls back to local health state.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useControlPlaneClient } from '../client/client-provider.js';
import { useConnectionStateOptional } from './connection-state.js';

const DEFAULT_INTERVAL_MS = 5000;

export interface HealthIndicatorProps {
  /** Poll interval in ms. Defaults to 5 seconds; overridable for tests. */
  readonly intervalMs?: number;
}

export function HealthIndicator({ intervalMs = DEFAULT_INTERVAL_MS }: HealthIndicatorProps): ReactNode {
  const client = useControlPlaneClient();
  const connection = useConnectionStateOptional();
  const [localLost, setLocalLost] = useState(false);

  // Read the latest setter through a ref so the poll effect never re-subscribes.
  const setHealthLostRef = useRef<(lost: boolean) => void>(setLocalLost);
  setHealthLostRef.current = connection?.setHealthLost ?? setLocalLost;

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      try {
        const health = await client.getHealth();
        if (!cancelled) {
          setHealthLostRef.current(health.status !== 'ok');
        }
      } catch {
        // Network/unreachable failure counts as lost; a protected-route 401 never
        // reaches here because getHealth is unauthenticated.
        if (!cancelled) {
          setHealthLostRef.current(true);
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

  const lost = connection !== undefined ? connection.healthLost || connection.listLost : localLost;

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
