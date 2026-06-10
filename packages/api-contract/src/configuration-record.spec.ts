import { describe, expect, it } from 'vitest';
import {
  configurationRecordCollectionPath,
  configurationRecordIdParamsSchema,
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createConfigurationRecordRequestSchema,
  updateConfigurationRecordRequestSchema
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
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: 'default', credentialSecretHandle: handle }
      })
    ).toEqual({
      kind: 'provider_profile',
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default', credentialSecretHandle: handle }
    });
    expect(() =>
      createConfigurationRecordRequestSchema.parse({
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
      updateConfigurationRecordRequestSchema.parse({ settings: { credentialSecretHandle: null } })
    ).toEqual({ settings: { credentialSecretHandle: null } });
    expect(() => updateConfigurationRecordRequestSchema.parse({ settings: { profileName: '' } })).toThrow();
    expect(() => updateConfigurationRecordRequestSchema.parse({ settings: {} })).toThrow();
  });

  it('parses a profileName-only record (existing behaviour preserved)', () => {
    expect(
      createConfigurationRecordRequestSchema.parse({
        kind: 'provider_profile',
        providerKind: 'anthropic',
        adapterId: 'claude-agent-sdk',
        settings: { profileName: 'minimal' }
      })
    ).toEqual({
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: { profileName: 'minimal' }
    });
  });

  it('parses a fully populated Claude-capable profile', () => {
    const input = {
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
