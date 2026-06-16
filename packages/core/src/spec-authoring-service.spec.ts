import { describe, expect, it, vi } from 'vitest';
import {
  SpecAuthoringError,
  completeSpecAuthoring,
  type CompleteSpecAuthoringInput,
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

function makeInput(overrides: Record<string, unknown> = {}): CompleteSpecAuthoringInput {
  return {
    run: makeRun({ trackedIssue: { provider: 'github', number: 39, url: 'https://example.test/39' } }),
    result: makeResult(),
    workspaceRepoRoot: '/tmp/repo',
    workspaceHandle: 'workspace_run_1',
    ...overrides
  } as unknown as CompleteSpecAuthoringInput;
}

describe('completeSpecAuthoring side effects', () => {
  it('writes, reads, validates, commits, and creates the Artifact in order', async () => {
    const calls: string[] = [];
    const renderedMarkdown = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nissue: 39\nspecced_by: autocatalyst\n---\n# Feature spec\n\nBody content.\n';
    const artifact = {
      id: 'artifact_1',
      runId: 'run_1',
      owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1' },
      tenant: 'tenant_1',
      kind: 'feature_spec',
      canonicalRecord: 'file',
      location: 'context-human/specs/feature-artifact-feedback-gate.md',
      cachedStatus: 'draft',
      linkedIssue: { provider: 'github', number: 39, url: 'https://example.test/39' },
      publicationRefs: [],
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z'
    };
    const deps = makeDeps({
      filesystem: {
        writeFile: vi.fn(async () => { calls.push('writeFile'); }),
        readFile: vi.fn(async () => { calls.push('readFile'); return renderedMarkdown; })
      },
      git: {
        commitFiles: vi.fn(async () => { calls.push('commitFiles'); return {}; })
      },
      artifacts: {
        create: vi.fn(async () => { calls.push('createArtifact'); return artifact; }),
        findById: vi.fn(),
        listByRun: vi.fn(),
        findByRunAndKind: vi.fn(async () => { calls.push('findByRunAndKind'); return null; }),
        updateCachedStatus: vi.fn()
      }
    });

    const output = await completeSpecAuthoring({
      run: makeRun({ trackedIssue: { provider: 'github', number: 39, url: 'https://example.test/39' } }),
      result: makeResult(),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps);

    expect(calls).toEqual(['findByRunAndKind', 'writeFile', 'readFile', 'commitFiles', 'createArtifact']);
    expect(deps.git.commitFiles).toHaveBeenCalledWith({
      workspaceRepoRoot: '/tmp/repo',
      relativePaths: ['context-human/specs/feature-artifact-feedback-gate.md'],
      message: 'docs: add feature spec artifact-feedback-gate'
    });
    expect(output.checkpointResult).toEqual({
      artifactId: output.artifact.id,
      committedPath: 'context-human/specs/feature-artifact-feedback-gate.md',
      workspaceHandle: 'workspace_run_1'
    });
    expect(output.artifactCreated).toBe('created');
    expect(output.committedPath).toBe('context-human/specs/feature-artifact-feedback-gate.md');
  });

  it('recovers existing artifact when findByRunAndKind returns one', async () => {
    const existingArtifact = {
      id: 'artifact_existing',
      runId: 'run_1',
      owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1' },
      tenant: 'tenant_1',
      kind: 'feature_spec',
      canonicalRecord: 'file',
      location: 'context-human/specs/feature-artifact-feedback-gate.md',
      cachedStatus: 'draft',
      publicationRefs: [],
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z'
    };
    const renderedMarkdown = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nspecced_by: autocatalyst\n---\n# Feature spec\n\nBody content.\n';
    const deps = makeDeps({
      filesystem: {
        writeFile: vi.fn(async () => undefined),
        readFile: vi.fn(async () => renderedMarkdown)
      },
      artifacts: {
        create: vi.fn(),
        findById: vi.fn(),
        listByRun: vi.fn(),
        findByRunAndKind: vi.fn(async () => existingArtifact),
        updateCachedStatus: vi.fn()
      }
    });

    const output = await completeSpecAuthoring(makeInput(), deps);
    expect(output.artifactCreated).toBe('recovered');
    expect(output.artifact.id).toBe('artifact_existing');
    expect(deps.artifacts.create).not.toHaveBeenCalled();
  });

  it('commit failure stops before Artifact creation', async () => {
    const renderedMarkdown = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nspecced_by: autocatalyst\n---\n# Feature spec\n\nBody content.\n';
    const deps = makeDeps({
      filesystem: {
        writeFile: vi.fn(async () => undefined),
        readFile: vi.fn(async () => renderedMarkdown)
      },
      git: { commitFiles: vi.fn(async () => { throw new Error('git failed'); }) },
      artifacts: {
        create: vi.fn(),
        findById: vi.fn(),
        listByRun: vi.fn(),
        findByRunAndKind: vi.fn(async () => null),
        updateCachedStatus: vi.fn()
      }
    });
    await expect(completeSpecAuthoring(makeInput(), deps)).rejects.toMatchObject({ code: 'spec_commit_failed' });
    expect(deps.artifacts.create).not.toHaveBeenCalled();
  });

  it('file write failure wraps error as spec_file_write_failed', async () => {
    const deps = makeDeps({
      filesystem: {
        writeFile: vi.fn(async () => { throw new Error('disk full'); }),
        readFile: vi.fn(async () => '')
      }
    });
    await expect(completeSpecAuthoring(makeInput(), deps)).rejects.toMatchObject({ code: 'spec_file_write_failed' });
    expect(deps.filesystem.readFile).not.toHaveBeenCalled();
  });

  it('file read/validation failure wraps error as spec_file_validation_failed', async () => {
    const deps = makeDeps({
      filesystem: {
        writeFile: vi.fn(async () => undefined),
        readFile: vi.fn(async () => { throw new Error('read error'); })
      }
    });
    await expect(completeSpecAuthoring(makeInput(), deps)).rejects.toMatchObject({ code: 'spec_file_validation_failed' });
    expect(deps.git.commitFiles).not.toHaveBeenCalled();
  });

  it('uses enhancement prefix for enhancement_spec kind', async () => {
    const renderedMarkdown = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nspecced_by: autocatalyst\n---\n# Enhancement spec\n\nBody content.\n';
    const artifact = {
      id: 'artifact_1', runId: 'run_1',
      owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1' },
      tenant: 'tenant_1', kind: 'enhancement_spec',
      canonicalRecord: 'file',
      location: 'context-human/specs/enhancement-artifact-feedback-gate.md',
      cachedStatus: 'draft', publicationRefs: [],
      createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z'
    };
    const deps = makeDeps({
      filesystem: {
        writeFile: vi.fn(async () => undefined),
        readFile: vi.fn(async () => renderedMarkdown)
      },
      artifacts: {
        create: vi.fn(async () => artifact),
        findById: vi.fn(), listByRun: vi.fn(),
        findByRunAndKind: vi.fn(async () => null),
        updateCachedStatus: vi.fn()
      }
    });
    await completeSpecAuthoring({
      run: makeRun({ workKind: 'enhancement' }),
      result: makeResult({ kind: 'enhancement_spec', relativePath: 'context-human/specs/enhancement-artifact-feedback-gate.md' }),
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'workspace_run_1'
    }, deps);
    expect(deps.git.commitFiles).toHaveBeenCalledWith(expect.objectContaining({
      message: 'docs: add enhancement spec artifact-feedback-gate'
    }));
  });
});

describe('completeSpecAuthoring feedback disposition', () => {
  it('marks consumed artifact feedback addressed when spec authoring incorporates revision input', async () => {
    const renderedMarkdown = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nissue: 39\nspecced_by: autocatalyst\n---\n# Feature spec\n\nBody content.\n';
    const artifact = {
      id: 'artifact_1',
      runId: 'run_1',
      owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1' },
      tenant: 'tenant_1',
      kind: 'feature_spec',
      canonicalRecord: 'file',
      location: 'context-human/specs/feature-artifact-feedback-gate.md',
      cachedStatus: 'draft',
      linkedIssue: { provider: 'github', number: 39, url: 'https://example.test/39' },
      publicationRefs: [],
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z'
    };

    // In-memory feedback store with one open artifact feedback item.
    const now = '2026-06-11T00:00:00.000Z';
    const feedbackData: import('@autocatalyst/api-contract').Feedback = {
      id: 'fb_artifact',
      runId: 'run_1',
      owner: { kind: 'human', id: 'user_1', tenantId: 'tenant_1' },
      tenant: 'tenant_1',
      target: 'artifact',
      status: 'open',
      title: 'Add failure mode',
      body: 'Add failure mode.',
      thread: [],
      createdAt: now,
      updatedAt: now
    };

    const feedbackStore = new Map<string, import('@autocatalyst/api-contract').Feedback>([
      ['fb_artifact', feedbackData]
    ]);

    const feedbackRepo: import('./feedback-lifecycle.js').FeedbackLifecycleDependencies['feedback'] = {
      create: vi.fn(),
      findById: async (id: string) => feedbackStore.get(id) ?? null,
      listByRun: async () => [...feedbackStore.values()],
      updateStatusAndAppendThread: async (input) => {
        const existing = feedbackStore.get(input.feedbackId);
        if (existing === undefined) throw new Error('not found');
        const updated = { ...existing, status: input.nextStatus, updatedAt: input.updatedAt };
        feedbackStore.set(input.feedbackId, updated as typeof existing);
        return updated as typeof existing;
      },
      appendThreadEntry: vi.fn()
    };

    const deps = makeDeps({
      filesystem: {
        writeFile: vi.fn(async () => undefined),
        readFile: vi.fn(async () => renderedMarkdown)
      },
      artifacts: {
        create: vi.fn(async () => artifact),
        findById: vi.fn(),
        listByRun: vi.fn(),
        findByRunAndKind: vi.fn(async () => null),
        updateCachedStatus: vi.fn()
      },
      feedbackLifecycle: {
        feedback: feedbackRepo,
        ids: () => 'thread_1',
        clock: () => now
      }
    });

    await completeSpecAuthoring(makeInput(), deps);

    const updated = await feedbackRepo.findById('fb_artifact');
    expect(updated?.status).toBe('addressed');
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
