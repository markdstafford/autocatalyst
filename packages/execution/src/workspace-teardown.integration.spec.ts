import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Project } from '@autocatalyst/api-contract';

import {
  provisionWorkspace,
  pruneWorkspacePath,
  teardownWorkspace,
  type ProvisionWorkspaceRequest
} from './workspace.js';

const execFileAsync = promisify(execFile);

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args as string[], { cwd, windowsHide: true });
  return result.stdout.trim();
}

function makeProject(remoteUrl: string): Project {
  return {
    id: 'project_1',
    owner: { kind: 'user', id: 'user_1', tenant: 'tenant_1' },
    tenant: 'tenant_1',
    displayName: 'Example Project',
    repoUrl: remoteUrl,
    hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: remoteUrl },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: [],
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z'
  } satisfies Project;
}

describe('workspace teardown integration', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let sourcePath: string;
  let reposRoot: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    await expect(git(['--version'])).resolves.toMatch(/^git version /);

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocatalyst-teardown-'));
    upstreamPath = path.join(tempRoot, 'upstream.git');
    sourcePath = path.join(tempRoot, 'source');
    reposRoot = path.join(tempRoot, 'repos');
    workspacesRoot = path.join(tempRoot, 'workspaces');

    await git(['init', '--bare', upstreamPath]);
    await git(['clone', upstreamPath, sourcePath]);
    await git(['checkout', '-b', 'main'], sourcePath);
    await git(['config', 'user.name', 'Autocatalyst Test'], sourcePath);
    await git(['config', 'user.email', 'test@example.invalid'], sourcePath);
    await fs.writeFile(path.join(sourcePath, 'README.md'), '# Example\n', 'utf8');
    await git(['add', 'README.md'], sourcePath);
    await git(['commit', '-m', 'initial commit'], sourcePath);
    await git(['push', '-u', 'origin', 'main'], sourcePath);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], upstreamPath);

    await fs.mkdir(reposRoot, { recursive: true });
    await fs.mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function makeRequest(overrides: Partial<ProvisionWorkspaceRequest> = {}): ProvisionWorkspaceRequest {
    return {
      runId: 'run_123',
      runKind: 'feature',
      topicSlug: 'Hello World',
      shortRunId: 'Abc123',
      defaultBranch: 'main',
      project: makeProject(upstreamPath),
      roots: { reposRoot, workspacesRoot },
      ...overrides
    };
  }

  it('removes the worktree and branch for done implementing runs', async () => {
    const provisioned = await provisionWorkspace(makeRequest());
    expect(provisioned.shape).toBe('two_roots');
    if (provisioned.shape !== 'two_roots') return;

    const result = await teardownWorkspace({
      runId: provisioned.runId,
      runKind: 'feature',
      terminalStep: 'done',
      workspaceRoot: provisioned.workspaceRoot,
      runRoot: provisioned.runRoot,
      repoRoot: provisioned.repoRoot,
      scratchRoot: provisioned.scratchRoot,
      hostRepositoryPath: provisioned.hostRepositoryPath,
      branchName: provisioned.branchName
    });

    expect(result.outcome).toBe('completed');
    expect(result.branch?.action).toBe('deleted');
    await expect(fs.stat(provisioned.repoRoot)).rejects.toThrow();
    await expect(fs.stat(provisioned.runRoot)).rejects.toThrow();
    const branchList = await git(['branch', '--list', provisioned.branchName], provisioned.hostRepositoryPath);
    expect(branchList).toBe('');
  });

  it('commits canceled tail changes with explicit Autocatalyst identity and keeps the branch', async () => {
    const provisioned = await provisionWorkspace(makeRequest({ runKind: 'bug', topicSlug: 'Broken Button' }));
    expect(provisioned.shape).toBe('two_roots');
    if (provisioned.shape !== 'two_roots') return;

    await fs.writeFile(path.join(provisioned.repoRoot, 'tail.txt'), 'saved before cancel\n', 'utf8');

    const result = await teardownWorkspace({
      runId: provisioned.runId,
      runKind: 'bug',
      terminalStep: 'canceled',
      workspaceRoot: provisioned.workspaceRoot,
      runRoot: provisioned.runRoot,
      repoRoot: provisioned.repoRoot,
      scratchRoot: provisioned.scratchRoot,
      hostRepositoryPath: provisioned.hostRepositoryPath,
      branchName: provisioned.branchName,
      checkpointKind: 'bug',
      checkpointSubject: ' Final Checkpoint. '
    });

    expect(result.outcome).toBe('completed');
    expect(result.branch?.action).toBe('retained');
    expect(result.checkpoint?.action).toBe('committed');
    expect(result.checkpoint?.message).toBe('fix: final checkpoint');

    // Worktree is gone
    await expect(fs.stat(provisioned.repoRoot)).rejects.toThrow();
    // Branch still exists
    const branchList = await git(['branch', '--list', provisioned.branchName], provisioned.hostRepositoryPath);
    expect(branchList).toContain(provisioned.branchName);

    // Check the committed file exists on the branch
    const inspectPath = path.join(tempRoot, 'inspect');
    await git(['worktree', 'add', inspectPath, provisioned.branchName], provisioned.hostRepositoryPath);
    const fileContent = await fs.readFile(path.join(inspectPath, 'tail.txt'), 'utf8');
    expect(fileContent).toBe('saved before cancel\n');
    // Check commit identity
    const logFormat = await git(['log', '-1', '--format=%an <%ae>%n%s'], inspectPath);
    expect(logFormat).toContain('Autocatalyst <autocatalyst@example.invalid>');
    expect(logFormat).toContain('fix: final checkpoint');
  });

  it('retains worktree and branch for failed implementing runs', async () => {
    const provisioned = await provisionWorkspace(makeRequest());
    expect(provisioned.shape).toBe('two_roots');
    if (provisioned.shape !== 'two_roots') return;

    const result = await teardownWorkspace({
      runId: provisioned.runId,
      runKind: 'feature',
      terminalStep: 'failed',
      workspaceRoot: provisioned.workspaceRoot,
      runRoot: provisioned.runRoot,
      repoRoot: provisioned.repoRoot,
      scratchRoot: provisioned.scratchRoot,
      hostRepositoryPath: provisioned.hostRepositoryPath,
      branchName: provisioned.branchName
    });

    expect(result.outcome).toBe('retained');
    await expect(fs.stat(provisioned.repoRoot)).resolves.toBeDefined();
    const branchList = await git(['branch', '--list', provisioned.branchName], provisioned.hostRepositoryPath);
    expect(branchList).toContain(provisioned.branchName);
  });

  it.each(['done', 'canceled', 'failed'] as const)(
    'removes scratch-only file_issue run directories at %s',
    async (terminalStep) => {
      const runId = `run_${terminalStep}`;
      const provisioned = await provisionWorkspace(
        makeRequest({ runId, runKind: 'file_issue', shortRunId: 'Abc123' })
      );
      expect(provisioned.shape).toBe('scratch_only');
      if (provisioned.shape !== 'scratch_only') return;

      const result = await teardownWorkspace({
        runId: provisioned.runId,
        runKind: 'file_issue',
        terminalStep,
        workspaceRoot: provisioned.workspaceRoot,
        runRoot: provisioned.runRoot,
        scratchRoot: provisioned.scratchRoot
      });

      expect(result.outcome).toBe('completed');
      await expect(fs.stat(provisioned.runRoot)).rejects.toThrow();
      // Parent workspace root should still exist
      await expect(fs.stat(workspacesRoot)).resolves.toBeDefined();
    }
  );

  it('reports missing and rejected prune targets without deleting outside paths', async () => {
    const missing = await pruneWorkspacePath({
      runId: 'run_missing',
      mode: 'directory',
      workspaceRoot: workspacesRoot,
      targetPath: path.join(workspacesRoot, 'missing')
    });
    expect(missing.status).toBe('missing');

    const outside = path.join(tempRoot, 'outside-keep');
    await fs.mkdir(outside);
    const rejected = await pruneWorkspacePath({
      runId: 'run_rejected',
      mode: 'directory',
      workspaceRoot: workspacesRoot,
      targetPath: outside
    });
    expect(rejected).toMatchObject({ status: 'rejected', errorCode: 'out_of_root_path' });
    await expect(fs.stat(outside)).resolves.toBeDefined();
  });

  it('rejects in-root symlink prune targets as target_not_directory', async () => {
    const outside = path.join(tempRoot, 'outside-target');
    const link = path.join(workspacesRoot, 'escape-link');
    await fs.mkdir(outside);
    await fs.symlink(outside, link);

    const result = await pruneWorkspacePath({
      runId: 'run_symlink',
      mode: 'directory',
      workspaceRoot: workspacesRoot,
      targetPath: link
    });

    expect(result).toMatchObject({ status: 'rejected', errorCode: 'target_not_directory' });
    // Outside directory was not deleted
    await expect(fs.stat(outside)).resolves.toBeDefined();
  });

  it('reconciles stale worktree admin state for absent worktree path and returns missing', async () => {
    const provisioned = await provisionWorkspace(makeRequest());
    expect(provisioned.shape).toBe('two_roots');
    if (provisioned.shape !== 'two_roots') return;

    // Remove the worktree directory outside of Autocatalyst (simulates out-of-band removal)
    await fs.rm(provisioned.repoRoot, { recursive: true, force: true });

    const result = await pruneWorkspacePath({
      runId: provisioned.runId,
      mode: 'worktree',
      workspaceRoot: provisioned.workspaceRoot,
      targetPath: provisioned.repoRoot,
      hostRepositoryPath: provisioned.hostRepositoryPath
    });

    expect(result.status).toBe('missing');
    // The worktree admin state should be reconciled (no error)
  });
});
