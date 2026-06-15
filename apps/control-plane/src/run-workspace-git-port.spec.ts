import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
});
