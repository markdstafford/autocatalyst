import { describe, expect, it } from 'vitest';
import { CodeHostError, isCodeHostError } from './code-host.js';
import { createCodeHostRegistry } from './code-host-registry.js';
import type { CodeHostPort } from './code-host.js';

function fakePort(): CodeHostPort {
  return {
    create: async () => ({ provider: 'fake', number: 1, url: 'https://example.invalid/pr/1', state: 'open', branch: 'run/test' }),
    read: async () => ({ provider: 'fake', number: 1, url: 'https://example.invalid/pr/1', state: 'open', branch: 'run/test' }),
    findByBranch: async () => null,
    update: async () => undefined,
    merge: async () => ({ provider: 'fake', number: 1, url: 'https://example.invalid/pr/1', state: 'merged', branch: 'run/test' })
  };
}

describe('createCodeHostRegistry', () => {
  it('returns a registered provider port', () => {
    const registry = createCodeHostRegistry([{ provider: 'github', create: () => fakePort() }]);
    expect(registry.get('github')).toBeTruthy();
  });

  it('rejects duplicate providers', () => {
    expect(() => createCodeHostRegistry([
      { provider: 'github', create: () => fakePort() },
      { provider: 'github', create: () => fakePort() }
    ])).toThrow(CodeHostError);
  });

  it('throws unsupported_provider for unknown providers', () => {
    const registry = createCodeHostRegistry([]);
    let caughtError: unknown;
    try {
      registry.get('gitlab');
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(CodeHostError);
    expect((caughtError as CodeHostError).code).toBe('unsupported_provider');
    expect((caughtError as CodeHostError).safeDetails).toEqual({ provider: 'gitlab' });
  });

  it('error message mentions unsupported provider', () => {
    const registry = createCodeHostRegistry([]);
    expect(() => registry.get('gitlab')).toThrowError(/Unsupported code-host provider/u);
  });

  it('duplicate_provider error has code and safe provider detail', () => {
    let caughtError: unknown;
    try {
      createCodeHostRegistry([
        { provider: 'github', create: () => fakePort() },
        { provider: 'github', create: () => fakePort() }
      ]);
    } catch (error) {
      caughtError = error;
    }
    expect(isCodeHostError(caughtError)).toBe(true);
    expect((caughtError as CodeHostError).code).toBe('duplicate_provider');
    expect((caughtError as CodeHostError).safeDetails).toEqual({ provider: 'github' });
  });

  it('returns a callable port', async () => {
    const port = fakePort();
    const registry = createCodeHostRegistry([{ provider: 'github', create: () => port }]);
    const result = registry.get('github');
    const facts = await result.findByBranch({ target: { provider: 'github', owner: 'o', name: 'r' }, headBranch: 'run/1', credential: { token: 't' } });
    expect(facts).toBeNull();
  });
});
