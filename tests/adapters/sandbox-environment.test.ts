import { describe, expect, test } from 'vitest';
import { buildSandboxEnvironment, buildSandboxEnvironmentWithSummary } from '../../src/adapters/sandbox-environment.js';

describe('buildSandboxEnvironment', () => {
  test('strips AC_ prefix and maps token value from env', () => {
    const result = buildSandboxEnvironment(['AC_GH_TOKEN'], { AC_GH_TOKEN: 'ghp_abc123' });
    expect(result).toEqual({ GH_TOKEN: 'ghp_abc123' });
  });

  test('strips AC_ prefix for GITHUB_TOKEN variant', () => {
    const result = buildSandboxEnvironment(['AC_GITHUB_TOKEN'], { AC_GITHUB_TOKEN: 'ghp_xyz789' });
    expect(result).toEqual({ GITHUB_TOKEN: 'ghp_xyz789' });
  });

  test('returns empty object when acTokenNames is empty', () => {
    const result = buildSandboxEnvironment([], { AC_GH_TOKEN: 'ghp_abc123', SOME_SECRET: 'value' });
    expect(result).toEqual({});
  });

  test('excludes env vars not listed in acTokenNames', () => {
    const result = buildSandboxEnvironment(['AC_GH_TOKEN'], {
      AC_GH_TOKEN: 'ghp_abc123',
      UNLISTED_SECRET: 'should-not-appear',
    });
    expect(result).not.toHaveProperty('UNLISTED_SECRET');
    expect(result).not.toHaveProperty('AC_GH_TOKEN');
  });

  test('forwards key unchanged when name does not start with AC_', () => {
    const result = buildSandboxEnvironment(['MY_VAR'], { MY_VAR: 'some-value' });
    expect(result).toEqual({ MY_VAR: 'some-value' });
  });

  test('omits token when env var is not set', () => {
    const result = buildSandboxEnvironment(['AC_GH_TOKEN'], {});
    expect(result).toEqual({});
  });

  test('omits token when env var is empty string', () => {
    const result = buildSandboxEnvironment(['AC_GH_TOKEN'], { AC_GH_TOKEN: '' });
    expect(result).toEqual({});
  });

  test('maps multiple tokens when all are present', () => {
    const result = buildSandboxEnvironment(['AC_GH_TOKEN', 'AC_GITHUB_TOKEN'], {
      AC_GH_TOKEN: 'token-a',
      AC_GITHUB_TOKEN: 'token-b',
    });
    expect(result).toEqual({ GH_TOKEN: 'token-a', GITHUB_TOKEN: 'token-b' });
  });

  test('uses process.env by default when no env argument provided', () => {
    const originalToken = process.env['AC_GH_TOKEN'];
    process.env['AC_GH_TOKEN'] = 'default-env-token';
    try {
      const result = buildSandboxEnvironment(['AC_GH_TOKEN']);
      expect(result['GH_TOKEN']).toBe('default-env-token');
    } finally {
      if (originalToken !== undefined) {
        process.env['AC_GH_TOKEN'] = originalToken;
      } else {
        delete process.env['AC_GH_TOKEN'];
      }
    }
  });
});

describe('buildSandboxEnvironmentWithSummary', () => {
  test('returns exported keys without values', () => {
    const { environment, summary } = buildSandboxEnvironmentWithSummary(
      ['AC_GITHUB_TOKEN', 'AC_MISSING'],
      { AC_GITHUB_TOKEN: 'secret-token' },
    );
    expect(environment['GITHUB_TOKEN']).toBe('secret-token');
    expect(summary.exported_sandbox_keys).toEqual(['GITHUB_TOKEN']);
    expect(summary.missing_tokens).toEqual(['AC_MISSING']);
    expect(summary.token_count).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('secret-token');
  });

  test('returns all missing when none present', () => {
    const { environment, summary } = buildSandboxEnvironmentWithSummary(
      ['AC_GITHUB_TOKEN', 'AC_GH_TOKEN'],
      {},
    );
    expect(environment).toEqual({});
    expect(summary.token_count).toBe(0);
    expect(summary.exported_sandbox_keys).toEqual([]);
    expect(summary.missing_tokens).toEqual(['AC_GITHUB_TOKEN', 'AC_GH_TOKEN']);
  });
});
