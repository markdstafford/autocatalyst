/**
 * Live GitHub code-host proof.
 *
 * Opt-in via:
 *   AUTOCATALYST_LIVE_GH_PR=1
 *   AUTOCATALYST_LIVE_GH_REPO=owner/name           (e.g. "markdstafford/autocatalyst")
 *   AUTOCATALYST_LIVE_GH_BASE_BRANCH=main           (e.g. "main")
 *   AUTOCATALYST_LIVE_GH_TOKEN=<personal-access-token>
 *
 * Run:
 *   AUTOCATALYST_LIVE_GH_PR=1 \
 *   AUTOCATALYST_LIVE_GH_REPO=owner/name \
 *   AUTOCATALYST_LIVE_GH_BASE_BRANCH=main \
 *   AUTOCATALYST_LIVE_GH_TOKEN=ghp_... \
 *   pnpm nx test github-code-host-adapter -- github-code-host.live.spec
 *
 * The test creates a throwaway branch, opens a PR, views it, finds it by branch, and merges it.
 * Without the opt-in variable all tests are skipped.
 * Token values are never printed; the test fails if the token appears in any thrown message.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { createGitHubCodeHostAdapter } from './github-code-host.js';
import type { SafeGitExecutor } from './github-code-host.js';
import { executeGh } from '@autocatalyst/github-issue-tracker-adapter';

const LIVE_OPT_IN = process.env['AUTOCATALYST_LIVE_GH_PR'] === '1';
const REPO = process.env['AUTOCATALYST_LIVE_GH_REPO'] ?? '';
const BASE_BRANCH = process.env['AUTOCATALYST_LIVE_GH_BASE_BRANCH'] ?? 'main';
const TOKEN = process.env['AUTOCATALYST_LIVE_GH_TOKEN'] ?? '';

const execFileAsync = promisify(execFile);

/**
 * Real git push using the system git binary, forwarding GH_TOKEN for HTTPS authentication.
 * Only used in the live test — not in production code.
 */
function buildSafeGitExecutor(): SafeGitExecutor {
  return {
    async pushBranch({ workspaceRepoRoot, branch, remote = 'origin' }) {
      await execFileAsync('git', ['-C', workspaceRepoRoot, 'push', remote, `${branch}:${branch}`, '--force'], {
        env: { ...process.env, GH_TOKEN: TOKEN }
      });
    }
  };
}

describe.skipIf(!LIVE_OPT_IN)('GitHubCodeHostAdapter — live proof', () => {
  it('creates, reads, finds by branch, and merges a throwaway pull request via gh', async () => {
    expect(REPO, 'AUTOCATALYST_LIVE_GH_REPO must be set').not.toBe('');
    expect(TOKEN, 'AUTOCATALYST_LIVE_GH_TOKEN must be set').not.toBe('');

    const [repoOwner, repoName] = REPO.split('/');
    expect(repoOwner, 'AUTOCATALYST_LIVE_GH_REPO must be owner/name').toBeTruthy();
    expect(repoName, 'AUTOCATALYST_LIVE_GH_REPO must be owner/name').toBeTruthy();

    const branch = `live-test-pr-${Date.now()}`;
    const adapter = createGitHubCodeHostAdapter({
      executeGh: (input) => executeGh({ ...input, token: TOKEN }),
      git: buildSafeGitExecutor()
    });
    const target = { provider: 'github' as const, owner: repoOwner!, name: repoName! };
    const credential = { token: TOKEN };

    // Locate the git workspace root so we can create a real branch.
    let workspaceRepoRoot: string;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
      workspaceRepoRoot = stdout.trim();
    } catch {
      console.log('Skipping live PR test: not inside a git repository.');
      return;
    }

    // Create a throwaway branch pointing at the current HEAD.
    await execFileAsync('git', ['branch', branch], { cwd: workspaceRepoRoot });

    let prNumber: number | undefined;
    try {
      // create: pushes the branch and opens the PR
      const created = await adapter.create({
        target,
        workspaceRepoRoot,
        branch,
        baseBranch: BASE_BRANCH,
        credential,
        content: { title: `chore: live test PR ${branch}`, body: 'Automated live test — safe to close.' }
      });
      prNumber = created.number;
      expect(typeof created.number).toBe('number');
      expect(created.number).toBeGreaterThan(0);
      expect(created.url).toMatch(/^https:\/\/github\.com\//);
      expect(created.state).toBe('open');
      expect(created.provider).toBe('github');
      expect(created.branch).toBe(branch);

      // read
      const viewed = await adapter.read({ target, number: created.number, credential });
      expect(viewed.number).toBe(created.number);
      expect(viewed.state).toBe('open');

      // findByBranch — must return the unique open PR
      const found = await adapter.findByBranch({ target, headBranch: branch, credential });
      expect(found).not.toBeNull();
      expect(found!.number).toBe(created.number);
      expect(found!.state).toBe('open');

      // merge (squash)
      const merged = await adapter.merge({ target, number: created.number, credential });
      expect(merged.state).toBe('merged');

      // read merged state
      const afterMerge = await adapter.read({ target, number: created.number, credential });
      expect(afterMerge.state).toBe('merged');
    } catch (err) {
      // If a PR was opened but merge failed, close it so the repo stays clean.
      if (prNumber !== undefined) {
        try {
          await execFileAsync('gh', ['pr', 'close', String(prNumber), '--repo', REPO], {
            env: { ...process.env, GH_TOKEN: TOKEN }
          });
        } catch { /* ignore */ }
      }
      // Clean up the local branch on failure.
      try {
        await execFileAsync('git', ['branch', '-D', branch], { cwd: workspaceRepoRoot });
      } catch { /* ignore */ }
      throw err;
    }

    // Clean up the local branch on success.
    try {
      await execFileAsync('git', ['branch', '-D', branch], { cwd: workspaceRepoRoot });
    } catch { /* ignore */ }
  }, 60000);

  it('does not expose the token in errors when the repository does not exist', async () => {
    expect(TOKEN, 'AUTOCATALYST_LIVE_GH_TOKEN must be set').not.toBe('');

    const adapter = createGitHubCodeHostAdapter({
      executeGh: (input) => executeGh({ ...input, token: TOKEN }),
      git: buildSafeGitExecutor()
    });

    let threw = false;
    try {
      await adapter.read({
        target: { provider: 'github', owner: 'nonexistent-org-xyz', name: 'nonexistent-repo-xyz' },
        number: 1,
        credential: { token: TOKEN }
      });
    } catch (err: unknown) {
      threw = true;
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(TOKEN);
    }

    expect(threw, 'Expected adapter to throw for nonexistent repository').toBe(true);
  });
});
