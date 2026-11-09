/**
 * useCurrentPrincipalId tests: loads the principal id once when enabled, treats a lookup failure as
 * unknown identity (undefined), and stays undefined while disabled.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createScriptedDetailClient } from './scripted-detail-client.js';
import { useCurrentPrincipalId } from './use-current-principal.js';

describe('useCurrentPrincipalId', () => {
  it('loads the current principal id once when enabled', async () => {
    const scripted = createScriptedDetailClient();
    scripted.setPrincipal({ id: 'user-9', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' });
    const { result } = renderHook(() => useCurrentPrincipalId(scripted.client, true));
    await waitFor(() => expect(result.current).toBe('user-9'));
    expect(scripted.counts.principal).toBe(1);
  });

  it('is undefined (unknown identity) when the lookup fails', async () => {
    const scripted = createScriptedDetailClient();
    scripted.setPrincipal(undefined); // makes getPrincipal reject
    const { result } = renderHook(() => useCurrentPrincipalId(scripted.client, true));
    await waitFor(() => expect(scripted.counts.principal).toBe(1));
    expect(result.current).toBeUndefined();
  });

  it('does not load while disabled', () => {
    const scripted = createScriptedDetailClient();
    renderHook(() => useCurrentPrincipalId(scripted.client, false));
    expect(scripted.counts.principal).toBe(0);
  });
});
