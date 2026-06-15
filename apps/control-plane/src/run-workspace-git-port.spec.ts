import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRunWorkspaceGitPort } from './run-workspace-git-port.js';

const execFileAsync = promisify(execFile);

// Initialize a real git repo for testing
async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

describe('createRunWorkspaceGitPort', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'autocatalyst-git-test-'));
    await initGitRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('commits changed files and returns sha and file count', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    await writeFile(join(repoDir, 'test.txt'), 'hello');
    const result = await port.commitFiles({
      runId: 'run-1',
      workspaceRepoRoot: repoDir,
      message: 'test commit'
    });
    expect(result.commitSha).toBeTruthy();
    expect(result.changedFileCount).toBe(1);
  });

  it('returns null sha and 0 count when no changes', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    const result = await port.commitFiles({
      runId: 'run-1',
      workspaceRepoRoot: repoDir,
      message: 'empty commit'
    });
    expect(result.commitSha).toBeNull();
    expect(result.changedFileCount).toBe(0);
  });

  it('rejects when workspace root is outside workspacesRoot', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: '/some/other/root' });
    await expect(port.commitFiles({
      runId: 'run-1',
      workspaceRepoRoot: repoDir,
      message: 'escape attempt'
    })).rejects.toThrow();
  });

  it('exposes read-only reviewer policy', () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    expect(port.reviewerPolicy.fileAccess).toBe('read_only');
    expect(port.reviewerPolicy.gitAccess).toBe('read_only');
    expect(port.reviewerPolicy.forbiddenGitActions).toEqual(
      expect.arrayContaining(['commit', 'push', 'merge', 'checkout', 'switch', 'reset', 'rebase'])
    );
  });

  // ---------------------------------------------------------------------------
  // Containment and dangerous-operation code inspection
  // ---------------------------------------------------------------------------

  it('commitFiles rejects workspaceRepoRoot inside workspacesRoot when containment check fails', async () => {
    // Use a dedicated temp dir as workspacesRoot that does NOT contain repoDir.
    const otherRoot = await mkdtemp(join(tmpdir(), 'ac-other-root-'));
    try {
      const port = createRunWorkspaceGitPort({ workspacesRoot: otherRoot });
      await expect(port.commitFiles({
        runId: 'run-containment',
        workspaceRepoRoot: repoDir,
        message: 'containment check'
      })).rejects.toThrow('workspace_containment_violation');
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('run-workspace-git-port implementation does not contain branch-switching, push, merge, or rebase git commands', async () => {
    // Code-inspection test: read the implementation source and assert that
    // dangerous mutating git commands (push, merge, rebase, checkout, switch)
    // are not present. The only git commands the port is allowed to run are
    // status, add, commit, and rev-parse.
    const implPath = resolve(
      fileURLToPath(import.meta.url),
      '../run-workspace-git-port.ts'
    );
    const source = await readFile(implPath, 'utf-8');

    // These git sub-commands must not appear in the implementation source.
    const forbiddenCommands = ['git push', 'git merge', 'git rebase', 'git checkout', 'git switch', 'git branch -D'];
    for (const cmd of forbiddenCommands) {
      expect(source).not.toContain(cmd);
    }

    // These safe commands must be present (sanity-check that we are reading the right file).
    expect(source).toContain("'commit'");
    expect(source).toContain("'status'");
  });
});
