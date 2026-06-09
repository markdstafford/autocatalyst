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
});
