import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Project } from '@autocatalyst/api-contract';

import type { ProvisionWorkspaceRequest } from './workspace.js';
import { createWorkspaceProvisioner } from './internal/workspace-provisioner.js';
import type { WorkspaceDriver } from './internal/workspace-driver.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project_1',
    owner: { kind: 'user', id: 'user_1', tenant: 'tenant_1' },
    tenant: 'tenant_1',
    displayName: 'Example Project',
    repoUrl: 'https://example.com/acme/widgets.git',
    hostRepository: {
      provider: 'github',
      owner: 'acme',
      name: 'widgets',
      url: 'https://example.com/acme/widgets.git'
    },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: [],
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...overrides
  } satisfies Project;
}

function makeRequest(overrides: Partial<ProvisionWorkspaceRequest> = {}): ProvisionWorkspaceRequest {
  return {
    runId: 'run_123',
    runKind: 'feature',
    topicSlug: 'Hello World',
    shortRunId: 'Abc123',
    defaultBranch: 'main',
    project: makeProject(),
    roots: { reposRoot: '/tmp/repos', workspacesRoot: '/tmp/workspaces' },
    ...overrides
  };
}

class FakeWorkspaceDriver implements WorkspaceDriver {
  readonly calls: string[] = [];
  readonly paths = new Set<string>(['/tmp', '/tmp/repos', '/tmp/workspaces']);
  currentBranchValue: string | null = 'feature/hello-world-Abc123';
  failOnCall?: string;
  removeDirectoryFails = false;
  removeWorktreeFails = false;

  async ensureHostRepository(): Promise<void> {
    this.record('ensureHostRepository');
  }

  async fetchHostRepository(): Promise<void> {
    this.record('fetchHostRepository');
  }

  async resolveDefaultBranch(): Promise<string> {
    this.record('resolveDefaultBranch');
    return 'origin/main';
  }

  async addWorktree(): Promise<void> {
    this.record('addWorktree');
    this.paths.add('/tmp/workspaces/acme/widgets/run_123/repo');
  }

  async currentBranch(): Promise<string | null> {
    this.record('currentBranch');
    return this.currentBranchValue;
  }

  async removeWorktree(): Promise<void> {
    this.record('removeWorktree');
    if (this.removeWorktreeFails) {
      throw new Error('removeWorktree failed');
    }
  }

  async mkdirp(targetPath: string): Promise<void> {
    this.record(`mkdirp:${targetPath}`);
    this.paths.add(path.resolve(targetPath));
  }

  async pathExists(targetPath: string): Promise<boolean> {
    this.record(`pathExists:${targetPath}`);
    return this.paths.has(path.resolve(targetPath));
  }

  async realpath(targetPath: string): Promise<string> {
    this.record(`realpath:${targetPath}`);
    return path.resolve(targetPath);
  }

  async removeDirectory(input: { readonly targetPath: string }): Promise<void> {
    this.record(`removeDirectory:${input.targetPath}`);
    if (this.removeDirectoryFails) {
      throw new Error('https://user:secret@example.com cleanup failed');
    }
    this.paths.delete(path.resolve(input.targetPath));
  }

  private record(call: string): void {
    this.calls.push(call);
    if (this.failOnCall === call) {
      throw new Error('https://user:secret@example.com induced failure');
    }
  }
}

describe('workspace provisioner', () => {
  it('returns no workspace for question runs without filesystem or git mutations', async () => {
    const driver = new FakeWorkspaceDriver();
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest({ runKind: 'question' }))).resolves.toEqual({
      shape: 'none',
      runId: 'run_123'
    });
    expect(driver.calls).toEqual([]);
  });

  it('creates run root and scratch only for file_issue runs', async () => {
    const driver = new FakeWorkspaceDriver();
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest({ runKind: 'file_issue' }))).resolves.toMatchObject({
      shape: 'scratch_only',
      runRoot: path.resolve('/tmp/workspaces/acme/widgets/run_123'),
      scratchRoot: path.resolve('/tmp/workspaces/acme/widgets/run_123/scratch')
    });
    expect(driver.calls).toContain(`mkdirp:${path.resolve('/tmp/workspaces/acme/widgets/run_123')}`);
    expect(driver.calls).toContain(`mkdirp:${path.resolve('/tmp/workspaces/acme/widgets/run_123/scratch')}`);
    expect(driver.calls).not.toContain('ensureHostRepository');
    expect(driver.calls).not.toContain('fetchHostRepository');
    expect(driver.calls).not.toContain('resolveDefaultBranch');
    expect(driver.calls).not.toContain('addWorktree');
  });

  it('creates implementing workspaces in git-safe order', async () => {
    const driver = new FakeWorkspaceDriver();
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest())).resolves.toMatchObject({
      shape: 'two_roots',
      branchName: 'feature/hello-world-Abc123',
      hostRepositoryPath: path.resolve('/tmp/repos/acme/widgets'),
      repoRoot: path.resolve('/tmp/workspaces/acme/widgets/run_123/repo'),
      scratchRoot: path.resolve('/tmp/workspaces/acme/widgets/run_123/scratch')
    });

    const nonPathExists = driver.calls.filter((call) => !call.startsWith('pathExists:') && !call.startsWith('realpath:'));
    expect(nonPathExists).toEqual([
      'ensureHostRepository',
      'fetchHostRepository',
      'resolveDefaultBranch',
      `mkdirp:${path.resolve('/tmp/workspaces/acme/widgets/run_123')}`,
      'addWorktree',
      `mkdirp:${path.resolve('/tmp/workspaces/acme/widgets/run_123/scratch')}`,
      'currentBranch'
    ]);
  });

  it('fails when an existing run root would be overwritten', async () => {
    const driver = new FakeWorkspaceDriver();
    driver.paths.add(path.resolve('/tmp/workspaces/acme/widgets/run_123'));
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest())).rejects.toMatchObject({ code: 'run_workspace_exists' });
  });

  it('fails branch guard mismatch with expected and actual branch context', async () => {
    const driver = new FakeWorkspaceDriver();
    driver.currentBranchValue = 'feature/other-Abc123';
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest())).rejects.toMatchObject({
      code: 'branch_guard_failed',
      context: { expectedBranch: 'feature/hello-world-Abc123', actualBranch: 'feature/other-Abc123' }
    });
  });

  it('rolls back the run root after worktree creation failure', async () => {
    const driver = new FakeWorkspaceDriver();
    driver.failOnCall = 'addWorktree';
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest())).rejects.toThrow(/induced failure/);
    expect(driver.calls).toContain(`removeDirectory:${path.resolve('/tmp/workspaces/acme/widgets/run_123')}`);
  });

  it('removes the git worktree before deleting the run root after post-worktree failure', async () => {
    const driver = new FakeWorkspaceDriver();
    driver.failOnCall = `mkdirp:${path.resolve('/tmp/workspaces/acme/widgets/run_123/scratch')}`;
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest())).rejects.toThrow(/induced failure/);
    expect(driver.calls.indexOf('removeWorktree')).toBeGreaterThan(driver.calls.indexOf('addWorktree'));
    expect(driver.calls.indexOf(`removeDirectory:${path.resolve('/tmp/workspaces/acme/widgets/run_123')}`)).toBeGreaterThan(
      driver.calls.indexOf('removeWorktree')
    );
  });

  it('still removes the run root even when removeWorktree fails during rollback', async () => {
    const driver = new FakeWorkspaceDriver();
    driver.failOnCall = `mkdirp:${path.resolve('/tmp/workspaces/acme/widgets/run_123/scratch')}`;
    driver.removeWorktreeFails = true;
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest())).rejects.toMatchObject({
      code: 'rollback_failed'
    });
    // Directory removal must still have been attempted despite removeWorktree failing
    expect(driver.calls).toContain(`removeDirectory:${path.resolve('/tmp/workspaces/acme/widgets/run_123')}`);
  });

  it('preserves the original failure and redacts rollback credential diagnostics', async () => {
    const driver = new FakeWorkspaceDriver();
    driver.failOnCall = `mkdirp:${path.resolve('/tmp/workspaces/acme/widgets/run_123/scratch')}`;
    driver.removeDirectoryFails = true;
    const provisioner = createWorkspaceProvisioner({ driver });

    await expect(provisioner.provisionWorkspace(makeRequest())).rejects.toMatchObject({
      code: 'rollback_failed',
      context: {
        cause: { message: 'https://[redacted]@example.com induced failure' },
        rollbackCause: { message: 'https://[redacted]@example.com cleanup failed' }
      }
    });
  });
});
