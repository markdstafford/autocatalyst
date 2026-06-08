import { describe, expect, it, vi } from 'vitest';

import { authorizeRequest, permissivePolicyDecisionPoint } from './policy.js';
import { hardcodedDevelopmentPrincipal } from './principal.js';

describe('policy decision point', () => {
  it('allows every request with the permissive implementation', async () => {
    await expect(
      permissivePolicyDecisionPoint.authorize({
        principal: hardcodedDevelopmentPrincipal,
        action: 'probe_resource.create',
        resource: { kind: 'probe_resource_collection', path: '/v1/probe-resources' }
      })
    ).resolves.toEqual({ allowed: true });
  });

  it('routes authorization through an injectable policy', async () => {
    const authorize = vi.fn(async () => ({ allowed: true as const }));
    await authorizeRequest(
      { authorize },
      {
        principal: hardcodedDevelopmentPrincipal,
        action: 'configuration_record.list',
        resource: { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
      }
    );
    expect(authorize).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      action: 'configuration_record.list',
      resource: { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
    });
  });
});
