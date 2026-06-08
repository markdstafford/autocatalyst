import { describe, expect, it, vi } from 'vitest';

import { createSecret, SecretStoreLockedError, type SecretStore } from './secret.js';

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
