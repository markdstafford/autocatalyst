import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Project } from '@autocatalyst/api-contract';

import { provisionWorkspace, type ProvisionWorkspaceRequest } from './workspace.js';
import { assertPathInsideRoot } from './internal/workspace-paths.js';

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
    hostRepository: {
      provider: 'git',
      owner: 'acme',
      name: 'widgets',
      url: remoteUrl
    },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: [],
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z'
  } satisfies Project;
}

describe('workspace provisioning integration', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let sourcePath: string;
  let reposRoot: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    await expect(git(['--version'])).resolves.toMatch(/^git version /);

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocatalyst-workspace-'));
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

  it('provisions a two-root workspace from a real fetched git default branch', async () => {
    const result = await provisionWorkspace(makeRequest());

    const hostRepositoryPath = path.join(reposRoot, 'acme', 'widgets');
    const runRoot = path.join(workspacesRoot, 'acme', 'widgets', 'run_123');
    const repoRoot = path.join(runRoot, 'repo');
    const scratchRoot = path.join(runRoot, 'scratch');

    expect(result).toEqual({
      shape: 'two_roots',
      runId: 'run_123',
      outcome: 'materialized',
      workspaceRoot: workspacesRoot,
      runRoot,
      repoRoot,
      scratchRoot,
      hostRepositoryPath,
      branchName: 'feature/hello-world-Abc123',
      provisionedBaseRef: expect.any(String)
    });
    await expect(fs.stat(hostRepositoryPath)).resolves.toMatchObject({});
    await expect(fs.stat(repoRoot)).resolves.toMatchObject({});
    await expect(fs.stat(scratchRoot)).resolves.toMatchObject({});
    await expect(git(['branch', '--show-current'], repoRoot)).resolves.toBe('feature/hello-world-Abc123');
    await expect(fs.readFile(path.join(repoRoot, 'README.md'), 'utf8')).resolves.toBe('# Example\n');
  });

  it('reuses the same host clone for repeated runs and does not push run branches upstream', async () => {
    await provisionWorkspace(makeRequest({ runId: 'run_123', shortRunId: 'Abc123' }));
    const result2 = await provisionWorkspace(makeRequest({ runId: 'run_456', shortRunId: 'Def456', topicSlug: 'Second Run' }));

    expect(result2).toMatchObject({
      shape: 'two_roots',
      runId: 'run_456',
      branchName: 'feature/second-run-Def456'
    });
    await expect(fs.stat(path.join(workspacesRoot, 'acme', 'widgets', 'run_456', 'repo'))).resolves.toMatchObject({});

    const hostRepositoryPath = path.join(reposRoot, 'acme', 'widgets');
    await expect(fs.stat(hostRepositoryPath)).resolves.toMatchObject({});
    await expect(fs.stat(path.join(reposRoot, 'acme', 'widgets-2'))).rejects.toThrow();
    const upstreamBranchMatch = await git(['branch', '--list', 'feature/second-run-Def456'], upstreamPath);
    expect(upstreamBranchMatch).toBe('');
  });

  it('rejects traversal-bearing run ids before creating run directories', async () => {
    await expect(provisionWorkspace(makeRequest({ runId: '../evil' }))).rejects.toMatchObject({ code: 'invalid_run_id' });
    await expect(fs.stat(path.join(workspacesRoot, 'acme', 'widgets'))).rejects.toThrow();
  });

  it('rejects out-of-root containment targets with temporary paths', async () => {
    await expect(
      assertPathInsideRoot(
        { root: workspacesRoot, rootKind: 'workspace', targetPath: path.join(tempRoot, 'outside', 'run_123'), intent: 'write' },
        {
          async pathExists(targetPath) {
            try {
              await fs.access(targetPath);
              return true;
            } catch {
              return false;
            }
          },
          realpath: fs.realpath as (path: string) => Promise<string>
        }
      )
    ).rejects.toMatchObject({ code: 'out_of_root_path' });
  });

  it('rejects provisioning when a symlinked workspace parent escapes the workspace root before any filesystem mutation', async () => {
    const outsideDir = path.join(tempRoot, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    // Symlink workspacesRoot/acme -> outside directory (simulates a compromised parent segment)
    const symlinkPath = path.join(workspacesRoot, 'acme');
    await fs.symlink(outsideDir, symlinkPath);

    await expect(provisionWorkspace(makeRequest())).rejects.toMatchObject({ code: 'out_of_root_path' });

    // No run directory should have been created under the escape target
    await expect(fs.stat(path.join(outsideDir, 'widgets'))).rejects.toThrow();
  });

  async function commitOnRunBranch(repoRoot: string, fileName: string, contents: string): Promise<void> {
    await fs.writeFile(path.join(repoRoot, fileName), contents, 'utf8');
    await git(['add', fileName], repoRoot);
    await git(['-c', 'user.name=Autocatalyst Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `add ${fileName}`], repoRoot);
  }

  it('recreates a missing workspace from the existing run branch and restores a committed file', async () => {
    const first = await provisionWorkspace(makeRequest());
    expect(first.shape).toBe('two_roots');
    if (first.shape !== 'two_roots') return;

    await commitOnRunBranch(first.repoRoot, 'tracked.txt', 'restored\n');

    // Simulate a manual deletion of the on-disk workspace. The run branch and host repo
    // remain; the git worktree administrative state becomes stale.
    await fs.rm(first.runRoot, { recursive: true, force: true });
    await expect(fs.stat(first.repoRoot)).rejects.toThrow();

    const recovered = await provisionWorkspace(makeRequest({ materializationBase: { kind: 'run_branch' } }));
    expect(recovered).toMatchObject({
      shape: 'two_roots',
      outcome: 'materialized',
      branchName: 'feature/hello-world-Abc123'
    });
    if (recovered.shape !== 'two_roots') return;

    await expect(fs.readFile(path.join(recovered.repoRoot, 'tracked.txt'), 'utf8')).resolves.toBe('restored\n');
    await expect(git(['branch', '--show-current'], recovered.repoRoot)).resolves.toBe('feature/hello-world-Abc123');
    await expect(fs.readdir(recovered.scratchRoot)).resolves.toEqual([]);
  });

  it('fails with run_branch_missing and leaves no workspace when the run branch is absent', async () => {
    await expect(
      provisionWorkspace(makeRequest({ materializationBase: { kind: 'run_branch' } }))
    ).rejects.toMatchObject({ code: 'run_branch_missing' });

    await expect(fs.stat(path.join(workspacesRoot, 'acme', 'widgets', 'run_123'))).rejects.toThrow();
  });

  it('leaves an already-present workspace in place and preserves its scratch contents', async () => {
    const first = await provisionWorkspace(makeRequest());
    if (first.shape !== 'two_roots') return;
    await fs.writeFile(path.join(first.scratchRoot, 'keep.txt'), 'keep\n', 'utf8');

    const second = await provisionWorkspace(makeRequest({ materializationBase: { kind: 'run_branch' } }));
    expect(second).toMatchObject({ shape: 'two_roots', outcome: 'present' });

    await expect(fs.readFile(path.join(first.scratchRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
  });

  it('starts over from the fetched default branch, dropping prior run commits and updating provisionedBaseRef', async () => {
    const hostRepositoryPath = path.join(reposRoot, 'acme', 'widgets');
    const first = await provisionWorkspace(makeRequest());
    if (first.shape !== 'two_roots') return;

    await commitOnRunBranch(first.repoRoot, 'stale.txt', 'stale\n');
    const branchHeadBefore = await git(['rev-parse', 'feature/hello-world-Abc123'], hostRepositoryPath);

    // Start-over rebuild applies when the on-disk workspace is gone but the derived run
    // branch (with its stale commit) still lives in the host repository. Simulate that by
    // removing the run root first; a present-on-expected-branch workspace would instead be
    // left in place (covered separately below).
    await fs.rm(first.runRoot, { recursive: true, force: true });
    await expect(fs.stat(first.repoRoot)).rejects.toThrow();

    const rebuilt = await provisionWorkspace(makeRequest({ materializationBase: { kind: 'current_default_branch' } }));
    expect(rebuilt).toMatchObject({ shape: 'two_roots', outcome: 'materialized', provisionedBaseRef: 'origin/main' });
    if (rebuilt.shape !== 'two_roots') return;

    // No prior run commit survives, and the default-branch README is present.
    await expect(fs.stat(path.join(rebuilt.repoRoot, 'stale.txt'))).rejects.toThrow();
    await expect(fs.readFile(path.join(rebuilt.repoRoot, 'README.md'), 'utf8')).resolves.toBe('# Example\n');
    await expect(fs.readdir(rebuilt.scratchRoot)).resolves.toEqual([]);

    const branchHeadAfter = await git(['rev-parse', 'feature/hello-world-Abc123'], hostRepositoryPath);
    expect(branchHeadAfter).not.toBe(branchHeadBefore);
  });

  it('leaves an already-present workspace in place for a current_default_branch base and preserves committed work and scratch', async () => {
    const hostRepositoryPath = path.join(reposRoot, 'acme', 'widgets');
    const first = await provisionWorkspace(makeRequest());
    if (first.shape !== 'two_roots') return;

    await commitOnRunBranch(first.repoRoot, 'tracked.txt', 'keep\n');
    await fs.writeFile(path.join(first.scratchRoot, 'keep.txt'), 'scratch\n', 'utf8');
    const branchHeadBefore = await git(['rev-parse', 'feature/hello-world-Abc123'], hostRepositoryPath);

    // Explicit base must not wipe/rebuild a healthy, present workspace on the expected branch.
    const second = await provisionWorkspace(makeRequest({ materializationBase: { kind: 'current_default_branch' } }));
    expect(second).toMatchObject({ shape: 'two_roots', outcome: 'present' });

    await expect(fs.readFile(path.join(first.repoRoot, 'tracked.txt'), 'utf8')).resolves.toBe('keep\n');
    await expect(fs.readFile(path.join(first.scratchRoot, 'keep.txt'), 'utf8')).resolves.toBe('scratch\n');
    const branchHeadAfter = await git(['rev-parse', 'feature/hello-world-Abc123'], hostRepositoryPath);
    expect(branchHeadAfter).toBe(branchHeadBefore);
  });
});
