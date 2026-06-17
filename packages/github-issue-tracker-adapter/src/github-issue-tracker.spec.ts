import { describe, expect, it, vi } from 'vitest';
import { GitHubIssueTracker } from './github-issue-tracker.js';
import type { GitHubIssueTrackerOptions } from './github-issue-tracker.js';

const SENTINEL_TOKEN = 'super-secret-github-token';

const realisticGhOutput = JSON.stringify({
  number: 71,
  title: 'feat: Start a run from an issue reference',
  body: 'Canonical issue body',
  labels: [{ name: 'feature' }, { name: 'backend' }],
  state: 'OPEN',
  url: 'https://github.com/markdstafford/autocatalyst/issues/71'
});

function makeOptions(ghOverride?: Record<string, unknown>): GitHubIssueTrackerOptions {
  return {
    secretResolver: {
      resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN)
    },
    ghOptions: ghOverride
  };
}

describe('GitHubIssueTracker', () => {
  it('reads an issue and normalizes GitHub JSON to TrackedIssue', async () => {
    let capturedArgs: string[] | undefined;
    let capturedToken: string | undefined;

    const options = makeOptions();
    const tracker = new GitHubIssueTracker({
      ...options,
      executeGhFn: async (input) => {
        capturedArgs = [...input.args];
        capturedToken = input.token;
        return { stdout: realisticGhOutput, truncated: false };
      }
    });

    const result = await tracker.read({
      target: {
        provider: 'github',
        repository: { owner: 'markdstafford', name: 'autocatalyst' },
        credentialRef: { id: 'cred_1', purpose: 'issue_tracker' }
      },
      issueNumber: 71
    });

    expect(result.number).toBe(71);
    expect(result.title).toBe('feat: Start a run from an issue reference');
    expect(result.body).toBe('Canonical issue body');
    expect(result.labels).toEqual(['feature', 'backend']);
    expect(result.state).toBe('open'); // normalized from OPEN
    expect(result.url).toBe('https://github.com/markdstafford/autocatalyst/issues/71');

    // Verify correct gh args
    expect(capturedArgs).toContain('71');
    expect(capturedArgs).toContain('--repo');
    expect(capturedArgs).toContain('markdstafford/autocatalyst');

    // Token passed correctly
    expect(capturedToken).toBe(SENTINEL_TOKEN);
  });

  it('maps null body to empty string', async () => {
    const nullBodyOutput = JSON.stringify({
      number: 1, title: 'test', body: null,
      labels: [], state: 'OPEN',
      url: 'https://github.com/o/r/issues/1'
    });

    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN) },
      executeGhFn: async () => ({ stdout: nullBodyOutput, truncated: false })
    });

    const result = await tracker.read({
      target: { provider: 'github', repository: { owner: 'o', name: 'r' }, credentialRef: { id: 'c', purpose: 'issue_tracker' } },
      issueNumber: 1
    });

    expect(result.body).toBe('');
  });

  it('throws tracker_target_invalid for missing repository', async () => {
    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn() },
      executeGhFn: vi.fn()
    });

    await expect(tracker.read({
      target: { provider: 'github' }, // no repository
      issueNumber: 71
    })).rejects.toMatchObject({ code: 'tracker_target_invalid' });
  });

  it('throws tracker_credential_missing for missing credentialRef', async () => {
    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn() },
      executeGhFn: vi.fn()
    });

    await expect(tracker.read({
      target: { provider: 'github', repository: { owner: 'o', name: 'r' } }, // no credentialRef
      issueNumber: 71
    })).rejects.toMatchObject({ code: 'tracker_credential_missing' });
  });

  it('maps GhExecError auth failure to tracker_auth_failed', async () => {
    const { GhExecError } = await import('./gh-exec.js');
    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN) },
      executeGhFn: async () => { throw new GhExecError('gh_auth_failed', 'auth failed'); }
    });

    await expect(tracker.read({
      target: { provider: 'github', repository: { owner: 'o', name: 'r' }, credentialRef: { id: 'c', purpose: 'issue_tracker' } },
      issueNumber: 71
    })).rejects.toMatchObject({ code: 'tracker_auth_failed' });
  });

  it('maps GhExecError resource not found to issue_not_found', async () => {
    const { GhExecError } = await import('./gh-exec.js');
    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN) },
      executeGhFn: async () => { throw new GhExecError('gh_resource_not_found', 'not found'); }
    });

    await expect(tracker.read({
      target: { provider: 'github', repository: { owner: 'o', name: 'r' }, credentialRef: { id: 'c', purpose: 'issue_tracker' } },
      issueNumber: 71
    })).rejects.toMatchObject({ code: 'issue_not_found' });
  });

  it('maps invalid JSON to tracker_response_invalid', async () => {
    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN) },
      executeGhFn: async () => ({ stdout: 'not json', truncated: false })
    });

    await expect(tracker.read({
      target: { provider: 'github', repository: { owner: 'o', name: 'r' }, credentialRef: { id: 'c', purpose: 'issue_tracker' } },
      issueNumber: 71
    })).rejects.toMatchObject({ code: 'tracker_response_invalid' });
  });

  it('does not leak token in error messages or safe details', async () => {
    const { GhExecError } = await import('./gh-exec.js');
    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN) },
      executeGhFn: async () => { throw new GhExecError('gh_auth_failed', 'auth error'); }
    });

    try {
      await tracker.read({
        target: { provider: 'github', repository: { owner: 'o', name: 'r' }, credentialRef: { id: 'c', purpose: 'issue_tracker' } },
        issueNumber: 71
      });
      expect.fail('should have thrown');
    } catch (error: unknown) {
      expect(String(error)).not.toContain(SENTINEL_TOKEN);
      const e = error as { safeDetails?: unknown };
      expect(JSON.stringify(e.safeDetails ?? {})).not.toContain(SENTINEL_TOKEN);
    }
  });

  it('maps SecretResolutionError to tracker_credential_missing', async () => {
    const { SecretResolutionError } = await import('@autocatalyst/core');
    const tracker = new GitHubIssueTracker({
      secretResolver: {
        resolveSecret: vi.fn().mockRejectedValue(
          new SecretResolutionError('missing_secret', 'not found', { handle: 'cred_1' })
        )
      },
      executeGhFn: vi.fn()
    });

    await expect(tracker.read({
      target: { provider: 'github', repository: { owner: 'o', name: 'r' }, credentialRef: { id: 'cred_1', purpose: 'issue_tracker' } },
      issueNumber: 71
    })).rejects.toMatchObject({ code: 'tracker_credential_missing' });
  });

  it('maps schema validation failure to tracker_response_invalid', async () => {
    const badOutput = JSON.stringify({
      number: 71,
      // missing title, body, labels, state, url
    });

    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN) },
      executeGhFn: async () => ({ stdout: badOutput, truncated: false })
    });

    await expect(tracker.read({
      target: { provider: 'github', repository: { owner: 'o', name: 'r' }, credentialRef: { id: 'c', purpose: 'issue_tracker' } },
      issueNumber: 71
    })).rejects.toMatchObject({ code: 'tracker_response_invalid' });
  });

  it('passes explicit --repo owner/name and does not use cwd', async () => {
    let capturedArgs: string[] = [];

    const tracker = new GitHubIssueTracker({
      secretResolver: { resolveSecret: vi.fn().mockResolvedValue(SENTINEL_TOKEN) },
      executeGhFn: async (input) => {
        capturedArgs = [...input.args];
        return { stdout: realisticGhOutput, truncated: false };
      }
    });

    await tracker.read({
      target: { provider: 'github', repository: { owner: 'testowner', name: 'testrepo' }, credentialRef: { id: 'c', purpose: 'issue_tracker' } },
      issueNumber: 42
    });

    expect(capturedArgs).toContain('--repo');
    const repoIdx = capturedArgs.indexOf('--repo');
    expect(capturedArgs[repoIdx + 1]).toBe('testowner/testrepo');
    expect(capturedArgs).toContain('42');
  });
});
