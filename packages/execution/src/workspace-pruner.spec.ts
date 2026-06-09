import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspacePruner } from './internal/workspace-pruner.js';
import type { PathStatKind, WorkspaceDriver } from './internal/workspace-driver.js';

class FakeDriver implements WorkspaceDriver {
  calls: string[] = [];
  statKind: PathStatKind = 'directory';
  paths = new Set<string>(['/tmp', '/tmp/workspaces']);

  async statPath(): Promise<PathStatKind> { this.calls.push('statPath'); return this.statKind; }
  async pathExists(targetPath: string): Promise<boolean> { return this.paths.has(path.resolve(targetPath)); }
  async realpath(targetPath: string): Promise<string> { return path.resolve(targetPath); }
  async removeDirectory(): Promise<void> { this.calls.push('removeDirectory'); }
  async removeWorktree(): Promise<void> { this.calls.push('removeWorktree'); }
  async pruneWorktreeAdminState(): Promise<void> { this.calls.push('pruneWorktreeAdminState'); }
  async ensureHostRepository(): Promise<void> {}
  async fetchHostRepository(): Promise<void> {}
  async resolveDefaultBranch(): Promise<string> { return 'origin/main'; }
  async addWorktree(): Promise<void> {}
  async currentBranch(): Promise<string | null> { return 'feature/example-Abc123'; }
  async mkdirp(): Promise<void> {}
  async hasUncommittedChanges(): Promise<boolean> { return false; }
  async stageAll(): Promise<void> {}
  async commit(): Promise<string> { return 'abc123'; }
  async deleteBranch(): Promise<void> {}
}

describe('workspace pruner', () => {
  it.each(['file', 'symlink', 'other'] satisfies PathStatKind[])('rejects %s targets before deletion', async (statKind) => {
    const driver = new FakeDriver();
    driver.statKind = statKind;
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'directory',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123'
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'target_not_directory' });
    expect(driver.calls).toEqual(['statPath']);
  });

  it('rejects out-of-root targets before stat or deletion', async () => {
    const driver = new FakeDriver();
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'directory',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/outside/run_123'
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'out_of_root_path' });
    expect(driver.calls).toEqual([]);
  });

  it('returns missing for absent directory targets', async () => {
    const driver = new FakeDriver();
    driver.statKind = 'missing';
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'directory',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123'
    });
    expect(result).toMatchObject({ status: 'missing' });
    expect(driver.calls).toEqual(['statPath']);
  });

  it('deletes present directory targets through removeDirectory', async () => {
    const driver = new FakeDriver();
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'directory',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123'
    });
    expect(result).toMatchObject({ status: 'deleted' });
    expect(driver.calls).toEqual(['statPath', 'removeDirectory']);
  });

  it('deletes present worktree targets through removeWorktree without deleting branches', async () => {
    const driver = new FakeDriver();
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'worktree',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123/repo',
      hostRepositoryPath: '/tmp/repos/acme/widgets'
    });
    expect(result).toMatchObject({ status: 'deleted' });
    expect(driver.calls).toEqual(['statPath', 'removeWorktree']);
    expect(driver.calls).not.toContain('deleteBranch');
  });

  it('reconciles missing worktree admin state and returns missing', async () => {
    const driver = new FakeDriver();
    driver.statKind = 'missing';
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'worktree',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123/repo',
      hostRepositoryPath: '/tmp/repos/acme/widgets'
    });
    expect(result).toMatchObject({ status: 'missing' });
    expect(driver.calls).toEqual(['statPath', 'pruneWorktreeAdminState']);
  });

  it.each(['directory', 'worktree'] as const)('rejects symlink targets in %s mode without cleanup', async (mode) => {
    const driver = new FakeDriver();
    driver.statKind = 'symlink';
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode,
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123/link',
      ...(mode === 'worktree' && { hostRepositoryPath: '/tmp/repos/acme/widgets' })
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'target_not_directory' });
    expect(driver.calls).toEqual(['statPath']);
  });

  it('fails worktree mode without a host repository path', async () => {
    const driver = new FakeDriver();
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'worktree',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123/repo'
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'missing_host_repository' });
    expect(driver.calls).toEqual(['statPath']);
  });

  it('emits sanitized started and completed prune logs', async () => {
    const driver = new FakeDriver();
    const events: unknown[] = [];
    let value = 10;
    const pruner = createWorkspacePruner({
      driver,
      now: () => (value += 5),
      logger: { emit: (_level, event) => events.push(event) }
    });
    await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'directory',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123'
    });
    expect(events).toEqual([
      expect.objectContaining({ event: 'workspace.prune.started', runId: 'run_123', mode: 'directory' }),
      expect.objectContaining({ event: 'workspace.prune.completed', runId: 'run_123', status: 'deleted', durationMs: 5 })
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('rejects in-root symlink pointing outside root as target_not_directory, not out_of_root_path', async () => {
    // The symlink entry itself is inside the root (containment passes),
    // but lstat classifies it as 'symlink' which is not 'directory'
    const driver = new FakeDriver();
    driver.statKind = 'symlink';
    // Make the target path appear to be inside root for containment
    driver.paths = new Set(['/tmp', '/tmp/workspaces', '/tmp/workspaces/acme', '/tmp/workspaces/acme/widgets']);
    const pruner = createWorkspacePruner({ driver });
    const result = await pruner.pruneWorkspacePath({
      runId: 'run_123',
      mode: 'directory',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/escape-link'
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'target_not_directory' });
    expect(driver.calls).toEqual(['statPath']);
  });
});
