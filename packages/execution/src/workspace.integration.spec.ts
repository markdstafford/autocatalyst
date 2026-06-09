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
      workspaceRoot: workspacesRoot,
      runRoot,
      repoRoot,
      scratchRoot,
      hostRepositoryPath,
      branchName: 'feature/hello-world-Abc123'
    });
    await expect(fs.stat(hostRepositoryPath)).resolves.toMatchObject({});
    await expect(fs.stat(repoRoot)).resolves.toMatchObject({});
    await expect(fs.stat(scratchRoot)).resolves.toMatchObject({});
    await expect(git(['branch', '--show-current'], repoRoot)).resolves.toBe('feature/hello-world-Abc123');
    await expect(fs.readFile(path.join(repoRoot, 'README.md'), 'utf8')).resolves.toBe('# Example\n');
  });

  it('reuses the same host clone for repeated runs and does not push run branches upstream', async () => {
    await provisionWorkspace(makeRequest({ runId: 'run_123', shortRunId: 'Abc123' }));
    await provisionWorkspace(makeRequest({ runId: 'run_456', shortRunId: 'Def456', topicSlug: 'Second Run' }));

    const hostRepositoryPath = path.join(reposRoot, 'acme', 'widgets');
    await expect(fs.stat(hostRepositoryPath)).resolves.toMatchObject({});
    await expect(fs.stat(path.join(reposRoot, 'acme', 'widgets-2'))).rejects.toThrow();
    const upstreamBranches = await git(['branch', '--list'], upstreamPath);
    expect(upstreamBranches).not.toContain('feature/second-run-Def456');
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
});
