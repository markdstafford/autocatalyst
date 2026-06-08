import { describe, expect, it } from 'vitest';

import type { ConfigurationRecord } from '@autocatalyst/api-contract';
import {
  InMemoryExtensionRegistryCatalog,
  createExtensionRegistryCatalog,
  defaultExtensionRegistryCatalog,
  validateProviderConfigurationAgainstRegistry
} from './extension-registry.js';

describe('extension registry catalog', () => {
  it('defaults to an empty metadata catalog', () => {
    expect(createExtensionRegistryCatalog().list()).toEqual([]);
    expect(defaultExtensionRegistryCatalog.list()).toEqual([]);
    expect(defaultExtensionRegistryCatalog.findProvider('model_runner', 'missing')).toBeUndefined();
  });

  it('lists configured entries and finds a provider by provider kind and adapter id', () => {
    const entry = {
      providerKind: 'model_runner',
      adapterId: 'fake-registered-model',
      displayName: 'Fake registered model runner',
      capabilities: ['agent_session', 'direct_completion'],
      description: 'Fake metadata for tests'
    };
    const catalog = createExtensionRegistryCatalog([entry]);

    expect(catalog.list()).toEqual([entry]);
    expect(catalog.findProvider('model_runner', 'fake-registered-model')).toEqual(entry);
    expect(catalog.findProvider('agent_runner', 'fake-registered-model')).toBeUndefined();
    expect(catalog.findProvider('model_runner', 'other')).toBeUndefined();
  });

  it('rejects duplicate provider kind and adapter id entries during construction', () => {
    const entries = [
      { providerKind: 'model_runner', adapterId: 'duplicate', displayName: 'First', capabilities: [] },
      { providerKind: 'model_runner', adapterId: 'duplicate', displayName: 'Second', capabilities: [] }
    ];

    expect(() => new InMemoryExtensionRegistryCatalog(entries)).toThrow(
      'Duplicate extension registry entry for providerKind "model_runner" and adapterId "duplicate".'
    );
  });
});

function makeProviderRecord(overrides: Partial<ConfigurationRecord> = {}): ConfigurationRecord {
  return {
    id: 'cfg_123',
    kind: 'provider_profile',
    providerKind: 'model_runner',
    adapterId: 'fake-registered-model',
    settings: { profileName: 'default', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' },
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
    ...overrides
  };
}

describe('validateProviderConfigurationAgainstRegistry', () => {
  it('returns no warning for provider-profile records with registry metadata', () => {
    const catalog = createExtensionRegistryCatalog([
      { providerKind: 'model_runner', adapterId: 'fake-registered-model', displayName: 'Fake', capabilities: [] }
    ]);

    expect(validateProviderConfigurationAgainstRegistry(makeProviderRecord(), catalog)).toEqual([]);
  });

  it('returns an advisory warning for provider-profile records absent from the registry', () => {
    const warning = validateProviderConfigurationAgainstRegistry(
      makeProviderRecord({ adapterId: 'fake-unregistered-model' }),
      createExtensionRegistryCatalog()
    );

    expect(warning).toEqual([
      {
        code: 'adapter_not_registered',
        configurationRecordId: 'cfg_123',
        providerKind: 'model_runner',
        adapterId: 'fake-unregistered-model',
        message: 'Configuration record cfg_123 uses providerKind "model_runner" and adapterId "fake-unregistered-model", which is not listed in the extension registry.'
      }
    ]);
    expect(warning[0].message).not.toContain('default');
    expect(warning[0].message).not.toContain('sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');
  });

  it('does not inspect adapter-map membership when generating registry warnings', () => {
    const catalog = createExtensionRegistryCatalog();

    expect(validateProviderConfigurationAgainstRegistry(makeProviderRecord(), catalog)).toHaveLength(1);
  });

  it('returns no registry warning for non-provider records that may be introduced later', () => {
    const nonProviderRecord = {
      ...makeProviderRecord(),
      kind: 'future_kind'
    } as ConfigurationRecord;

    expect(validateProviderConfigurationAgainstRegistry(nonProviderRecord, createExtensionRegistryCatalog())).toEqual([]);
  });
});
