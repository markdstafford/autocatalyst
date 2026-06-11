import { describe, expect, it, vi } from 'vitest';
import {
  SpecAuthoringError,
  completeSpecAuthoring,
  type CompleteSpecAuthoringInput,
  type SpecAuthoringServiceDependencies,
  type WorkspaceFileSystemPort,
  type WorkspaceGitPort
} from './spec-authoring-service.js';

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run_1',
    workKind: 'feature',
    owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1' },
    tenant: 'tenant_1',
    currentStep: 'spec.author',
    terminal: false,
    trackedIssue: undefined,
    ...overrides
  } as unknown as import('@autocatalyst/api-contract').Run;
}

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'feature_spec',
    slug: 'artifact-feedback-gate',
    relativePath: 'context-human/specs/feature-artifact-feedback-gate.md',
    frontmatter: {
      created: '2026-06-11',
      last_updated: '2026-06-11',
      status: 'draft',
      issue: 39,
      specced_by: 'autocatalyst'
    },
    body: '# Feature spec\n\nBody content.',
    ...overrides
  } as unknown as import('@autocatalyst/api-contract').SpecAuthorResult;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    artifacts: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn(),
      findByRunAndKind: vi.fn(async () => null),
      updateCachedStatus: vi.fn()
    },
    filesystem: {
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => '')
    },
    git: {
      commitFiles: vi.fn(async () => ({}))
    },
    ...overrides
  } as unknown as import('./spec-authoring-service.js').SpecAuthoringServiceDependencies;
}

describe('SpecAuthoringError', () => {
  it('creates error with code and message', () => {
    const error = new SpecAuthoringError('spec_path_invalid', 'Path is not safe.');
    expect(error.code).toBe('spec_path_invalid');
    expect(error.message).toBe('Path is not safe.');
    expect(error.name).toBe('SpecAuthoringError');
    expect(error).toBeInstanceOf(Error);
  });

  it('creates error with cause', () => {
    const cause = new Error('underlying');
    const error = new SpecAuthoringError('spec_commit_failed', 'Commit failed.', { cause });
    expect(error.cause).toBe(cause);
  });

  it('does not include raw cause message in its own message', () => {
    const cause = new Error('sk-SECRET raw message');
    const error = new SpecAuthoringError('spec_file_write_failed', 'Failed to write spec file.', { cause });
    expect(error.message).not.toContain('sk-SECRET');
    expect(error.message).toBe('Failed to write spec file.');
  });
});

describe('WorkspaceFileSystemPort and WorkspaceGitPort types', () => {
  it('WorkspaceFileSystemPort is structurally compatible', () => {
    const port: WorkspaceFileSystemPort = {
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => '')
    };
    expect(typeof port.writeFile).toBe('function');
    expect(typeof port.readFile).toBe('function');
  });

  it('WorkspaceGitPort has commitFiles only (no branch operations)', () => {
    const port: WorkspaceGitPort = {
      commitFiles: vi.fn(async () => ({}))
    };
    expect(typeof port.commitFiles).toBe('function');
    // Type-level: WorkspaceGitPort should NOT have createBranch, push, merge, etc.
    // We verify this at runtime by checking it's a plain object
    expect(Object.keys(port)).toEqual(['commitFiles']);
  });
});

describe('completeSpecAuthoring validation', () => {
  it('rejects feature run with enhancement_spec result', async () => {
    const deps = makeDeps();
    await expect(completeSpecAuthoring({
      run: makeRun({ workKind: 'feature' }),
      result: makeResult({ kind: 'enhancement_spec', relativePath: 'context-human/specs/enhancement-artifact-feedback-gate.md' }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps)).rejects.toMatchObject({ code: 'spec_workflow_kind_mismatch' });
    expect(deps.filesystem.writeFile).not.toHaveBeenCalled();
    expect(deps.git.commitFiles).not.toHaveBeenCalled();
    expect(deps.artifacts.create).not.toHaveBeenCalled();
  });

  it('rejects enhancement run with feature_spec result', async () => {
    const deps = makeDeps();
    await expect(completeSpecAuthoring({
      run: makeRun({ workKind: 'enhancement' }),
      result: makeResult({ kind: 'feature_spec' }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps)).rejects.toMatchObject({ code: 'spec_workflow_kind_mismatch' });
    expect(deps.filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('rejects absolute path before side effects', async () => {
    const deps = makeDeps();
    await expect(completeSpecAuthoring({
      run: makeRun(),
      result: makeResult({ relativePath: '/tmp/context-human/specs/feature-artifact-feedback-gate.md' }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps)).rejects.toMatchObject({ code: 'spec_path_invalid' });
    expect(deps.filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('rejects path traversal before side effects', async () => {
    const deps = makeDeps();
    await expect(completeSpecAuthoring({
      run: makeRun(),
      result: makeResult({ relativePath: '../context-human/specs/feature-artifact-feedback-gate.md' }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps)).rejects.toMatchObject({ code: 'spec_path_invalid' });
    expect(deps.filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('rejects path outside context-human/specs/', async () => {
    const deps = makeDeps();
    await expect(completeSpecAuthoring({
      run: makeRun(),
      result: makeResult({ kind: 'feature_spec', slug: 'test', relativePath: 'context-human/other/feature-test.md' }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps)).rejects.toMatchObject({ code: 'spec_path_invalid' });
  });

  it('rejects issue mismatch before side effects', async () => {
    const deps = makeDeps();
    await expect(completeSpecAuthoring({
      run: makeRun({ trackedIssue: { provider: 'github', number: 39, url: 'https://example.test/39' } }),
      result: makeResult({ frontmatter: { created: '2026-06-11', last_updated: '2026-06-11', status: 'draft', issue: 40, specced_by: 'autocatalyst' } }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps)).rejects.toMatchObject({ code: 'spec_issue_mismatch' });
    expect(deps.filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('rejects non-draft initial status before side effects', async () => {
    const deps = makeDeps();
    await expect(completeSpecAuthoring({
      run: makeRun(),
      result: makeResult({ frontmatter: { created: '2026-06-11', last_updated: '2026-06-11', status: 'approved', specced_by: 'autocatalyst' } }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps)).rejects.toMatchObject({ code: 'spec_initial_status_invalid' });
    expect(deps.filesystem.writeFile).not.toHaveBeenCalled();
  });
});

describe('CompleteSpecAuthoringInput type', () => {
  it('accepts required fields', () => {
    const input: CompleteSpecAuthoringInput = {
      run: { id: 'run_1', workKind: 'feature' } as never,
      result: {} as never,
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    };
    expect(input.workspaceRepoRoot).toBe('/tmp/repo');
    expect(input.workspaceHandle).toBe('workspace_run_1');
  });
});
