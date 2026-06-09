import { describe, expect, it, vi } from 'vitest';

import { createSecret, SecretResolutionError, SecretStoreLockedError, type SecretResolver, type SecretStore } from './secret.js';

describe('secret use case', () => {
  it('delegates creation and returns only a handle', async () => {
    const store: SecretStore = {
      createSecret: vi.fn(async () => ({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }))
    };
    await expect(createSecret(store, { value: 'sk-test' })).resolves.toEqual({
      handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'
    });
    expect(store.createSecret).toHaveBeenCalledWith({ value: 'sk-test' });
  });

  it('propagates locked-store errors without including secret values in the message', async () => {
    const error = new SecretStoreLockedError();
    const store: SecretStore = {
      createSecret: vi.fn(async () => { throw error; })
    };
    await expect(createSecret(store, { value: 'sk-test' })).rejects.toBe(error);
    expect(error.message).not.toContain('sk-test');
  });
});

describe('SecretResolver seam', () => {
  it('SecretResolutionError has code, name, and sanitized message', () => {
    const error = new SecretResolutionError('missing_secret', "Secret handle sec_missing could not be resolved.", { handle: 'sec_missing', causeMessage: 'redacted' });
    expect(error.name).toBe('SecretResolutionError');
    expect(error.code).toBe('missing_secret');
    expect(error.message).not.toContain('plaintext');
    expect(JSON.stringify(error.details)).not.toContain('plaintext');
  });

  it('SecretResolutionError supports all codes', () => {
    expect(new SecretResolutionError('locked', 'locked', { handle: 'h' }).code).toBe('locked');
    expect(new SecretResolutionError('undecryptable', 'u', { handle: 'h' }).code).toBe('undecryptable');
    expect(new SecretResolutionError('unavailable', 'u', { handle: 'h' }).code).toBe('unavailable');
  });

  it('SecretResolver interface works', async () => {
    const resolver: SecretResolver = { resolveSecret: async (handle) => `value:${handle}` };
    await expect(resolver.resolveSecret('sec_abc')).resolves.toBe('value:sec_abc');
  });
});
