import { describe, expect, it } from 'vitest';

import type { ProbeResource } from '@autocatalyst/api-contract';

import {
  createProbeResource,
  getProbeResource,
  type ProbeResourceRepository
} from './probe-resource.js';

describe('probe-resource use cases', () => {
  it('creates resources through the repository interface', async () => {
    const created: ProbeResource = {
      id: 'probe_1',
      value: 'from core',
      createdAt: '2026-06-08T12:00:00.000Z'
    };
    const repository: ProbeResourceRepository = {
      create: async (input) => ({ ...created, value: input.value }),
      findById: async () => null
    };

    await expect(createProbeResource(repository, { value: 'from core' })).resolves.toEqual(created);
  });

  it('returns the found resource or null', async () => {
    const resource: ProbeResource = {
      id: 'probe_2',
      value: 'read path',
      createdAt: '2026-06-08T12:00:00.000Z'
    };
    const repository: ProbeResourceRepository = {
      create: async () => resource,
      findById: async (id) => (id === resource.id ? resource : null)
    };

    await expect(getProbeResource(repository, 'probe_2')).resolves.toEqual(resource);
    await expect(getProbeResource(repository, 'missing')).resolves.toBeNull();
  });
});
