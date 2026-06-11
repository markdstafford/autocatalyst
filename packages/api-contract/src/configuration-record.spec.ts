import { describe, expect, it } from 'vitest';
import {
  agentModelRouteKeySchema,
  configurationRecordCollectionPath,
  configurationRecordIdParamsSchema,
  configurationRecordKindSchema,
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createConfigurationRecordRequestSchema,
  directModelRouteKeySchema,
  modelRoutingErrorCodeSchema,
  modelRoutingTableSettingsSchema,
  providerProfileSettingsSchema,
  configurationRecordSettingsSchema,
  updateConfigurationRecordRequestSchema,
  updateModelRoutingTableSettingsSchema
} from './configuration-record.js';
import type { InferenceSettings, ProviderProfileSettings, RunnerEndpointSettings } from './configuration-record.js';

const handle = 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';

describe('configuration record contract schemas', () => {
  it('uses the agreed collection path and id params', () => {
    expect(configurationRecordCollectionPath).toBe('/v1/configuration-records');
    expect(configurationRecordIdParamsSchema.parse({ id: 'cfg_123' })).toEqual({ id: 'cfg_123' });
  });

  it('validates provider profile create requests', () => {
    expect(
      createConfigurationRecordRequestSchema.parse({
        tenant: 'tenant_a',
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: 'default', credentialSecretHandle: handle }
      })
    ).toEqual({
      tenant: 'tenant_a',
      kind: 'provider_profile',
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default', credentialSecretHandle: handle }
    });
    expect(() =>
      createConfigurationRecordRequestSchema.parse({
        tenant: 'tenant_a',
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: '' }
      })
    ).toThrow();
  });

  it('validates narrow patch semantics', () => {
    expect(() => updateConfigurationRecordRequestSchema.parse({})).toThrow();
    expect(() => updateConfigurationRecordRequestSchema.parse({ id: 'cfg_bad' })).toThrow();
    expect(
      updateConfigurationRecordRequestSchema.parse({ kind: 'provider_profile', settings: { credentialSecretHandle: null } })
    ).toEqual({ kind: 'provider_profile', settings: { credentialSecretHandle: null } });
    expect(() => updateConfigurationRecordRequestSchema.parse({ kind: 'provider_profile', settings: { profileName: '' } })).toThrow();
    expect(() => updateConfigurationRecordRequestSchema.parse({ kind: 'provider_profile', settings: {} })).toThrow();
  });

  it('parses a profileName-only record (existing behaviour preserved)', () => {
    expect(
      createConfigurationRecordRequestSchema.parse({
        tenant: 'tenant_a',
        kind: 'provider_profile',
        providerKind: 'anthropic',
        adapterId: 'claude-agent-sdk',
        settings: { profileName: 'minimal' }
      })
    ).toEqual({
      tenant: 'tenant_a',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: { profileName: 'minimal' }
    });
  });

  it('parses a fully populated Claude-capable profile', () => {
    const input = {
      tenant: 'tenant_a',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: {
        profileName: 'claude-sonnet',
        credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
        model: { provider: 'anthropic', model: 'claude-sonnet-4', displayName: 'Claude Sonnet' },
        inferenceSettings: {
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: 4096,
          reasoningEffort: 'medium',
          extra: { adaptiveThinking: true }
        },
        endpoint: {
          baseUrl: 'https://gateway.example.test/anthropic',
          authHeaderName: 'x-api-key',
          authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN',
          requestTimeoutMs: 30000,
          maxRetries: 2,
          headersToStrip: ['x-remove-me'],
          headersToRewrite: { 'x-gateway': 'enabled' },
          requiredAlterations: {
            headerStrip: false,
            headerRewrite: true,
            inferenceSettings: ['temperature']
          }
        }
      }
    };
    expect(createConfigurationRecordRequestSchema.parse(input)).toEqual(input);
  });

  it('rejects malformed endpoint fields', () => {
    const base = {
      tenant: 'tenant_a',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: { profileName: 'x', endpoint: {} as Record<string, unknown> }
    };

    expect(() =>
      createConfigurationRecordRequestSchema.parse({
        ...base,
        settings: { ...base.settings, endpoint: { baseUrl: 'not a url' } }
      })
    ).toThrow();

    expect(() =>
      createConfigurationRecordRequestSchema.parse({
        ...base,
        settings: { ...base.settings, endpoint: { authHeaderName: 'bad header' } }
      })
    ).toThrow();

    expect(() =>
      createConfigurationRecordRequestSchema.parse({
        ...base,
        settings: { ...base.settings, endpoint: { requestTimeoutMs: -1 } }
      })
    ).toThrow();

    expect(() =>
      createConfigurationRecordRequestSchema.parse({
        ...base,
        settings: { ...base.settings, endpoint: { maxRetries: -1 } }
      })
    ).toThrow();

    expect(() =>
      createConfigurationRecordRequestSchema.parse({
        ...base,
        settings: { ...base.settings, endpoint: { authEnvironmentVariable: 'TOKEN' } }
      })
    ).toThrow();
  });

  it('exports public types ProviderProfileSettings, RunnerEndpointSettings, InferenceSettings', () => {
    // Compile-time check: assigning typed objects exercises the exported types
    const profileSettings: ProviderProfileSettings = { profileName: 'test' };
    const endpointSettings: RunnerEndpointSettings = { baseUrl: 'https://example.com' };
    const inferenceSettings: InferenceSettings = { temperature: 0.5 };
    expect(profileSettings.profileName).toBe('test');
    expect(endpointSettings.baseUrl).toBe('https://example.com');
    expect(inferenceSettings.temperature).toBe(0.5);
  });

  it('validates responses with datetime timestamps and no secret value field', () => {
    const record = {
      id: 'cfg_123',
      tenant: 'tenant_a',
      kind: 'provider_profile',
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default', credentialSecretHandle: handle },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    expect(configurationRecordResponseSchema.parse(record)).toEqual(record);
    expect(configurationRecordListResponseSchema.parse({ records: [record] })).toEqual({ records: [record] });
    expect(() => configurationRecordResponseSchema.parse(Object.assign({}, record, { secretValue: 'sk-test' }))).toThrow();
    expect(() => configurationRecordResponseSchema.parse(Object.assign({}, record, { createdAt: 'not-a-date' }))).toThrow();
  });
});

describe('configuration record kind split', () => {
  it('accepts only provider_profile and model_routing_table kinds', () => {
    expect(configurationRecordKindSchema.parse('provider_profile')).toBe('provider_profile');
    expect(configurationRecordKindSchema.parse('model_routing_table')).toBe('model_routing_table');
    expect(configurationRecordKindSchema.safeParse('other_kind').success).toBe(false);
  });

  it('keeps provider-profile settings separate and exported', () => {
    const parsed = providerProfileSettingsSchema.parse({
      profileName: 'Claude agent',
      credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      endpoint: {}
    });
    expect(parsed.profileName).toBe('Claude agent');
    expect(configurationRecordSettingsSchema.safeParse(parsed).success).toBe(true);
  });

  it('requires provider metadata and tenant for provider_profile create requests', () => {
    const parsed = createConfigurationRecordRequestSchema.parse({
      tenant: 'tenant_a',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: {
        profileName: 'Claude agent',
        credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
        model: { provider: 'anthropic', model: 'claude-sonnet-4' },
        inferenceSettings: {},
        endpoint: {}
      }
    });
    expect(parsed.tenant).toBe('tenant_a');
    expect(parsed.kind).toBe('provider_profile');
  });

  it('rejects provider-profile settings in model_routing_table response branch', () => {
    expect(configurationRecordResponseSchema.safeParse({
      id: 'cfg_table',
      tenant: 'tenant_a',
      kind: 'model_routing_table',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: { profileName: 'not a routing table' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }).success).toBe(false);
  });

  it('rejects update bodies without an explicit record kind', () => {
    expect(updateConfigurationRecordRequestSchema.safeParse({
      settings: { profileName: 'Renamed profile' }
    }).success).toBe(false);
  });
});

describe('model routing table schemas', () => {
  const claudeProfileId = 'cfg_claude';
  const exactAgentEntry = {
    id: 'route_impl',
    route: { mode: 'agent', step: 'implementation.author', role: 'implementer' },
    profileId: claudeProfileId
  };
  const agentDefaultEntry = {
    id: 'route_default',
    route: { mode: 'agent', step: 'implementation.author', defaultForStep: true },
    profileId: claudeProfileId
  };
  const directEntry = {
    id: 'route_intake',
    route: { mode: 'direct', step: 'intake.classify' },
    profileId: 'cfg_direct'
  };

  it('validates agent exact route key', () => {
    expect(agentModelRouteKeySchema.safeParse(exactAgentEntry.route).success).toBe(true);
    expect(agentModelRouteKeySchema.safeParse(agentDefaultEntry.route).success).toBe(true);
    expect(agentModelRouteKeySchema.safeParse({ mode: 'agent', step: 'x', role: 'implementer', defaultForStep: true }).success).toBe(false);
    expect(agentModelRouteKeySchema.safeParse({ mode: 'agent', step: 'x' }).success).toBe(false);
  });

  it('validates direct route key and rejects role/defaultForStep', () => {
    expect(directModelRouteKeySchema.safeParse(directEntry.route).success).toBe(true);
    expect(directModelRouteKeySchema.safeParse({ mode: 'direct', step: 'x', role: 'implementer' }).success).toBe(false);
  });

  it('validates a valid model routing table settings', () => {
    expect(modelRoutingTableSettingsSchema.safeParse({
      active: true,
      entries: [exactAgentEntry, agentDefaultEntry, directEntry]
    }).success).toBe(true);
  });

  it('rejects duplicate enabled route keys in routing table', () => {
    expect(modelRoutingTableSettingsSchema.safeParse({
      active: true,
      entries: [exactAgentEntry, { ...exactAgentEntry, id: 'route_dup' }]
    }).success).toBe(false);
  });

  it('validates routing table patch schemas', () => {
    expect(updateModelRoutingTableSettingsSchema.safeParse({ entries: [] }).success).toBe(true);
    expect(updateModelRoutingTableSettingsSchema.safeParse({ entries: null }).success).toBe(false);
    expect(updateModelRoutingTableSettingsSchema.safeParse({ roleDistinctRequirements: null }).success).toBe(true);
  });

  it('validates error code schema contains all expected codes', () => {
    expect(modelRoutingErrorCodeSchema.options).toEqual([
      'routing_table_missing',
      'routing_table_ambiguous',
      'route_not_found',
      'duplicate_route',
      'profile_not_found',
      'profile_incomplete',
      'route_mode_mismatch',
      'adapter_unavailable',
      'credential_reference_invalid',
      'role_distinct_unsatisfied'
    ]);
  });

  it('validates model routing table create request', () => {
    expect(createConfigurationRecordRequestSchema.safeParse({
      tenant: 'tenant_a',
      kind: 'model_routing_table',
      settings: { active: true, entries: [] }
    }).success).toBe(true);
  });
});
