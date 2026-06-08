import { describe, expect, it } from 'vitest';
import {
  createSecretRequestSchema,
  createSecretResponseSchema,
  secretCollectionPath,
  secretHandleSchema
} from './secret.js';

describe('secret contract schemas', () => {
  it('uses the protected secret collection path', () => {
    expect(secretCollectionPath).toBe('/v1/secrets');
  });

  it('validates the exact opaque secret handle format', () => {
    const valid = 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    expect(secretHandleSchema.parse(valid)).toBe(valid);
    expect(() => secretHandleSchema.parse('sec_short')).toThrow();
    expect(() => secretHandleSchema.parse(`sec_${'A'.repeat(33)}`)).toThrow();
    expect(() => secretHandleSchema.parse(`sec_${'A'.repeat(31)}=`)).toThrow();
    expect(() => secretHandleSchema.parse(`sec_${'A'.repeat(31)}+`)).toThrow();
  });

  it('accepts create-secret requests and responses without exposing values in responses', () => {
    expect(createSecretRequestSchema.parse({ value: 'sk-test' })).toEqual({ value: 'sk-test' });
    expect(() => createSecretRequestSchema.parse({ value: '' })).toThrow();
    expect(createSecretResponseSchema.parse({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' })).toEqual({
      handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'
    });
    expect(() =>
      createSecretResponseSchema.parse({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', value: 'sk-test' })
    ).toThrow();
  });
});
