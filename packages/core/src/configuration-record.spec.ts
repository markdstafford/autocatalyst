import { describe, expect, it, vi } from 'vitest';

import type { ConfigurationRecord } from '@autocatalyst/api-contract';

import {
  createConfigurationRecord,
  deleteConfigurationRecord,
  getConfigurationRecord,
  listConfigurationRecords,
  updateConfigurationRecord,
  type ConfigurationRecordRepository
} from './configuration-record.js';

const TEST_TENANT = 'tenant_dev';

function makeRecord(overrides: Partial<ConfigurationRecord> = {}): ConfigurationRecord {
  return {
    id: 'cfg_123',
    tenant: TEST_TENANT,
    kind: 'provider_profile',
    providerKind: 'model_runner',
    adapterId: 'openai',
    settings: { profileName: 'default' },
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    ...overrides
  } as ConfigurationRecord;
}

describe('configuration record use cases', () => {
  it('delegates create to the repository', async () => {
    const record = makeRecord();
    const repository: ConfigurationRecordRepository = {
      create: vi.fn(async () => record),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };

    const input = {
      tenant: TEST_TENANT,
      kind: 'provider_profile' as const,
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default' }
    };
    await expect(createConfigurationRecord(repository, input)).resolves.toEqual(record);
    expect(repository.create).toHaveBeenCalledWith(input);
  });

  it('delegates list to the repository', async () => {
    const records = [makeRecord()];
    const repository: ConfigurationRecordRepository = {
      create: vi.fn(async () => makeRecord()),
      list: vi.fn(async () => records),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };

    await expect(listConfigurationRecords(repository, TEST_TENANT)).resolves.toEqual(records);
    expect(repository.list).toHaveBeenCalledWith(TEST_TENANT);
  });

  it('delegates getConfigurationRecord to repository findById and returns null when missing', async () => {
    const repository: ConfigurationRecordRepository = {
      create: vi.fn(async () => makeRecord()),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };

    await expect(getConfigurationRecord(repository, TEST_TENANT, 'cfg_missing')).resolves.toBeNull();
    expect(repository.findById).toHaveBeenCalledWith(TEST_TENANT, 'cfg_missing');
  });

  it('delegates update and returns null for missing ids', async () => {
    const repository: ConfigurationRecordRepository = {
      create: vi.fn(async () => makeRecord()),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };

    const patch = { kind: 'provider_profile' as const, settings: { credentialSecretHandle: null } };
    await expect(updateConfigurationRecord(repository, TEST_TENANT, 'cfg_missing', patch)).resolves.toBeNull();
    expect(repository.update).toHaveBeenCalledWith(TEST_TENANT, 'cfg_missing', patch);
  });

  it('delegates delete and returns false for missing ids', async () => {
    const repository: ConfigurationRecordRepository = {
      create: vi.fn(async () => makeRecord()),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };

    await expect(deleteConfigurationRecord(repository, TEST_TENANT, 'cfg_missing')).resolves.toBe(false);
    expect(repository.delete).toHaveBeenCalledWith(TEST_TENANT, 'cfg_missing');
  });
});
