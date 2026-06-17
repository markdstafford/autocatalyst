import { describe, expect, it } from 'vitest';

import { trackedIssueSchema } from './domain-value-objects.js';

describe('trackedIssueSchema', () => {
  it('accepts canonical issue content from a tracker', () => {
    expect(trackedIssueSchema.parse({
      number: 71,
      title: 'feat: start from issue reference',
      body: 'Use the canonical tracker issue body.',
      labels: ['feature', 'backend'],
      state: 'open',
      url: 'https://github.com/markdstafford/autocatalyst/issues/71'
    })).toEqual({
      number: 71,
      title: 'feat: start from issue reference',
      body: 'Use the canonical tracker issue body.',
      labels: ['feature', 'backend'],
      state: 'open',
      url: 'https://github.com/markdstafford/autocatalyst/issues/71'
    });
  });

  it('upgrades legacy tracked issue JSON by defaulting missing body and labels', () => {
    expect(trackedIssueSchema.parse({
      number: 12,
      title: 'legacy issue',
      state: 'merged',
      url: 'https://github.com/example/repo/issues/12'
    })).toEqual({
      number: 12,
      title: 'legacy issue',
      body: '',
      labels: [],
      state: 'merged',
      url: 'https://github.com/example/repo/issues/12'
    });
  });

  it('rejects invalid body and label values', () => {
    expect(() => trackedIssueSchema.parse({
      number: 12,
      title: 'bad body',
      body: null,
      labels: ['feature'],
      state: 'open',
      url: 'https://github.com/example/repo/issues/12'
    })).toThrow();

    expect(() => trackedIssueSchema.parse({
      number: 12,
      title: 'bad label',
      body: '',
      labels: [''],
      state: 'open',
      url: 'https://github.com/example/repo/issues/12'
    })).toThrow();
  });

  it('remains strict after legacy preprocessing', () => {
    expect(() => trackedIssueSchema.parse({
      number: 12,
      title: 'extra key',
      state: 'open',
      url: 'https://github.com/example/repo/issues/12',
      unexpected: true
    })).toThrow();
  });
});
