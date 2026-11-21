import { describe, expect, it, vi } from 'vitest';
import { CodeHostCredentialMissingError, SecretResolutionError } from '@autocatalyst/core';
import { createCodeHostCredentialResolver } from './code-host-credential-resolver.js';

const ref = { id: `sec_${'A'.repeat(32)}`, purpose: 'code_host' };

describe('default code-host credential resolver', () => {
  it.each([null, {}, { ...ref, id: 'malformed' }, { id: ref.id }])('rejects invalid ref %j before consulting the store', async (invalid) => {
    const resolveSecret = vi.fn();
    await expect(createCodeHostCredentialResolver({ resolveSecret })(invalid)).rejects.toBeInstanceOf(CodeHostCredentialMissingError);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('signals an absent or empty token (%j)', async (value) => {
    const resolveSecret = vi.fn().mockResolvedValue(value);
    await expect(createCodeHostCredentialResolver({ resolveSecret })(ref)).rejects.toBeInstanceOf(CodeHostCredentialMissingError);
    expect(resolveSecret).toHaveBeenCalledExactlyOnceWith(ref.id);
  });

  it('translates only missing_secret, without carrying the underlying exception', async () => {
    const storeError = new SecretResolutionError('missing_secret', 'SECRET_SENTINEL', { handle: ref.id });
    const resolveSecret = vi.fn().mockRejectedValue(storeError);
    await expect(createCodeHostCredentialResolver({ resolveSecret })(ref)).rejects.toMatchObject({
      name: 'CodeHostCredentialMissingError', message: 'Code-host credential is missing.'
    });
  });

  it.each(['locked', 'undecryptable', 'unavailable', 'generic'] as const)('propagates a %s store fault as an infrastructure error', async (code) => {
    const source = code === 'generic'
      ? new Error('SECRET_SENTINEL')
      : new SecretResolutionError(code, 'SECRET_SENTINEL', { handle: ref.id });
    const resolveSecret = vi.fn().mockRejectedValue(source);
    await expect(createCodeHostCredentialResolver({ resolveSecret })(ref)).rejects.toBe(source);
  });
});
