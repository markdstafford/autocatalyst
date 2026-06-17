import { describe, expect, it } from 'vitest';
import { CodeHostError, defaultMergeStrategy, isCodeHostError, sanitizeCodeHostDetails } from './code-host.js';

describe('sanitizeCodeHostDetails', () => {
  it('strips unsafe keys like token, stderr, env', () => {
    const details = sanitizeCodeHostDetails({
      provider: 'github',
      repository: 'owner/repo',
      branch: 'run/abc',
      number: 73,
      token: 'ghp_secret',
      stderr: 'raw stderr',
      env: { GH_TOKEN: 'ghp_secret' }
    });
    expect(details).toEqual({ provider: 'github', repository: 'owner/repo', branch: 'run/abc', number: 73 });
  });

  it('allows safe keys: provider, owner, name, branch, headBranch, baseBranch, number, state, url', () => {
    const details = sanitizeCodeHostDetails({
      provider: 'github', owner: 'org', name: 'repo',
      branch: 'main', headBranch: 'run/1', baseBranch: 'main',
      number: 1, state: 'open', url: 'https://github.com/org/repo/pull/1'
    });
    expect(Object.keys(details)).toEqual(['provider', 'owner', 'name', 'branch', 'headBranch', 'baseBranch', 'number', 'state', 'url']);
  });

  it('returns empty object when no safe keys present', () => {
    expect(sanitizeCodeHostDetails({ token: 'secret', foo: 'bar' })).toEqual({});
  });
});

describe('CodeHostError', () => {
  it('identifies code-host errors', () => {
    const error = new CodeHostError('ambiguous_branch_match', 'Ambiguous provider pull request match.', { provider: 'github' });
    expect(isCodeHostError(error)).toBe(true);
    expect(error.code).toBe('ambiguous_branch_match');
    expect(error.safeDetails).toEqual({ provider: 'github' });
    expect(error.name).toBe('CodeHostError');
  });

  it('strips unsafe details in constructor', () => {
    const error = new CodeHostError('provider_unavailable', 'Unavailable.', { provider: 'github', token: 'secret' });
    expect(error.safeDetails).toEqual({ provider: 'github' });
    expect(error.safeDetails).not.toHaveProperty('token');
  });

  it('defaults safeDetails to empty object', () => {
    const error = new CodeHostError('unsupported_provider', 'Unsupported.');
    expect(error.safeDetails).toEqual({});
  });
});

describe('isCodeHostError', () => {
  it('returns false for non-CodeHostError', () => {
    expect(isCodeHostError(new Error('regular'))).toBe(false);
    expect(isCodeHostError(null)).toBe(false);
    expect(isCodeHostError('string')).toBe(false);
  });
});

describe('defaultMergeStrategy', () => {
  it('defaults merge strategy to squash and delete branch', () => {
    expect(defaultMergeStrategy()).toEqual({ method: 'squash', deleteBranch: true });
  });
});
