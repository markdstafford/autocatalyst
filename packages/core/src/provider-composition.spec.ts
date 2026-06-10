import { describe, expect, it } from 'vitest';

import type { ConfigurationRecord } from '@autocatalyst/api-contract';
import { getAgentProviderAdapterKey } from '@autocatalyst/execution';

import { createExtensionRegistryCatalog } from './extension-registry.js';
import {
  buildProviderAdapterKey,
  composeAgentProviderAdapterRegistry,
  composeConfiguredProviders,
  emptyProviderAdapterMap,
  type ProviderAdapterMap
} from './provider-composition.js';

const validAdapter = {
  providerKind: 'anthropic',
  adapterId: 'claude-agent-sdk',
  supportedConnectionMechanism: 'process_environment' as const,
  startSession: async () => ({
    events: (async function* () {})(),
    metadata: Promise.resolve({
      outcome: 'succeeded' as const,
      launchMechanism: 'process_environment' as const,
      degradedCapabilities: [],
      tokenUsage: { available: false }
    })
  })
};

const validBinding = {
  providerKind: 'anthropic',
  adapterId: 'claude-agent-sdk',
  configurationRecordId: 'rec_001',
  adapter: validAdapter
};

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

function makeAdapterMap(entries: readonly [string, () => unknown | Promise<unknown>][]): ProviderAdapterMap {
  return new Map(entries.map(([adapterId, factory]) => [buildProviderAdapterKey('model_runner', adapterId), factory]));
}

describe('composeConfiguredProviders', () => {
  it('returns empty diagnostics when no provider configuration records exist', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [],
      registry: createExtensionRegistryCatalog(),
      providerAdapters: emptyProviderAdapterMap
    });

    expect(result).toEqual({ composed: [], warnings: [], unresolved: [] });
  });

  it('ignores non-provider records when future record kinds are present', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [{ ...makeProviderRecord(), kind: 'future_kind' } as ConfigurationRecord],
      registry: createExtensionRegistryCatalog(),
      providerAdapters: makeAdapterMap([['fake-registered-model', () => ({ kind: 'fake-adapter' })]])
    });

    expect(result).toEqual({ composed: [], warnings: [], unresolved: [] });
  });

  it('composes a registered and resolvable provider without registry warnings', async () => {
    const adapter = { kind: 'fake-adapter' };
    const record = makeProviderRecord();
    const result = await composeConfiguredProviders({
      configurationRecords: [record],
      registry: createExtensionRegistryCatalog([
        { providerKind: 'model_runner', adapterId: 'fake-registered-model', displayName: 'Fake', capabilities: ['agent_session'] }
      ]),
      providerAdapters: makeAdapterMap([['fake-registered-model', () => adapter]])
    });

    expect(result.warnings).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.composed).toEqual([
      {
        providerKind: 'model_runner',
        adapterId: 'fake-registered-model',
        configurationRecordId: 'cfg_123',
        adapter
      }
    ]);
  });

  it('composes an unregistered but resolvable provider and keeps the advisory warning', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [makeProviderRecord({ adapterId: 'fake-unregistered-model' })],
      registry: createExtensionRegistryCatalog(),
      providerAdapters: makeAdapterMap([['fake-unregistered-model', async () => ({ kind: 'async-fake-adapter' })]])
    });

    expect(result.composed).toHaveLength(1);
    expect(result.composed[0]).toMatchObject({
      providerKind: 'model_runner',
      adapterId: 'fake-unregistered-model',
      configurationRecordId: 'cfg_123'
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'adapter_not_registered',
        configurationRecordId: 'cfg_123',
        providerKind: 'model_runner',
        adapterId: 'fake-unregistered-model'
      })
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('reports a registry-listed but unresolved provider without creating a binding', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [makeProviderRecord({ adapterId: 'fake-unresolved-model' })],
      registry: createExtensionRegistryCatalog([
        { providerKind: 'model_runner', adapterId: 'fake-unresolved-model', displayName: 'Fake unresolved', capabilities: [] }
      ]),
      providerAdapters: emptyProviderAdapterMap
    });

    expect(result.composed).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        configurationRecordId: 'cfg_123',
        providerKind: 'model_runner',
        adapterId: 'fake-unresolved-model',
        reason: 'adapter_not_found',
        message: 'Configuration record cfg_123 uses providerKind "model_runner" and adapterId "fake-unresolved-model", but no adapter factory was registered for that pair.'
      }
    ]);
  });

  it('reports both registry warning and unresolved diagnostic when metadata and code are absent', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [makeProviderRecord({ adapterId: 'fake-missing-model' })],
      registry: createExtensionRegistryCatalog(),
      providerAdapters: emptyProviderAdapterMap
    });

    expect(result.composed).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('adapter_not_registered');
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toBe('adapter_not_found');
  });

  it('derives warnings from registry metadata and not adapter-map membership alone', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [makeProviderRecord({ adapterId: 'mapped-but-unregistered' })],
      registry: createExtensionRegistryCatalog(),
      providerAdapters: makeAdapterMap([['mapped-but-unregistered', () => ({ kind: 'mapped' })]])
    });

    expect(result.composed).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.unresolved).toEqual([]);
  });

  it('captures synchronous factory throws and promise rejections as unresolved diagnostics', async () => {
    const throwingRecord = makeProviderRecord({ id: 'cfg_throw', adapterId: 'throws' });
    const rejectingRecord = makeProviderRecord({ id: 'cfg_reject', adapterId: 'rejects' });
    const result = await composeConfiguredProviders({
      configurationRecords: [throwingRecord, rejectingRecord],
      registry: createExtensionRegistryCatalog([
        { providerKind: 'model_runner', adapterId: 'throws', displayName: 'Throws', capabilities: [] },
        { providerKind: 'model_runner', adapterId: 'rejects', displayName: 'Rejects', capabilities: [] }
      ]),
      providerAdapters: makeAdapterMap([
        ['throws', () => { throw new Error('secret failure details'); }],
        ['rejects', async () => { throw new Error('async secret failure details'); }]
      ])
    });

    expect(result.composed).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        configurationRecordId: 'cfg_throw',
        providerKind: 'model_runner',
        adapterId: 'throws',
        reason: 'adapter_factory_failed',
        message: 'Configuration record cfg_throw uses providerKind "model_runner" and adapterId "throws", but its adapter factory failed during startup composition.'
      },
      {
        configurationRecordId: 'cfg_reject',
        providerKind: 'model_runner',
        adapterId: 'rejects',
        reason: 'adapter_factory_failed',
        message: 'Configuration record cfg_reject uses providerKind "model_runner" and adapterId "rejects", but its adapter factory failed during startup composition.'
      }
    ]);
  });

  it('preserves input order independently in composed, warnings, and unresolved arrays', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [
        makeProviderRecord({ id: 'cfg_first', adapterId: 'registered-resolved' }),
        makeProviderRecord({ id: 'cfg_second', adapterId: 'unregistered-resolved' }),
        makeProviderRecord({ id: 'cfg_third', adapterId: 'registered-unresolved' })
      ],
      registry: createExtensionRegistryCatalog([
        { providerKind: 'model_runner', adapterId: 'registered-resolved', displayName: 'Resolved', capabilities: [] },
        { providerKind: 'model_runner', adapterId: 'registered-unresolved', displayName: 'Unresolved', capabilities: [] }
      ]),
      providerAdapters: makeAdapterMap([
        ['registered-resolved', () => ({ kind: 'first' })],
        ['unregistered-resolved', () => ({ kind: 'second' })]
      ])
    });

    expect(result.composed.map((binding) => binding.configurationRecordId)).toEqual(['cfg_first', 'cfg_second']);
    expect(result.warnings.map((warning) => warning.configurationRecordId)).toEqual(['cfg_second']);
    expect(result.unresolved.map((diagnostic) => diagnostic.configurationRecordId)).toEqual(['cfg_third']);
  });

  it('does not collide when providerKind or adapterId contains the delimiter character', async () => {
    const adapterForAB_C = { kind: 'adapter-ab-c' };
    const adapterForA_BC = { kind: 'adapter-a-bc' };
    const adapterMap: ProviderAdapterMap = new Map([
      [buildProviderAdapterKey('a:b', 'c'), () => adapterForAB_C],
      [buildProviderAdapterKey('a', 'b:c'), () => adapterForA_BC]
    ]);
    const result = await composeConfiguredProviders({
      configurationRecords: [
        makeProviderRecord({ id: 'cfg_ab_c', providerKind: 'a:b', adapterId: 'c' }),
        makeProviderRecord({ id: 'cfg_a_bc', providerKind: 'a', adapterId: 'b:c' })
      ],
      registry: createExtensionRegistryCatalog(),
      providerAdapters: adapterMap
    });

    expect(result.unresolved).toEqual([]);
    expect(result.composed).toHaveLength(2);
    expect(result.composed[0]).toMatchObject({ configurationRecordId: 'cfg_ab_c', providerKind: 'a:b', adapterId: 'c', adapter: adapterForAB_C });
    expect(result.composed[1]).toMatchObject({ configurationRecordId: 'cfg_a_bc', providerKind: 'a', adapterId: 'b:c', adapter: adapterForA_BC });
  });

  it('constructs binding identity from the configuration record instead of adapter output', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [makeProviderRecord()],
      registry: createExtensionRegistryCatalog([
        { providerKind: 'model_runner', adapterId: 'fake-registered-model', displayName: 'Fake', capabilities: [] }
      ]),
      providerAdapters: makeAdapterMap([
        ['fake-registered-model', () => ({ providerKind: 'malicious', adapterId: 'malicious', configurationRecordId: 'malicious' })]
      ])
    });

    expect(result.composed[0]).toMatchObject({
      providerKind: 'model_runner',
      adapterId: 'fake-registered-model',
      configurationRecordId: 'cfg_123'
    });
    expect(result.composed[0].adapter).toEqual({
      providerKind: 'malicious',
      adapterId: 'malicious',
      configurationRecordId: 'malicious'
    });
  });
});

describe('composeAgentProviderAdapterRegistry', () => {
  it('returns empty registry when composed list is empty', () => {
    const registry = composeAgentProviderAdapterRegistry({ composed: [] });
    expect(registry.size).toBe(0);
  });

  it('valid binding is narrowed into registry with correct key', () => {
    const registry = composeAgentProviderAdapterRegistry({ composed: [validBinding] });
    expect(registry.size).toBe(1);
    const key = getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk');
    expect(registry.get(key)).toBe(validAdapter);
  });

  it('throws ProviderConfigurationError with unsupported_adapter code when adapter shape is invalid', () => {
    const badBinding = {
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      configurationRecordId: 'rec_002',
      adapter: {}
    };
    expect(() => composeAgentProviderAdapterRegistry({ composed: [badBinding] })).toThrow(
      expect.objectContaining({ name: 'ProviderConfigurationError', code: 'unsupported_adapter' })
    );
  });

  it('throws ProviderConfigurationError on duplicate (providerKind, adapterId) pair', () => {
    const secondBinding = {
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      configurationRecordId: 'rec_003',
      adapter: validAdapter
    };
    expect(() => composeAgentProviderAdapterRegistry({ composed: [validBinding, secondBinding] })).toThrow(
      expect.objectContaining({ name: 'ProviderConfigurationError', code: 'unsupported_adapter' })
    );
  });
});
