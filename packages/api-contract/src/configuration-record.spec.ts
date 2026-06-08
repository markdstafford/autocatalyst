import { describe, expect, it } from 'vitest';
import {
  configurationRecordCollectionPath,
  configurationRecordIdParamsSchema,
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createConfigurationRecordRequestSchema,
  updateConfigurationRecordRequestSchema
} from './configuration-record.js';

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
