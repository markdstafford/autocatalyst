import { describe, expect, it, vi } from 'vitest';

import type { ConfigurationRecord } from '@autocatalyst/api-contract';
import { getAgentProviderAdapterKey } from '@autocatalyst/execution';

import {
  ModelRoutingConfigurationError,
  createModelRoutingResolver,
  type ModelRoutingConfigurationReader,
  type CreateModelRoutingResolverOptions
} from './model-routing-resolver.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReader(records: ConfigurationRecord[]): ModelRoutingConfigurationReader {
  return {
    async listConfigurationRecords(tenant: string) {
      return records.filter((r) => r.tenant === tenant);
    },
    async findConfigurationRecordById(tenant: string, id: string) {
      return records.find((r) => r.tenant === tenant && r.id === id) ?? null;
    }
  };
}

function makeAgentAdapter(
  providerKind: string,
  adapterId: string,
  connectionMechanism: 'fetch_transport' | 'process_environment' = 'fetch_transport'
) {
  return {
    providerKind,
    adapterId,
    supportedConnectionMechanism: connectionMechanism,
    startSession: () => {
      throw new Error('not implemented');
    }
  };
}

function makeDirectAdapter(providerKind: string, adapterId: string) {
  return {
    providerKind,
    adapterId,
    supportedConnectionMechanism: 'fetch_transport' as const,
    call: () => {
      throw new Error('not implemented');
    }
  };
}

function makeAgentRegistry(...adapters: ReturnType<typeof makeAgentAdapter>[]) {
  const map = new Map<string, ReturnType<typeof makeAgentAdapter>>();
  for (const adapter of adapters) {
    map.set(getAgentProviderAdapterKey(adapter.providerKind, adapter.adapterId), adapter);
  }
  return map as unknown as import('@autocatalyst/execution').AgentProviderAdapterRegistry;
}

function makeDirectRegistry(...adapters: ReturnType<typeof makeDirectAdapter>[]) {
  const map = new Map<string, ReturnType<typeof makeDirectAdapter>>();
  for (const adapter of adapters) {
    map.set(getAgentProviderAdapterKey(adapter.providerKind, adapter.adapterId), adapter);
  }
  return map as unknown as import('@autocatalyst/execution').DirectProviderAdapterRegistry;
}

// ---------------------------------------------------------------------------
// Base test fixtures
// ---------------------------------------------------------------------------

const claudeProfile: ConfigurationRecord = {
  id: 'cfg_claude',
  tenant: 'tenant_a',
  kind: 'provider_profile',
  providerKind: 'anthropic',
  adapterId: 'claude-agent-sdk',
  settings: {
    profileName: 'Claude Sonnet',
    credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    endpoint: {}
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const openaiProfile: ConfigurationRecord = {
  id: 'cfg_openai',
  tenant: 'tenant_a',
  kind: 'provider_profile',
  providerKind: 'openai',
  adapterId: 'openai-agent-sdk',
  settings: {
    profileName: 'GPT-4o',
    credentialSecretHandle: 'sec_bbcdefghijklmnopqrstuvwxyzABCDEF',
    model: { provider: 'openai', model: 'gpt-4o' },
    inferenceSettings: {},
    endpoint: {}
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const directProfile: ConfigurationRecord = {
  id: 'cfg_direct',
  tenant: 'tenant_a',
  kind: 'provider_profile',
  providerKind: 'anthropic',
  adapterId: 'anthropic-direct',
  settings: {
    profileName: 'Claude Direct',
    credentialSecretHandle: 'sec_cccdefghijklmnopqrstuvwxyzABCDEF',
    model: { provider: 'anthropic', model: 'claude-haiku-4' },
    inferenceSettings: {},
    endpoint: {}
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const routingTable: ConfigurationRecord = {
  id: 'tbl_main',
  tenant: 'tenant_a',
  kind: 'model_routing_table',
  settings: {
    active: true,
    entries: [
      { id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_claude' },
      { id: 'r2', route: { mode: 'agent', step: 'impl', defaultForStep: true }, profileId: 'cfg_openai' },
      { id: 'r3', route: { mode: 'direct', step: 'classify' }, profileId: 'cfg_direct' }
    ]
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const claudeAgentAdapter = makeAgentAdapter('anthropic', 'claude-agent-sdk', 'fetch_transport');
const openaiAgentAdapter = makeAgentAdapter('openai', 'openai-agent-sdk', 'fetch_transport');
const directAdapter = makeDirectAdapter('anthropic', 'anthropic-direct');

function makeDefaultOptions(): CreateModelRoutingResolverOptions {
  return {
    configuration: makeReader([claudeProfile, openaiProfile, directProfile, routingTable]),
    agentAdapters: makeAgentRegistry(claudeAgentAdapter, openaiAgentAdapter),
    directAdapters: makeDirectRegistry(directAdapter)
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelRoutingConfigurationError', () => {
  it('has correct name and code', () => {
    const err = new ModelRoutingConfigurationError('route_not_found', 'test');
    expect(err.name).toBe('ModelRoutingConfigurationError');
    expect(err.code).toBe('route_not_found');
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ModelRoutingConfigurationError);
  });

  it('stores safeDetails', () => {
    const details = { tenant: 'tenant_a', step: 'impl' };
    const err = new ModelRoutingConfigurationError('profile_not_found', 'test', details);
    expect(err.safeDetails).toEqual(details);
  });
});

describe('createModelRoutingResolver', () => {
  it('returns an object with the three resolver methods', () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    expect(typeof resolver.resolveAgentRoute).toBe('function');
    expect(typeof resolver.resolveDirectRoute).toBe('function');
    expect(typeof resolver.resolveDistinctAgentRoutes).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Table loading
// ---------------------------------------------------------------------------

describe('resolveAgentRoute — table loading', () => {
  it('throws routing_table_missing when no active table', async () => {
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([]) // no records for tenant_a
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_a', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'routing_table_missing' });
  });

  it('throws routing_table_ambiguous when multiple active tables', async () => {
    const secondTable: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_second'
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfile, openaiProfile, routingTable, secondTable])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_a', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'routing_table_ambiguous' });
  });

  it('ignores inactive tables', async () => {
    const inactiveTable: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_inactive',
      settings: { ...routingTable.settings as import('@autocatalyst/api-contract').ModelRoutingTableSettings, active: false }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfile, openaiProfile, directProfile, routingTable, inactiveTable])
    };
    const resolver = createModelRoutingResolver(opts);
    const result = await resolver.resolveAgentRoute({ tenant: 'tenant_a', step: 'impl', role: 'implementer' });
    expect(result.routingTableId).toBe('tbl_main');
  });
});

// ---------------------------------------------------------------------------
// Route specificity — agent exact match
// ---------------------------------------------------------------------------

describe('resolveAgentRoute — exact match', () => {
  it('resolves with exact role match', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'implementer'
    });
    expect(result.routeId).toBe('r1');
    expect(result.profileId).toBe('cfg_claude');
    expect(result.routingTableId).toBe('tbl_main');
    expect(result.profile.providerKind).toBe('anthropic');
    expect(result.profile.adapterId).toBe('claude-agent-sdk');
    expect(result.profile.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
    expect(result.profile.mode).toBe('agent');
  });
});

// ---------------------------------------------------------------------------
// Route specificity — step-level default fallback
// ---------------------------------------------------------------------------

describe('resolveAgentRoute — default fallback', () => {
  it('falls back to step default when no exact role match', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'reviewer' // no exact route for this role
    });
    expect(result.routeId).toBe('r2');
    expect(result.profileId).toBe('cfg_openai');
    expect(result.profile.providerKind).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// Direct route match
// ---------------------------------------------------------------------------

describe('resolveDirectRoute', () => {
  it('resolves a direct route', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    const result = await resolver.resolveDirectRoute({ tenant: 'tenant_a', step: 'classify' });
    expect(result.routeId).toBe('r3');
    expect(result.profileId).toBe('cfg_direct');
    expect(result.profile.mode).toBe('direct');
  });
});

// ---------------------------------------------------------------------------
// Route errors
// ---------------------------------------------------------------------------

describe('route errors', () => {
  it('throws route_not_found for unmatched step', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_a', step: 'nonexistent', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'route_not_found' });
  });

  it('throws route_not_found for direct route that does not exist', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    await expect(
      resolver.resolveDirectRoute({ tenant: 'tenant_a', step: 'nonexistent' })
    ).rejects.toMatchObject({ code: 'route_not_found' });
  });

  it('ignores disabled routes and throws route_not_found when all matches are disabled', async () => {
    const tableWithDisabled: ConfigurationRecord = {
      id: 'tbl_disabled',
      tenant: 'tenant_b',
      kind: 'model_routing_table',
      settings: {
        active: true,
        entries: [
          { id: 'r_disabled', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_claude', enabled: false }
        ]
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([
        { ...claudeProfile, tenant: 'tenant_b' },
        tableWithDisabled
      ])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'route_not_found' });
  });

  it('throws duplicate_route for multiple enabled routes for the same key', async () => {
    // Note: we bypass schema validation by creating the records directly at the reader level
    const tableWithDupes: ConfigurationRecord = {
      id: 'tbl_dupes',
      tenant: 'tenant_b',
      kind: 'model_routing_table',
      settings: {
        active: true,
        // Inject duplicates directly (would fail schema validation in real API)
        entries: [
          { id: 'r_a', route: { mode: 'direct', step: 'classify' }, profileId: 'cfg_direct' },
          { id: 'r_b', route: { mode: 'direct', step: 'classify' }, profileId: 'cfg_direct' }
        ]
      } as import('@autocatalyst/api-contract').ModelRoutingTableSettings
    } as ConfigurationRecord;

    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: {
        async listConfigurationRecords(_tenant: string) {
          return [tableWithDupes];
        },
        async findConfigurationRecordById(_tenant: string, id: string) {
          return [{ ...directProfile, tenant: 'tenant_b' }].find((r) => r.id === id) ?? null;
        }
      }
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveDirectRoute({ tenant: 'tenant_b', step: 'classify' })
    ).rejects.toMatchObject({ code: 'duplicate_route' });
  });
});

// ---------------------------------------------------------------------------
// Profile validation
// ---------------------------------------------------------------------------

describe('profile validation', () => {
  it('throws profile_not_found when profile id does not exist', async () => {
    const tableWithMissingProfile: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_bad',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          { id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_nonexistent' }
        ]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([tableWithMissingProfile])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'profile_not_found' });
  });

  it('throws profile_not_found when the record is not a provider_profile kind', async () => {
    // Use a routing table record as the profile id
    const tableWithBadRef: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_bad2',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          { id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'tbl_other' }
        ]
      }
    };
    const otherTable: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_other',
      tenant: 'tenant_b',
      settings: { ...routingTable.settings as import('@autocatalyst/api-contract').ModelRoutingTableSettings, active: false }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([tableWithBadRef, otherTable])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'profile_not_found' });
  });

  it('throws profile_incomplete when model is missing', async () => {
    const incompleteProfile: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_no_model',
      tenant: 'tenant_b',
      settings: {
        profileName: 'Incomplete',
        credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
        // no model
        inferenceSettings: {},
        endpoint: {}
      }
    };
    const table: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_incomplete',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_model' }]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([incompleteProfile, table])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'profile_incomplete' });
  });

  it('throws profile_incomplete when inferenceSettings is undefined', async () => {
    const incompleteProfile: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_no_inf',
      tenant: 'tenant_b',
      settings: {
        profileName: 'Incomplete',
        credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
        model: { provider: 'anthropic', model: 'claude-sonnet-4' },
        // no inferenceSettings
        endpoint: {}
      }
    };
    const table: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_incomplete2',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_inf' }]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([incompleteProfile, table])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'profile_incomplete' });
  });

  it('does not throw profile_incomplete for inferenceSettings: {} (explicitly empty)', async () => {
    // The claude profile fixture already has inferenceSettings: {} — just verify it resolves
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_a', step: 'impl', role: 'implementer' })
    ).resolves.toMatchObject({ profileId: 'cfg_claude' });
  });

  it('throws profile_incomplete when endpoint is missing', async () => {
    const incompleteProfile: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_no_ep',
      tenant: 'tenant_b',
      settings: {
        profileName: 'Incomplete',
        credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
        model: { provider: 'anthropic', model: 'claude-sonnet-4' },
        inferenceSettings: {}
        // no endpoint
      }
    };
    const table: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_incomplete3',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_ep' }]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([incompleteProfile, table])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'profile_incomplete' });
  });

  it('throws profile_incomplete when credentialSecretHandle is missing', async () => {
    const incompleteProfile: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_no_cred',
      tenant: 'tenant_b',
      settings: {
        profileName: 'Incomplete',
        // no credentialSecretHandle
        model: { provider: 'anthropic', model: 'claude-sonnet-4' },
        inferenceSettings: {},
        endpoint: {}
      }
    };
    const table: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_incomplete4',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_cred' }]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([incompleteProfile, table])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'profile_incomplete' });
  });

  it('throws adapter_unavailable when no agent adapter exists for this profile', async () => {
    // Use a provider that has no registered adapter
    const unknownProviderProfile: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_unknown',
      providerKind: 'unknown_provider',
      adapterId: 'some-adapter',
      tenant: 'tenant_b'
    };
    const table: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_unknown',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_unknown' }]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([unknownProviderProfile, table])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'adapter_unavailable' });
  });

  it('throws route_mode_mismatch when agent route references a direct-only profile', async () => {
    // directProfile uses 'anthropic' / 'anthropic-direct' which is only in directAdapters
    const tableWithMismatch: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_mismatch',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          // Agent route pointing at a profile whose adapter is only in directAdapters
          { id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_direct_b' }
        ]
      }
    };
    const directProfileB: ConfigurationRecord = {
      ...directProfile,
      id: 'cfg_direct_b',
      tenant: 'tenant_b'
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      agentAdapters: makeAgentRegistry(), // no agent adapters at all
      directAdapters: makeDirectRegistry(directAdapter),
      configuration: makeReader([directProfileB, tableWithMismatch])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_b', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'route_mode_mismatch' });
  });

  it('throws route_mode_mismatch when direct route references an agent-only profile', async () => {
    const tableWithMismatch: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_mismatch2',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          // Direct route pointing at a profile whose adapter is only in agentAdapters
          { id: 'r1', route: { mode: 'direct', step: 'classify' }, profileId: 'cfg_claude_b' }
        ]
      }
    };
    const claudeProfileB: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_claude_b',
      tenant: 'tenant_b'
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      agentAdapters: makeAgentRegistry(claudeAgentAdapter),
      directAdapters: makeDirectRegistry(), // no direct adapters
      configuration: makeReader([claudeProfileB, tableWithMismatch])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveDirectRoute({ tenant: 'tenant_b', step: 'classify' })
    ).rejects.toMatchObject({ code: 'route_mode_mismatch' });
  });
});

// ---------------------------------------------------------------------------
// Resolved profile construction
// ---------------------------------------------------------------------------

describe('resolved profile construction', () => {
  it('sets correct fields on resolved profile', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'implementer'
    });
    expect(result.profile).toMatchObject({
      mode: 'agent',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      profileName: 'Claude Sonnet',
      configurationRecordId: 'cfg_claude',
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'fetch_transport'
    });
  });

  it('sets configurationRecordId to profile id', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'implementer'
    });
    expect(result.profile.configurationRecordId).toBe('cfg_claude');
  });

  it('derives authTarget=header from fetch_transport connectionMechanism', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'implementer'
    });
    expect(result.credentialReference.authTarget).toBe('header');
    expect(result.credentialReference.required).toBe(true);
  });

  it('derives authTarget=process_environment from process_environment connectionMechanism', async () => {
    const processEnvAdapter = makeAgentAdapter('anthropic', 'claude-agent-sdk', 'process_environment');
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      agentAdapters: makeAgentRegistry(processEnvAdapter, openaiAgentAdapter)
    };
    const resolver = createModelRoutingResolver(opts);
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'implementer'
    });
    expect(result.credentialReference.authTarget).toBe('process_environment');
  });

  it('sets secretHandle from credentialSecretHandle', async () => {
    const resolver = createModelRoutingResolver(makeDefaultOptions());
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'implementer'
    });
    expect(result.credentialReference.secretHandle).toBe('sec_abcdefghijklmnopqrstuvwxyzABCDEF');
  });
});

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

describe('credential validation', () => {
  it('calls validateCredentialReference and resolves when it passes', async () => {
    const validateCredentialReference = vi.fn().mockResolvedValue(undefined);
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      validateCredentialReference
    };
    const resolver = createModelRoutingResolver(opts);
    const result = await resolver.resolveAgentRoute({
      tenant: 'tenant_a',
      step: 'impl',
      role: 'implementer'
    });
    expect(validateCredentialReference).toHaveBeenCalledOnce();
    expect(result.profileId).toBe('cfg_claude');
  });

  it('throws credential_reference_invalid when validateCredentialReference throws', async () => {
    const validateCredentialReference = vi.fn().mockRejectedValue(new Error('invalid credential'));
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      validateCredentialReference
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveAgentRoute({ tenant: 'tenant_a', step: 'impl', role: 'implementer' })
    ).rejects.toMatchObject({ code: 'credential_reference_invalid' });
  });
});

// ---------------------------------------------------------------------------
// Role-distinct resolution
// ---------------------------------------------------------------------------

describe('resolveDistinctAgentRoutes', () => {
  it('resolves multiple roles successfully when distinctBy=model and models differ', async () => {
    // implementer -> claude, reviewer -> openai (different models)
    const tableWithTwoRoles: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_distinct',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          { id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_claude_b' },
          { id: 'r2', route: { mode: 'agent', step: 'impl', role: 'reviewer' }, profileId: 'cfg_openai_b' }
        ]
      }
    };
    const claudeProfileB: ConfigurationRecord = { ...claudeProfile, id: 'cfg_claude_b', tenant: 'tenant_b' };
    const openaiProfileB: ConfigurationRecord = { ...openaiProfile, id: 'cfg_openai_b', tenant: 'tenant_b' };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfileB, openaiProfileB, tableWithTwoRoles])
    };
    const resolver = createModelRoutingResolver(opts);
    const result = await resolver.resolveDistinctAgentRoutes({
      tenant: 'tenant_b',
      step: 'impl',
      roles: ['implementer', 'reviewer'],
      distinctBy: 'model'
    });
    expect(result.step).toBe('impl');
    expect(result.distinctBy).toBe('model');
    expect(result.resolutionsByRole['implementer'].profileId).toBe('cfg_claude_b');
    expect(result.resolutionsByRole['reviewer'].profileId).toBe('cfg_openai_b');
  });

  it('throws role_distinct_unsatisfied when same model assigned to multiple roles', async () => {
    // Both roles resolve to the same profile/model
    const tableWithSameModel: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_nodistinct',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          // Both roles fall back to the same default
          { id: 'r_default', route: { mode: 'agent', step: 'impl', defaultForStep: true }, profileId: 'cfg_claude_b' }
        ]
      }
    };
    const claudeProfileB: ConfigurationRecord = { ...claudeProfile, id: 'cfg_claude_b', tenant: 'tenant_b' };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfileB, tableWithSameModel])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveDistinctAgentRoutes({
        tenant: 'tenant_b',
        step: 'impl',
        roles: ['implementer', 'reviewer'],
        distinctBy: 'model'
      })
    ).rejects.toMatchObject({ code: 'role_distinct_unsatisfied' });
  });

  it('throws role_distinct_unsatisfied when distinctBy=profile and same profile assigned to multiple roles', async () => {
    const tableWithSameProfile: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_nodistinct_profile',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          { id: 'r_default', route: { mode: 'agent', step: 'impl', defaultForStep: true }, profileId: 'cfg_claude_b' }
        ]
      }
    };
    const claudeProfileB: ConfigurationRecord = { ...claudeProfile, id: 'cfg_claude_b', tenant: 'tenant_b' };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfileB, tableWithSameProfile])
    };
    const resolver = createModelRoutingResolver(opts);
    await expect(
      resolver.resolveDistinctAgentRoutes({
        tenant: 'tenant_b',
        step: 'impl',
        roles: ['implementer', 'reviewer'],
        distinctBy: 'profile'
      })
    ).rejects.toMatchObject({ code: 'role_distinct_unsatisfied' });
  });

  it('considers distinct when same provider but different models (distinctBy=model)', async () => {
    const claudeProfile2: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_claude2_b',
      tenant: 'tenant_b',
      settings: {
        ...claudeProfile.settings as import('@autocatalyst/api-contract').ProviderProfileSettings,
        model: { provider: 'anthropic', model: 'claude-opus-4' } // different model
      }
    };
    const claudeProfileB: ConfigurationRecord = { ...claudeProfile, id: 'cfg_claude_b', tenant: 'tenant_b' };
    const tableWithDiffModels: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_diffmodels',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          { id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_claude_b' },
          { id: 'r2', route: { mode: 'agent', step: 'impl', role: 'reviewer' }, profileId: 'cfg_claude2_b' }
        ]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfileB, claudeProfile2, tableWithDiffModels])
    };
    const resolver = createModelRoutingResolver(opts);
    const result = await resolver.resolveDistinctAgentRoutes({
      tenant: 'tenant_b',
      step: 'impl',
      roles: ['implementer', 'reviewer'],
      distinctBy: 'model'
    });
    expect(result.resolutionsByRole['implementer'].profile.model.model).toBe('claude-sonnet-4');
    expect(result.resolutionsByRole['reviewer'].profile.model.model).toBe('claude-opus-4');
  });

  it('defaults distinctBy to model when not specified', async () => {
    const tableWithSameModel: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_default_distinct',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          { id: 'r_default', route: { mode: 'agent', step: 'impl', defaultForStep: true }, profileId: 'cfg_claude_b' }
        ]
      }
    };
    const claudeProfileB: ConfigurationRecord = { ...claudeProfile, id: 'cfg_claude_b', tenant: 'tenant_b' };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfileB, tableWithSameModel])
    };
    const resolver = createModelRoutingResolver(opts);
    // Without distinctBy, default is 'model'; same model => unsatisfied
    await expect(
      resolver.resolveDistinctAgentRoutes({
        tenant: 'tenant_b',
        step: 'impl',
        roles: ['implementer', 'reviewer']
        // no distinctBy
      })
    ).rejects.toMatchObject({ code: 'role_distinct_unsatisfied' });
  });

  it('respects table-defined roleDistinctRequirements distinctBy', async () => {
    // Table says distinctBy=profile; if we have distinct profiles even with same model it should pass
    const claudeProfile2: ConfigurationRecord = {
      ...claudeProfile,
      id: 'cfg_claude2_b',
      tenant: 'tenant_b',
      settings: {
        ...claudeProfile.settings as import('@autocatalyst/api-contract').ProviderProfileSettings,
        model: { provider: 'anthropic', model: 'claude-sonnet-4' } // same model, different profile
      }
    };
    const claudeProfileB: ConfigurationRecord = { ...claudeProfile, id: 'cfg_claude_b', tenant: 'tenant_b' };
    const tableWithReq: ConfigurationRecord = {
      ...routingTable,
      id: 'tbl_reqd',
      tenant: 'tenant_b',
      settings: {
        active: true,
        entries: [
          { id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_claude_b' },
          { id: 'r2', route: { mode: 'agent', step: 'impl', role: 'reviewer' }, profileId: 'cfg_claude2_b' }
        ],
        roleDistinctRequirements: [
          { step: 'impl', mode: 'agent', roles: ['implementer', 'reviewer'], distinctBy: 'profile' }
        ]
      }
    };
    const opts: CreateModelRoutingResolverOptions = {
      ...makeDefaultOptions(),
      configuration: makeReader([claudeProfileB, claudeProfile2, tableWithReq])
    };
    const resolver = createModelRoutingResolver(opts);
    // distinctBy=profile from table requirement; distinct profiles => should pass
    const result = await resolver.resolveDistinctAgentRoutes({
      tenant: 'tenant_b',
      step: 'impl',
      roles: ['implementer', 'reviewer']
      // no distinctBy passed; table provides it
    });
    expect(result.distinctBy).toBe('profile');
    expect(result.resolutionsByRole['implementer'].profileId).toBe('cfg_claude_b');
    expect(result.resolutionsByRole['reviewer'].profileId).toBe('cfg_claude2_b');
  });
});
