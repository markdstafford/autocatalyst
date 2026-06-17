import { describe, expect, it } from 'vitest';

import type { IssueTrackerPort } from './issue-tracker.js';
import { StaticIssueTrackerRegistry } from './issue-tracker-registry.js';

const fakePort: IssueTrackerPort = {
  read: async () => ({
    number: 1,
    title: 'feat: x',
    body: '',
    labels: ['feature'],
    state: 'open' as const,
    url: 'https://github.com/o/r/issues/1'
  })
};

describe('StaticIssueTrackerRegistry', () => {
  it('normalizes provider names and returns null for missing providers', () => {
    const registry = new StaticIssueTrackerRegistry({ GitHub: fakePort });
    expect(registry.get('github')).toBe(fakePort);
    expect(registry.get(' GITHUB ')).toBe(fakePort);
    expect(registry.get('jira')).toBeNull();
  });

  it('returns null for empty registry', () => {
    const registry = new StaticIssueTrackerRegistry({});
    expect(registry.get('github')).toBeNull();
  });

  it('normalizes keys at construction time', () => {
    const registry = new StaticIssueTrackerRegistry({ '  JIRA  ': fakePort });
    expect(registry.get('jira')).toBe(fakePort);
    expect(registry.get(' Jira ')).toBe(fakePort);
  });

  it('returns the same port instance for repeated lookups', () => {
    const registry = new StaticIssueTrackerRegistry({ github: fakePort });
    expect(registry.get('github')).toBe(registry.get('github'));
  });
});
