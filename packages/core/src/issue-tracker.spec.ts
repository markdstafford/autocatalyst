import { describe, expect, it } from 'vitest';

import { IssueTrackerError } from './issue-tracker.js';

describe('IssueTrackerError', () => {
  it('carries a safe code and sanitized details', () => {
    const error = new IssueTrackerError('issue_not_found', 'Issue 404 was not found.', {
      safeDetails: { provider: 'github', repository: 'owner/repo', issueNumber: 404 },
      cause: new Error('raw provider failure')
    });
    expect(error.code).toBe('issue_not_found');
    expect(error.safeDetails).toEqual({ provider: 'github', repository: 'owner/repo', issueNumber: 404 });
    expect(error.message).not.toContain('GH_TOKEN');
    expect(error.name).toBe('IssueTrackerError');
  });

  it('works with just code and message', () => {
    const error = new IssueTrackerError('tracker_not_configured', 'No tracker configured.');
    expect(error.code).toBe('tracker_not_configured');
    expect(error.safeDetails).toBeUndefined();
  });

  it('preserves cause on the error', () => {
    const cause = new Error('raw provider failure');
    const error = new IssueTrackerError('tracker_auth_failed', 'Auth failed.', { cause });
    expect((error as unknown as { cause: unknown }).cause).toBe(cause);
  });

  it('is an instance of Error', () => {
    const error = new IssueTrackerError('tracker_not_configured', 'No tracker.');
    expect(error).toBeInstanceOf(Error);
  });
});
