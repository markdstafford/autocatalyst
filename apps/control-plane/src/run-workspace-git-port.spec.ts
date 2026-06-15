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

  it('returns null sha and 0 count when no changes and allowEmpty is true (does not fail)', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    const result = await port.commitFiles({
      runId: 'run-1',
      workspaceRepoRoot: repoDir,
      message: 'allow-empty convergence round',
      allowEmpty: true
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

  // ---------------------------------------------------------------------------
  // Host-owned checkpoint refs
  // ---------------------------------------------------------------------------

  async function commitSingleFile(dir: string, name: string, contents: string, message: string): Promise<string> {
    await writeFile(join(dir, name), contents);
    await execFileAsync('git', ['add', '--all'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', message], { cwd: dir });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
    return stdout.trim();
  }

  it('captureCheckpointRef creates ref under refs/autocatalyst/runs/<runId>/implementation.build/<altitude>', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    const sha = await commitSingleFile(repoDir, 'layout.md', 'layout contents', 'initial');

    const result = await port.captureCheckpointRef({
      runId: 'run-abc',
      workspaceRepoRoot: repoDir,
      altitude: 'layout',
      commitSha: sha
    });

    expect(result.ref).toBe('refs/autocatalyst/runs/run-abc/implementation.build/layout');
    expect(result.commitSha).toBe(sha);

    // Verify the ref actually exists in the repo and points at sha.
    const { stdout: showRef } = await execFileAsync(
      'git',
      ['rev-parse', 'refs/autocatalyst/runs/run-abc/implementation.build/layout'],
      { cwd: repoDir }
    );
    expect(showRef.trim()).toBe(sha);
  });

  it('readFileAtRef returns file contents at the captured ref', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    const sha = await commitSingleFile(repoDir, 'hello.txt', 'world\n', 'initial');
    const { ref } = await port.captureCheckpointRef({
      runId: 'run-xyz',
      workspaceRepoRoot: repoDir,
      altitude: 'public_api',
      commitSha: sha
    });

    const result = await port.readFileAtRef({ workspaceRepoRoot: repoDir, ref, path: 'hello.txt' });
    expect(result).toBe('world\n');
  });

  it('readFileAtRef returns null when the file is absent at the ref', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    const sha = await commitSingleFile(repoDir, 'present.txt', 'x', 'initial');
    const { ref } = await port.captureCheckpointRef({
      runId: 'run-absent',
      workspaceRepoRoot: repoDir,
      altitude: 'layout',
      commitSha: sha
    });

    const result = await port.readFileAtRef({ workspaceRepoRoot: repoDir, ref, path: 'missing.txt' });
    expect(result).toBeNull();
  });

  it('listFilesAtRef returns every file tracked at the ref', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    await writeFile(join(repoDir, 'a.txt'), 'a');
    await writeFile(join(repoDir, 'b.txt'), 'b');
    await execFileAsync('git', ['add', '--all'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'two files'], { cwd: repoDir });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    const sha = stdout.trim();
    const { ref } = await port.captureCheckpointRef({
      runId: 'run-list',
      workspaceRepoRoot: repoDir,
      altitude: 'private_api',
      commitSha: sha
    });

    const files = await port.listFilesAtRef({ workspaceRepoRoot: repoDir, ref });
    expect([...files].sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('captureCheckpointRef rejects runId containing path traversal characters', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    const sha = await commitSingleFile(repoDir, 'f.txt', 'x', 'initial');

    await expect(port.captureCheckpointRef({
      runId: '../evil',
      workspaceRepoRoot: repoDir,
      altitude: 'layout',
      commitSha: sha
    })).rejects.toThrow('checkpoint_ref_invalid');

    await expect(port.captureCheckpointRef({
      runId: 'a/b',
      workspaceRepoRoot: repoDir,
      altitude: 'layout',
      commitSha: sha
    })).rejects.toThrow('checkpoint_ref_invalid');

    await expect(port.captureCheckpointRef({
      runId: 'has space',
      workspaceRepoRoot: repoDir,
      altitude: 'layout',
      commitSha: sha
    })).rejects.toThrow('checkpoint_ref_invalid');
  });

  it('readFileAtRef rejects refs that are neither refs/... nor raw commit SHAs', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    await expect(port.readFileAtRef({
      workspaceRepoRoot: repoDir,
      ref: 'HEAD',
      path: 'anything.txt'
    })).rejects.toThrow('checkpoint_ref_invalid');
  });

  it('listFilesAtRef rejects refs that are neither refs/... nor raw commit SHAs', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    await expect(port.listFilesAtRef({
      workspaceRepoRoot: repoDir,
      ref: 'main'
    })).rejects.toThrow('checkpoint_ref_invalid');
  });

  it('readFileAtRef rejects paths containing .. or absolute paths', async () => {
    const port = createRunWorkspaceGitPort({ workspacesRoot: tmpdir() });
    await expect(port.readFileAtRef({
      workspaceRepoRoot: repoDir,
      ref: 'refs/autocatalyst/runs/run-1/implementation.build/layout',
      path: '../etc/passwd'
    })).rejects.toThrow('checkpoint_path_invalid');

    await expect(port.readFileAtRef({
      workspaceRepoRoot: repoDir,
      ref: 'refs/autocatalyst/runs/run-1/implementation.build/layout',
      path: '/etc/passwd'
    })).rejects.toThrow('checkpoint_path_invalid');
  });

  it('captureCheckpointRef enforces workspace containment', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'ac-other-root-'));
    try {
      const port = createRunWorkspaceGitPort({ workspacesRoot: otherRoot });
      const sha = await commitSingleFile(repoDir, 'f.txt', 'x', 'initial');
      await expect(port.captureCheckpointRef({
        runId: 'run-1',
        workspaceRepoRoot: repoDir,
        altitude: 'layout',
        commitSha: sha
      })).rejects.toThrow('workspace_containment_violation');
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('readFileAtRef enforces workspace containment', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'ac-other-root-'));
    try {
      const port = createRunWorkspaceGitPort({ workspacesRoot: otherRoot });
      await expect(port.readFileAtRef({
        workspaceRepoRoot: repoDir,
        ref: 'refs/autocatalyst/runs/run-1/implementation.build/layout',
        path: 'a.txt'
      })).rejects.toThrow('workspace_containment_violation');
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});
