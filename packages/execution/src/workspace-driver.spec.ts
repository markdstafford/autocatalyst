import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture every git invocation the driver issues. Hoisted so the module mock can see it.
const { gitCalls } = vi.hoisted(() => ({ gitCalls: [] as string[][] }));

vi.mock('node:child_process', () => ({
  execFile: (
    command: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: unknown, result: { stdout: string; stderr: string }) => void
  ) => {
    gitCalls.push([command, ...args]);
    callback(null, { stdout: '', stderr: '' });
  }
}));

// Imported after the mock so the driver's promisified execFile binds to the mock.
const { createNodeWorkspaceDriver } = await import('./internal/workspace-driver.js');

describe('workspace driver git command construction', () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let repoRoot: string;
  let hostRepositoryPath: string;

  beforeEach(async () => {
    gitCalls.length = 0;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocatalyst-driver-'));
    workspaceRoot = path.join(tempRoot, 'workspaces');
    repoRoot = path.join(workspaceRoot, 'acme', 'widgets', 'run_1', 'repo');
    hostRepositoryPath = path.join(tempRoot, 'repos', 'acme', 'widgets');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(hostRepositoryPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function worktreeAddCall(): readonly string[] | undefined {
    return gitCalls.find((call) => call[1] === 'worktree' && call[2] === 'add');
  }

  it('adds an existing-branch worktree without -b', async () => {
    const driver = createNodeWorkspaceDriver();
    await driver.addExistingBranchWorktree({
      workspaceRoot,
      hostRepositoryPath,
      repoRoot,
      branchName: 'feature/x-abc123'
    });

    const call = worktreeAddCall();
    expect(call).toBeDefined();
    expect(call).not.toContain('-b');
    expect(call).toEqual(['git', 'worktree', 'add', repoRoot, 'feature/x-abc123']);
  });

  it('keeps the -b flag for new-branch worktree creation', async () => {
    const driver = createNodeWorkspaceDriver();
    await driver.addWorktree({
      workspaceRoot,
      hostRepositoryPath,
      repoRoot,
      branchName: 'feature/x-abc123',
      baseRef: 'origin/main'
    });

    const call = worktreeAddCall();
    expect(call).toEqual(['git', 'worktree', 'add', '-b', 'feature/x-abc123', repoRoot, 'origin/main']);
  });

  it('checks branch existence without creating or modifying a worktree', async () => {
    const driver = createNodeWorkspaceDriver();
    const exists = await driver.branchExists({ hostRepositoryPath, branchName: 'feature/x-abc123' });

    expect(exists).toBe(true);
    expect(gitCalls).toContainEqual(['git', 'show-ref', '--verify', '--quiet', 'refs/heads/feature/x-abc123']);
    expect(gitCalls.some((call) => call[1] === 'worktree')).toBe(false);
  });
});
