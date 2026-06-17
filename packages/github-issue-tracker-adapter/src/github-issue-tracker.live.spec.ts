/**
 * Live GitHub issue read proof.
 *
 * Opt-in via:
 *   AUTOCATALYST_LIVE_GITHUB_ISSUE_READ=1
 *   AUTOCATALYST_LIVE_GH_REPO=owner/name           (e.g. "markdstafford/autocatalyst")
 *   AUTOCATALYST_LIVE_GH_ISSUE_NUMBER=<number>      (e.g. "71")
 *   AUTOCATALYST_LIVE_GH_TOKEN=<personal-access-token>
 *
 * Run:
 *   AUTOCATALYST_LIVE_GITHUB_ISSUE_READ=1 \
 *   AUTOCATALYST_LIVE_GH_REPO=owner/name \
 *   AUTOCATALYST_LIVE_GH_ISSUE_NUMBER=71 \
 *   AUTOCATALYST_LIVE_GH_TOKEN=ghp_... \
 *   pnpm nx test github-issue-tracker-adapter -- github-issue-tracker.live.spec
 *
 * Without the opt-in variable all tests are skipped.
 * Token values are never printed; the test fails if the token appears in any thrown message.
 */
import { describe, expect, it } from 'vitest';

import { GitHubIssueTracker } from './github-issue-tracker.js';

const LIVE_OPT_IN = process.env['AUTOCATALYST_LIVE_GITHUB_ISSUE_READ'] === '1';
const REPO = process.env['AUTOCATALYST_LIVE_GH_REPO'] ?? '';
const ISSUE_NUMBER = parseInt(process.env['AUTOCATALYST_LIVE_GH_ISSUE_NUMBER'] ?? '0', 10);
const TOKEN = process.env['AUTOCATALYST_LIVE_GH_TOKEN'] ?? '';

describe.skipIf(!LIVE_OPT_IN)('GitHubIssueTracker — live proof', () => {
  it('reads a real GitHub issue through gh and returns a canonical TrackedIssue', async () => {
    expect(REPO, 'AUTOCATALYST_LIVE_GH_REPO must be set').not.toBe('');
    expect(ISSUE_NUMBER, 'AUTOCATALYST_LIVE_GH_ISSUE_NUMBER must be a positive integer').toBeGreaterThan(0);
    expect(TOKEN, 'AUTOCATALYST_LIVE_GH_TOKEN must be set').not.toBe('');

    const [owner, name] = REPO.split('/');
    expect(owner, 'AUTOCATALYST_LIVE_GH_REPO must be owner/name').toBeTruthy();
    expect(name, 'AUTOCATALYST_LIVE_GH_REPO must be owner/name').toBeTruthy();

    const secretResolver = {
      resolveSecret: async (_id: string) => TOKEN
    };

    const tracker = new GitHubIssueTracker({ secretResolver });

    const issue = await tracker.read({
      target: {
        provider: 'github',
        repository: { owner, name },
        credentialRef: { id: 'live-test-cred', purpose: 'issue_tracker' }
      },
      issueNumber: ISSUE_NUMBER
    });

    expect(issue.number).toBe(ISSUE_NUMBER);
    expect(typeof issue.title).toBe('string');
    expect(issue.title.length).toBeGreaterThan(0);
    expect(typeof issue.body).toBe('string');
    expect(Array.isArray(issue.labels)).toBe(true);
    expect(['open', 'closed', 'merged', 'unknown']).toContain(issue.state);
    expect(issue.url).toMatch(/^https:\/\/github\.com\//);
  });

  it('does not expose the token in errors when the issue does not exist', async () => {
    expect(TOKEN, 'AUTOCATALYST_LIVE_GH_TOKEN must be set').not.toBe('');
    expect(REPO, 'AUTOCATALYST_LIVE_GH_REPO must be set').not.toBe('');

    const [owner, name] = REPO.split('/');

    const secretResolver = {
      resolveSecret: async (_id: string) => TOKEN
    };

    const tracker = new GitHubIssueTracker({ secretResolver });

    let threw = false;
    try {
      await tracker.read({
        target: {
          provider: 'github',
          repository: { owner, name },
          credentialRef: { id: 'live-test-cred', purpose: 'issue_tracker' }
        },
        issueNumber: 999999999
      });
    } catch (err: unknown) {
      threw = true;
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(TOKEN);
    }

    expect(threw, 'Expected tracker to throw for non-existent issue').toBe(true);
  });
});
