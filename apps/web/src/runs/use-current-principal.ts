/**
 * Load the connected operator's principal id once per client.
 *
 * The spec gate needs the current operator's principal id to: (a) show the approve popover's
 * "also confirms K of your addressed comments" copy, and (b) decide whether a card's Resolve/Reopen
 * actions belong to the current operator (`feedback.thread[0].author.id`). The id comes from the
 * existing diagnostic `GET /v1/principal` route through the SDK's `getPrincipal()`.
 *
 * Identity is non-fatal: a failed lookup leaves the id `undefined` (unknown). Callers then omit the
 * addressed-confirmation copy and hide originator-only lifecycle actions, while the control plane
 * stays authoritative for 403/409. The id reloads when the client changes (a new bearer token) so it
 * never carries a stale operator across a reconnection.
 */
import type { ControlPlaneClient } from '@autocatalyst/sdk';
import { useEffect, useState } from 'react';

/**
 * Return the current operator principal id, or `undefined` while loading, when disabled, or when the
 * lookup failed (unknown identity). Loads once whenever `client` or `enabled` changes.
 */
export function useCurrentPrincipalId(client: ControlPlaneClient, enabled: boolean): string | undefined {
  const [principalId, setPrincipalId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setPrincipalId(undefined);
      return;
    }
    let cancelled = false;
    // Clear any prior operator before the new lookup resolves so copy/actions never show a stale id.
    setPrincipalId(undefined);
    void (async () => {
      try {
        const { principal } = await client.getPrincipal();
        if (!cancelled) {
          setPrincipalId(principal.id);
        }
      } catch {
        // Unknown identity is non-fatal: leave the id undefined.
        if (!cancelled) {
          setPrincipalId(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, enabled]);

  return principalId;
}
