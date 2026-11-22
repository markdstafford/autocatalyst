import { describe, expect, it } from 'vitest';

import { extractIssueReference } from './issue-reference.js';

const github = { provider: 'github', owner: 'Acme', name: 'demo-app', url: 'https://github.com/Acme/demo-app' };

describe('extractIssueReference', () => {
  it.each([
    ['5', 5],
    ['  #0005  ', 5],
    ['https://github.com/ACME/Demo-App/issues/5/', 5],
    ['https://github.com:443/acme/demo-app/issues/5', 5],
    ['#9007199254740991', Number.MAX_SAFE_INTEGER]
  ])('extracts %s', (input, number) => {
    expect(extractIssueReference(input, github)).toEqual({ number });
  });

  it.each([
    '', '  ', '#', '0', '#0', '-1', '+1', '1.0', '1e4', '1 2', 'issue #5',
    '#9007199254740992', 'http://github.com/acme/demo-app/issues/5', 'https://github.com:8443/acme/demo-app/issues/5',
    'https://elsewhere.test/acme/demo-app/issues/5', 'https://github.com.evil.test/acme/demo-app/issues/5',
    'https://user@github.com/acme/demo-app/issues/5', 'https://github.com/acme/demo-app/issues/5?',
    'https://github.com/acme/demo-app/issues/5#', 'https://github.com/acme/demo-app/pull/5',
    'https://github.com/../demo-app/issues/5', 'https://github.com/acme/demo-app/ISSUES/5', 'https://github.com/acme/demo-app/issues/5/comment'
  ])('rejects %j before lookup', (input) => {
    expect(extractIssueReference(input, github)).toEqual({ error: 'Enter an issue number, #number or an issue URL.' });
  });

  it('scopes GitHub URLs by provider, owner, and repo, but numbers by the chosen project', () => {
    const url = 'https://github.com/acme/demo-app/issues/1';
    const mismatch = { error: 'This issue belongs to a different repository' };
    expect(extractIssueReference(url, { ...github, name: 'other' })).toEqual(mismatch);
    expect(extractIssueReference(url, { ...github, owner: 'other' })).toEqual(mismatch);
    expect(extractIssueReference(url, { ...github, provider: 'linear' })).toEqual(mismatch);
    expect(extractIssueReference('#1', { ...github, provider: 'linear' })).toEqual({ number: 1 });
  });
});
