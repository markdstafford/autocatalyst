import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { MaterializedExecutionEnvironment } from '@autocatalyst/execution';
import { allowsRetention, reviewedScopeDigest, reviewedWorkspaceProof, type RetentionBuild } from './reviewed-conversation.js';

const exec = promisify(execFile);
describe('reviewed conversation admission', () => {
  it('requires an exact release, including adapter, native runtime, confinement and authentication', () => {
    const exact: RetentionBuild = { provider: 'claude', adapterBuild: 'adapter', nativeBuild: 'runtime', confinementBuild: 'host', authMode: 'subscription' };
    expect(allowsRetention(exact)).toBe(false);
    expect(allowsRetention(exact, [exact])).toBe(true);
    for (const [dimension, value] of Object.entries({
      provider: 'codex', adapterBuild: 'upgrade', nativeBuild: 'patch', confinementBuild: 'new-host', authMode: 'api_key'
    })) expect(allowsRetention({ ...exact, [dimension]: value }, [exact])).toBe(false);
  });

  it('hashes the stable contract and deliverable, not the current revision or publication binding', () => {
    const first = { step: 'implementation.build', role: 'implementer', workflow: { id: 'feature', rev: 2 },
      workItemId: 'topic-x', deliverable: ['test/repo', 'feature/work'] } as const;
    expect(reviewedScopeDigest(first)).toBe(reviewedScopeDigest({ ...first, workflow: { rev: 2, id: 'feature' } }));
    expect(reviewedScopeDigest(first)).not.toBe(reviewedScopeDigest({ ...first, workflow: { ...first.workflow, rev: 3 } }));
    expect(reviewedScopeDigest(first)).not.toBe(reviewedScopeDigest({ ...first, deliverable: ['test/repo', 'feature/another'] }));
    expect(reviewedScopeDigest({ ...first, workItemId: '' })).toBeUndefined();
    expect(reviewedScopeDigest({ ...first, deliverable: [] })).toBeUndefined();
  });

  it('proves both instances and rejects same-path scratch replacement or missing workspace roots', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'continuity-workspace-')));
    const host = join(base, 'host');
    const root = join(base, 'managed');
    const runRoot = join(root, 'run_proof');
    const repoRoot = join(runRoot, 'repo');
    const scratchRoot = join(runRoot, 'scratch');
    const git = async (cwd: string, ...args: string[]) => exec('git', args, { cwd, env: {
      ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
    } });
    try {
      await mkdir(host);
      await mkdir(scratchRoot, { recursive: true });
      await git(host, 'init', '-b', 'main');
      await git(host, 'commit', '--allow-empty', '-m', 'base');
      await git(host, 'worktree', 'add', '-b', 'feature/work', repoRoot);
      const environment = {
        context: { run: { id: 'run_proof' } }, workspace: {
          shape: 'two_roots', branchName: 'feature/work', repoRoot, scratchRoot
        }
      } as MaterializedExecutionEnvironment;
      const first = await reviewedWorkspaceProof(environment, root);
      expect(first).toEqual(expect.any(String));
      await writeFile(join(repoRoot, 'ordinary'), 'content');
      await git(repoRoot, 'add', 'ordinary');
      await git(repoRoot, 'commit', '-m', 'ordinary revision');
      expect(await reviewedWorkspaceProof(environment, root)).toBe(first);
      await rename(scratchRoot, scratchRoot + '-old');
      expect(await reviewedWorkspaceProof(environment, root)).toBeNull();
      await mkdir(scratchRoot);
      const replacement = await reviewedWorkspaceProof(environment, root);
      expect(replacement).toEqual(expect.any(String));
      expect(replacement).not.toBe(first);
      expect(await reviewedWorkspaceProof(environment, host)).toBeNull();
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
