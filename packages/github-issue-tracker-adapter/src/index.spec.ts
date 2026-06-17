import { describe, expect, it } from 'vitest';

import { GhExecError, executeGh, GitHubIssueTracker } from './index.js';

describe('github-issue-tracker-adapter public exports', () => {
  it('exports executeGh and GhExecError from the package entry point', () => {
    expect(typeof executeGh).toBe('function');
    expect(GhExecError).toBeDefined();
    expect(new GhExecError('gh_not_found', 'not found').code).toBe('gh_not_found');
  });

  it('exports GitHubIssueTracker from the package entry point', () => {
    expect(GitHubIssueTracker).toBeDefined();
    expect(typeof GitHubIssueTracker).toBe('function');
  });
});
