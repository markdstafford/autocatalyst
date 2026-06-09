import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Project } from '@autocatalyst/api-contract';

import { WorkspaceProvisioningError } from './workspace.js';
import {
  assertPathInsideRoot,
  deriveRunBranchName,
  resolveWorkspacePaths,
  selectWorkspaceProvisioningShape,
  validateRepositoryPathSegment,
  validateRunIdSegment
} from './internal/workspace-paths.js';

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

describe('workspace path helpers', () => {
  it.each([
    ['question', 'none'],
    ['file_issue', 'scratch_only'],
    ['feature', 'two_roots'],
    ['enhancement', 'two_roots'],
    ['bug', 'two_roots'],
    ['chore', 'two_roots']
  ] as const)('maps %s runs to %s provisioning', (runKind, expectedShape) => {
    expect(selectWorkspaceProvisioningShape(runKind)).toBe(expectedShape);
  });

  it('rejects unsupported run kinds with a typed error', () => {
    expect(() => selectWorkspaceProvisioningShape('maintenance')).toThrow(WorkspaceProvisioningError);
    expect(() => selectWorkspaceProvisioningShape('maintenance')).toThrow(/Unsupported run kind/);
  });

  it.each(['run_123', 'abc-DEF_123', '598c574f-9d97-415b-85d2-faccde2a91f0'])('accepts safe run id %s', (runId) => {
    expect(validateRunIdSegment(runId)).toBe(runId);
  });

  it.each(['', '.', '..', '../evil', 'evil/child', 'evil\\child', 'has nul', 'abc..def'])(
    'rejects unsafe run id %s',
    (runId) => {
      expect(() => validateRunIdSegment(runId)).toThrow(WorkspaceProvisioningError);
    }
  );

  it.each(['acme', 'widgets.repo', 'team_name', 'repo-name'])('accepts safe repository segment %s', (segment) => {
    expect(validateRepositoryPathSegment(segment, 'owner')).toBe(segment);
  });

  it.each(['', '.', '..', '../acme', 'acme/widgets', 'acme\\widgets', 'has nul', 'acme..widgets'])(
    'rejects unsafe repository segment %s',
    (segment) => {
      expect(() => validateRepositoryPathSegment(segment, 'owner')).toThrow(WorkspaceProvisioningError);
    }
  );

  it('resolves host, run, repo, and scratch paths under caller-supplied roots', () => {
    const paths = resolveWorkspacePaths({
      project: makeProject(),
      roots: { reposRoot: '/var/autocatalyst/repos', workspacesRoot: '/var/autocatalyst/workspaces' },
      runId: 'run_123'
    });

    expect(paths).toEqual({
      reposRoot: path.resolve('/var/autocatalyst/repos'),
      workspaceRoot: path.resolve('/var/autocatalyst/workspaces'),
      hostRepositoryPath: path.resolve('/var/autocatalyst/repos/acme/widgets'),
      runRoot: path.resolve('/var/autocatalyst/workspaces/acme/widgets/run_123'),
      repoRoot: path.resolve('/var/autocatalyst/workspaces/acme/widgets/run_123/repo'),
      scratchRoot: path.resolve('/var/autocatalyst/workspaces/acme/widgets/run_123/scratch')
    });
  });

  it('uses Project.workspaceRootOverride only for the effective workspace root', () => {
    const paths = resolveWorkspacePaths({
      project: makeProject({ workspaceRootOverride: '/mnt/project-workspaces' }),
      roots: { reposRoot: '/var/autocatalyst/repos', workspacesRoot: '/var/autocatalyst/workspaces' },
      runId: 'run_123'
    });

    expect(paths.hostRepositoryPath).toBe(path.resolve('/var/autocatalyst/repos/acme/widgets'));
    expect(paths.runRoot).toBe(path.resolve('/mnt/project-workspaces/acme/widgets/run_123'));
  });

  it('canonicalizes existing targets and accepts paths inside the explicit root', async () => {
    const existing = new Set(['/root', '/root/acme']);
    await expect(
      assertPathInsideRoot(
        { root: '/root', rootKind: 'workspace', targetPath: '/root/acme/run_123', intent: 'write' },
        {
          async pathExists(value) {
            return existing.has(value);
          },
          async realpath(value) {
            return value;
          }
        }
      )
    ).resolves.toBe(path.resolve('/root/acme/run_123'));
  });

  it('rejects out-of-root paths using the explicit root', async () => {
    await expect(
      assertPathInsideRoot(
        { root: '/root', rootKind: 'workspace', targetPath: '/other/run_123', intent: 'write' },
        {
          async pathExists(value) {
            return value === '/root' || value === '/other';
          },
          async realpath(value) {
            return value;
          }
        }
      )
    ).rejects.toMatchObject({ code: 'out_of_root_path' });
  });

  it.each([
    ['Hello World', 'feature/hello-world-Abc123'],
    ['feat/foo bar', 'feature/feat-foo-bar-Abc123'],
    ['Über Café', 'feature/uber-cafe-Abc123'],
    ['release..candidate', 'feature/release-candidate-Abc123'],
    ['topic.lock', 'feature/topic-Abc123'],
    ['ends.', 'feature/ends-Abc123'],
    ['@{bad}', 'feature/bad-Abc123'],
    ['🚀', 'feature/run-Abc123']
  ])('sanitizes topic slug %s to branch %s', (topicSlug, expectedBranch) => {
    expect(deriveRunBranchName({ runKind: 'feature', topicSlug, shortRunId: 'Abc123' })).toBe(expectedBranch);
  });

  it('keeps branch names at or below 240 characters by truncating only the topic segment', () => {
    const branch = deriveRunBranchName({ runKind: 'feature', topicSlug: 'a'.repeat(300), shortRunId: 'Abc123' });

    expect(branch).toMatch(/^feature\/a+-Abc123$/);
    expect(branch.length).toBeLessThanOrEqual(240);
  });

  it.each(['abc12', '-Abc123', 'Abc12345678901234567890123456789012', 'bad/slash'])('rejects unsafe short run id %s', (shortRunId) => {
    expect(() => deriveRunBranchName({ runKind: 'feature', topicSlug: 'topic', shortRunId })).toThrow(
      WorkspaceProvisioningError
    );
  });
});
