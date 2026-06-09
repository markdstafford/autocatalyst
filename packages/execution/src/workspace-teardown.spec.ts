import { describe, expect, it } from 'vitest';

import { createWorkspaceTeardown } from './internal/workspace-teardown.js';
import type { WorkspaceDriver, PathStatKind } from './internal/workspace-driver.js';
import type { WorkspacePruner } from './internal/workspace-pruner.js';
import type { WorkspacePruneResult } from './workspace.js';

class FakeDriver {
  calls: string[] = [];
  branch = 'feature/example-Abc123';
  dirty = false;
  throwOnDeleteBranch = false;
  throwOnCommit = false;
  statResult: PathStatKind = 'directory';

  async currentBranch(): Promise<string | null> {
    this.calls.push('currentBranch');
    return this.branch;
  }
  async statPath(): Promise<PathStatKind> {
    this.calls.push('statPath');
    return this.statResult;
  }
  async hasUncommittedChanges(): Promise<boolean> {
    this.calls.push('hasUncommittedChanges');
    return this.dirty;
  }
  async stageAll(): Promise<void> {
    this.calls.push('stageAll');
  }
  async commit(): Promise<string> {
    this.calls.push('commit');
    if (this.throwOnCommit) throw new Error('commit failed');
    return 'abc123';
  }
  async deleteBranch(): Promise<void> {
    this.calls.push('deleteBranch');
    if (this.throwOnDeleteBranch) throw new Error('delete branch failed');
  }
  async removeDirectory(): Promise<void> {
    throw new Error('teardown must not call removeDirectory directly');
  }
  async removeWorktree(): Promise<void> {
    throw new Error('teardown must not call removeWorktree directly');
  }
}

function fakePruner(calls: string[]): WorkspacePruner {
  return {
    async pruneWorkspacePath(request): Promise<WorkspacePruneResult> {
      calls.push(`prune:${request.mode}:${request.targetPath}`);
      return {
        runId: request.runId,
        mode: request.mode,
        status: 'deleted',
        root: request.workspaceRoot,
        targetPath: request.targetPath,
        durationMs: 1
      };
    }
  };
}

const baseRequest = {
  runId: 'run_123',
  runKind: 'feature' as const,
  terminalStep: 'done' as const,
  workspaceRoot: '/tmp/workspaces',
  runRoot: '/tmp/workspaces/acme/widgets/run_123',
  repoRoot: '/tmp/workspaces/acme/widgets/run_123/repo',
  scratchRoot: '/tmp/workspaces/acme/widgets/run_123/scratch',
  hostRepositoryPath: '/tmp/repos/acme/widgets',
  branchName: 'feature/example-Abc123'
};

describe('workspace teardown', () => {
  it('rejects non-terminal steps', async () => {
    const calls: string[] = [];
    const fake = new FakeDriver();
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
    await expect(
      teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'review' as 'done' })
    ).rejects.toMatchObject({ code: 'invalid_terminal_step' });
    expect(calls).toEqual([]);
  });

  it('tears down done implementing runs by pruning worktree before deleting branch', async () => {
    const fake = new FakeDriver();
    const calls = fake.calls;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
    const result = await teardown.teardownWorkspace(baseRequest);
    expect(result).toMatchObject({ outcome: 'completed', branch: { action: 'deleted' } });
    expect(calls).toEqual([
      'prune:worktree:/tmp/workspaces/acme/widgets/run_123/repo',
      'prune:directory:/tmp/workspaces/acme/widgets/run_123',
      'deleteBranch'
    ]);
  });

  it('returns partial_failure when branch deletion fails after successful prune', async () => {
    const fake = new FakeDriver();
    fake.throwOnDeleteBranch = true;
    const calls = fake.calls;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
    const result = await teardown.teardownWorkspace(baseRequest);
    expect(result).toMatchObject({ outcome: 'partial_failure', branch: { action: 'failed' } });
  });

  it('commits canceled changes with normalized fallback message before pruning', async () => {
    const fake = new FakeDriver();
    fake.dirty = true;
    const calls = fake.calls;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
    const result = await teardown.teardownWorkspace({ ...baseRequest, runKind: 'bug', terminalStep: 'canceled' });
    expect(result).toMatchObject({
      outcome: 'completed',
      branch: { action: 'retained' },
      checkpoint: { action: 'committed', message: 'chore: final checkpoint' }
    });
    expect(calls).toEqual([
      'currentBranch',
      'hasUncommittedChanges',
      'stageAll',
      'commit',
      'prune:worktree:/tmp/workspaces/acme/widgets/run_123/repo',
      'prune:directory:/tmp/workspaces/acme/widgets/run_123'
    ]);
  });

  it('uses feat prefix when checkpointKind is feature', async () => {
    const fake = new FakeDriver();
    fake.dirty = true;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner([]) });
    const result = await teardown.teardownWorkspace({
      ...baseRequest,
      terminalStep: 'canceled',
      checkpointKind: 'feature',
      checkpointSubject: 'my custom change'
    });
    expect(result.checkpoint).toMatchObject({ action: 'committed', message: 'feat: my custom change' });
  });

  it('uses fix prefix when checkpointKind is bug', async () => {
    const fake = new FakeDriver();
    fake.dirty = true;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner([]) });
    const result = await teardown.teardownWorkspace({
      ...baseRequest,
      runKind: 'bug',
      terminalStep: 'canceled',
      checkpointKind: 'bug',
      checkpointSubject: 'fixed the bug'
    });
    expect(result.checkpoint).toMatchObject({ action: 'committed', message: 'fix: fixed the bug' });
  });

  it('defaults to chore prefix when checkpointKind is omitted', async () => {
    const fake = new FakeDriver();
    fake.dirty = true;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner([]) });
    const result = await teardown.teardownWorkspace({
      ...baseRequest,
      runKind: 'feature',
      terminalStep: 'canceled',
      checkpointSubject: 'some work'
    });
    expect(result.checkpoint).toMatchObject({ action: 'committed', message: 'chore: some work' });
  });

  it('treats detached HEAD (currentBranch null, repoRoot present) as failed with worktree_branch_mismatch', async () => {
    const fake = new FakeDriver();
    fake.branch = null as unknown as string;
    fake.statResult = 'directory';
    const pruneCalls: string[] = [];
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(pruneCalls) });
    const result = await teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'canceled' });
    expect(result).toMatchObject({ outcome: 'failed', checkpoint: { action: 'failed', errorCode: 'worktree_branch_mismatch' } });
    expect(pruneCalls).toEqual([]);
  });

  it('treats unreadable branch (currentBranch null, repoRoot present) as failed with worktree_branch_mismatch', async () => {
    const fake = new FakeDriver();
    fake.branch = null as unknown as string;
    fake.statResult = 'directory';
    const pruneCalls: string[] = [];
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(pruneCalls) });
    const result = await teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'canceled' });
    expect(result).toMatchObject({ outcome: 'failed', checkpoint: { action: 'failed', errorCode: 'worktree_branch_mismatch' } });
    expect(pruneCalls).toEqual([]);
  });

  it('reconciles truly absent worktree (currentBranch null, repoRoot missing) as retained', async () => {
    const fake = new FakeDriver();
    fake.branch = null as unknown as string;
    fake.statResult = 'missing';
    const pruneCalls: string[] = [];
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(pruneCalls) });
    const result = await teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'canceled' });
    expect(result).toMatchObject({ outcome: 'retained', branch: { action: 'retained' }, checkpoint: { action: 'not_applicable' } });
    expect(pruneCalls).toEqual(['prune:worktree:/tmp/workspaces/acme/widgets/run_123/repo']);
  });

  it('reconciles missing worktree with rejected prune as failed outcome', async () => {
    const fake = new FakeDriver();
    fake.branch = null as unknown as string;
    fake.statResult = 'missing';
    const rejectingPruner: WorkspacePruner = {
      async pruneWorkspacePath(request): Promise<WorkspacePruneResult> {
        return { runId: request.runId, mode: request.mode, status: 'rejected', root: request.workspaceRoot, targetPath: request.targetPath, durationMs: 1 };
      }
    };
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: rejectingPruner });
    const result = await teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'canceled' });
    expect(result).toMatchObject({ outcome: 'failed' });
  });

  it('gates run-directory prune when worktree prune returns failed', async () => {
    const fake = new FakeDriver();
    const pruneCalls: string[] = [];
    const failingWorktreePruner: WorkspacePruner = {
      async pruneWorkspacePath(request): Promise<WorkspacePruneResult> {
        pruneCalls.push(`prune:${request.mode}:${request.targetPath}`);
        const status = request.mode === 'worktree' ? 'failed' : 'deleted';
        return { runId: request.runId, mode: request.mode, status, root: request.workspaceRoot, targetPath: request.targetPath, durationMs: 1 };
      }
    };
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: failingWorktreePruner });
    const result = await teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'canceled' });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(pruneCalls).toEqual(['prune:worktree:/tmp/workspaces/acme/widgets/run_123/repo']);
  });

  it('gates run-directory prune when worktree prune returns rejected', async () => {
    const fake = new FakeDriver();
    const pruneCalls: string[] = [];
    const rejectedWorktreePruner: WorkspacePruner = {
      async pruneWorkspacePath(request): Promise<WorkspacePruneResult> {
        pruneCalls.push(`prune:${request.mode}:${request.targetPath}`);
        const status = request.mode === 'worktree' ? 'rejected' : 'deleted';
        return { runId: request.runId, mode: request.mode, status, root: request.workspaceRoot, targetPath: request.targetPath, durationMs: 1 };
      }
    };
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: rejectedWorktreePruner });
    const result = await teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'canceled' });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(pruneCalls).toEqual(['prune:worktree:/tmp/workspaces/acme/widgets/run_123/repo']);
  });

  it.each(['feat: already prefixed', 'line\nbreak', 'chore:\ttabbed'])(
    'rejects invalid checkpoint subject %s before staging or pruning',
    async (checkpointSubject) => {
      const fake = new FakeDriver();
      fake.dirty = true;
      const calls = fake.calls;
      const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
      await expect(
        teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'canceled', checkpointSubject })
      ).rejects.toMatchObject({ code: 'invalid_checkpoint_subject' });
      expect(calls).toEqual([]);
    }
  );

  it('retains workspace for failed implementing runs without pruning', async () => {
    const fake = new FakeDriver();
    const calls = fake.calls;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
    const result = await teardown.teardownWorkspace({ ...baseRequest, terminalStep: 'failed' });
    expect(result).toMatchObject({ outcome: 'retained', branch: { action: 'retained' } });
    expect(calls).toEqual([]);
  });

  it.each(['done', 'canceled', 'failed'] as const)('prunes file_issue run directory at %s', async (terminalStep) => {
    const fake = new FakeDriver();
    const calls = fake.calls;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
    const result = await teardown.teardownWorkspace({
      runId: 'run_123',
      runKind: 'file_issue',
      terminalStep,
      workspaceRoot: '/tmp/workspaces',
      runRoot: '/tmp/workspaces/acme/widgets/run_123'
    });
    expect(result).toMatchObject({ outcome: 'completed', branch: { action: 'not_applicable' } });
    expect(calls).toEqual(['prune:directory:/tmp/workspaces/acme/widgets/run_123']);
  });

  it.each(['done', 'canceled', 'failed'] as const)('skips question teardown at %s', async (terminalStep) => {
    const fake = new FakeDriver();
    const calls = fake.calls;
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner(calls) });
    const result = await teardown.teardownWorkspace({ runId: 'run_123', runKind: 'question', terminalStep });
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(result.prunes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('does not call removeDirectory or removeWorktree directly (no bypass)', async () => {
    // FakeDriver.removeDirectory and removeWorktree throw if called directly
    // This verifies teardown routes all deletion through the pruner
    const fake = new FakeDriver();
    const teardown = createWorkspaceTeardown({ driver: fake as unknown as WorkspaceDriver, pruner: fakePruner([]) });
    // Should not throw because teardown uses the pruner, not driver.removeDirectory/removeWorktree
    await expect(teardown.teardownWorkspace(baseRequest)).resolves.toMatchObject({ outcome: 'completed' });
  });

  it('emits structured teardown logs without sensitive data', async () => {
    const fake = new FakeDriver();
    const events: unknown[] = [];
    const logger = { emit: (_level: string, event: unknown) => events.push(event) };
    const teardown = createWorkspaceTeardown({
      driver: fake as unknown as WorkspaceDriver,
      pruner: fakePruner([]),
      logger: logger as Parameters<typeof createWorkspaceTeardown>[0]['logger']
    });
    await teardown.teardownWorkspace(baseRequest);
    expect(events.some((e) => (e as Record<string, unknown>)['event'] === 'workspace.teardown.started')).toBe(true);
    expect(events.some((e) => (e as Record<string, unknown>)['event'] === 'workspace.teardown.completed')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('prompt');
  });
});
