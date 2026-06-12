import { describe, expect, it, vi } from 'vitest';
import type { Artifact, NonModelPrincipal, Run } from '@autocatalyst/api-contract';
import { renderSpecFrontmatter } from './spec-frontmatter.js';
import type { SpecApprovalFinalizerDependencies, FinalizeSpecApprovalInput } from './spec-approval-finalizer.js';
import { finalizeSpecApproval, SpecApprovalError } from './spec-approval-finalizer.js';

const timestamp = '2026-06-11T00:00:00.000Z';
const owner: NonModelPrincipal = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' };

const frontmatter = {
  created: '2026-06-11',
  last_updated: '2026-06-11',
  status: 'draft' as const,
  issue: 39,
  specced_by: 'autocatalyst'
};

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'spec.human_review',
    terminal: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art_1',
    runId: 'run_1',
    owner,
    tenant: 'tenant_1',
    kind: 'feature_spec',
    canonicalRecord: 'file',
    location: 'context-human/specs/feature-artifact-feedback-gate.md',
    cachedStatus: 'draft',
    publicationRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function principal(id: string): NonModelPrincipal {
  return { id, kind: 'human', tenantId: 'tenant_1', displayName: id };
}

const validFileContents = `${renderSpecFrontmatter(frontmatter)}# Body\n`;

function makeFinalizerDeps(overrides: {
  fileContents?: string;
  filesystem?: Partial<SpecApprovalFinalizerDependencies['filesystem']>;
  git?: Partial<SpecApprovalFinalizerDependencies['git']>;
  artifacts?: Partial<SpecApprovalFinalizerDependencies['artifacts']>;
  clock?: () => string;
} = {}): SpecApprovalFinalizerDependencies {
  const artifact = makeArtifact();
  const fileContents = overrides.fileContents ?? validFileContents;
  const writtenContents: string[] = [];

  return {
    artifacts: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn(),
      findByRunAndKind: vi.fn().mockResolvedValue(artifact),
      updateCachedStatus: vi.fn().mockResolvedValue({ ...artifact, cachedStatus: 'approved' }),
      ...overrides.artifacts
    } as unknown as SpecApprovalFinalizerDependencies['artifacts'],
    filesystem: {
      writeFile: vi.fn().mockImplementation(async ({ contents }: { workspaceRepoRoot: string; relativePath: string; contents: string }) => {
        writtenContents.push(contents);
      }),
      readFile: vi.fn().mockImplementation(async () => {
        // Return the most recently written content or the original
        return writtenContents.length > 0 ? (writtenContents[writtenContents.length - 1] ?? fileContents) : fileContents;
      }),
      ...overrides.filesystem
    } as unknown as SpecApprovalFinalizerDependencies['filesystem'],
    git: {
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123' }),
      ...overrides.git
    } as unknown as SpecApprovalFinalizerDependencies['git'],
    clock: overrides.clock ?? (() => timestamp)
  };
}

function makeFinalizeInput(overrides: Partial<FinalizeSpecApprovalInput> = {}): FinalizeSpecApprovalInput {
  return {
    run: makeRun(),
    approver: principal('phoebe'),
    workspaceRepoRoot: '/tmp/repo',
    workspaceHandle: 'workspace_run_1',
    ...overrides
  };
}

describe('finalizeSpecApproval', () => {
  it('updates only frontmatter status and last_updated before Artifact cached status', async () => {
    const deps = makeFinalizerDeps({ fileContents: validFileContents });
    await finalizeSpecApproval(makeFinalizeInput(), deps);

    expect(deps.filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: 'context-human/specs/feature-artifact-feedback-gate.md',
      contents: expect.stringContaining('status: approved')
    }));
    // Body preserved
    const writeCall = (deps.filesystem.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { contents: string };
    expect(writeCall.contents).toContain('# Body\n');
    // updateCachedStatus called after write+commit
    expect(deps.artifacts.updateCachedStatus).toHaveBeenCalledWith(expect.objectContaining({ cachedStatus: 'approved' }));
  });

  it('looks up artifact by run and expected kind (feature_spec for feature runs)', async () => {
    const deps = makeFinalizerDeps();
    await finalizeSpecApproval(makeFinalizeInput({ run: makeRun({ workKind: 'feature' }) }), deps);
    expect(deps.artifacts.findByRunAndKind).toHaveBeenCalledWith({ runId: 'run_1', kind: 'feature_spec' });
  });

  it('looks up artifact by run and expected kind (enhancement_spec for enhancement runs)', async () => {
    const deps = makeFinalizerDeps({
      artifacts: {
        findByRunAndKind: vi.fn().mockResolvedValue(makeArtifact({ kind: 'enhancement_spec' }))
      }
    });
    await finalizeSpecApproval(makeFinalizeInput({ run: makeRun({ workKind: 'enhancement' }) }), deps);
    expect(deps.artifacts.findByRunAndKind).toHaveBeenCalledWith({ runId: 'run_1', kind: 'enhancement_spec' });
  });

  it('throws spec_artifact_missing when artifact not found', async () => {
    const deps = makeFinalizerDeps({
      artifacts: { findByRunAndKind: vi.fn().mockResolvedValue(null) }
    });
    await expect(finalizeSpecApproval(makeFinalizeInput(), deps)).rejects.toMatchObject({
      code: 'spec_artifact_missing'
    });
  });

  it('throws spec_approval_file_update_failed when writeFile fails', async () => {
    const deps = makeFinalizerDeps({
      filesystem: {
        writeFile: vi.fn().mockRejectedValue(new Error('disk full')),
        readFile: vi.fn().mockResolvedValue(validFileContents)
      }
    });
    await expect(finalizeSpecApproval(makeFinalizeInput(), deps)).rejects.toMatchObject({
      code: 'spec_approval_file_update_failed'
    });
  });

  it('leaves the run unadvanced when commit fails — does not call updateCachedStatus', async () => {
    const deps = makeFinalizerDeps({
      git: { commitFiles: vi.fn(async () => { throw new Error('git failed'); }) }
    });
    await expect(finalizeSpecApproval(makeFinalizeInput(), deps)).rejects.toMatchObject({
      code: 'spec_approval_commit_failed'
    });
    expect(deps.artifacts.updateCachedStatus).not.toHaveBeenCalled();
  });

  it('commits only the spec file path', async () => {
    const deps = makeFinalizerDeps();
    await finalizeSpecApproval(makeFinalizeInput(), deps);
    expect(deps.git.commitFiles).toHaveBeenCalledWith(expect.objectContaining({
      relativePaths: ['context-human/specs/feature-artifact-feedback-gate.md'],
      message: 'docs: approve spec artifact-feedback-gate'
    }));
  });

  it('uses workspaceRepoRoot in all filesystem and git calls', async () => {
    const deps = makeFinalizerDeps();
    await finalizeSpecApproval(makeFinalizeInput({ workspaceRepoRoot: '/custom/root' }), deps);
    expect(deps.filesystem.readFile).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRepoRoot: '/custom/root'
    }));
    expect(deps.filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRepoRoot: '/custom/root'
    }));
    expect(deps.git.commitFiles).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRepoRoot: '/custom/root'
    }));
  });

  it('calls updateCachedStatus with artifactId and approved status', async () => {
    const deps = makeFinalizerDeps();
    await finalizeSpecApproval(makeFinalizeInput(), deps);
    expect(deps.artifacts.updateCachedStatus).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'art_1',
      cachedStatus: 'approved'
    }));
  });

  it('throws spec_approval_artifact_update_failed when updateCachedStatus fails', async () => {
    const deps = makeFinalizerDeps({
      artifacts: {
        findByRunAndKind: vi.fn().mockResolvedValue(makeArtifact()),
        updateCachedStatus: vi.fn().mockRejectedValue(new Error('db gone'))
      }
    });
    await expect(finalizeSpecApproval(makeFinalizeInput(), deps)).rejects.toMatchObject({
      code: 'spec_approval_artifact_update_failed'
    });
  });

  it('throws spec_approval_validation_failed when readFile after write returns invalid content', async () => {
    const deps = makeFinalizerDeps({
      filesystem: {
        writeFile: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn()
          .mockResolvedValueOnce(validFileContents) // first read for parsing
          .mockResolvedValueOnce('not valid frontmatter at all') // second read for validation
      }
    });
    await expect(finalizeSpecApproval(makeFinalizeInput(), deps)).rejects.toMatchObject({
      code: 'spec_approval_validation_failed'
    });
  });

  it('does not include workspaceRepoRoot in error messages', async () => {
    const deps = makeFinalizerDeps({
      filesystem: {
        writeFile: vi.fn().mockRejectedValue(new Error('disk full')),
        readFile: vi.fn().mockResolvedValue(validFileContents)
      }
    });
    try {
      await finalizeSpecApproval(makeFinalizeInput({ workspaceRepoRoot: '/secret/path' }), deps);
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('/secret/path');
    }
  });

  it('preserves issue and specced_by from original frontmatter', async () => {
    const deps = makeFinalizerDeps({ fileContents: validFileContents });
    await finalizeSpecApproval(makeFinalizeInput(), deps);
    const writeCall = (deps.filesystem.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { contents: string };
    expect(writeCall.contents).toContain('issue: 39');
    expect(writeCall.contents).toContain('specced_by: autocatalyst');
  });

  it('uses clock for last_updated date', async () => {
    const clock = () => '2026-06-15T12:00:00.000Z';
    const deps = makeFinalizerDeps({ clock });
    await finalizeSpecApproval(makeFinalizeInput(), deps);
    const writeCall = (deps.filesystem.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { contents: string };
    expect(writeCall.contents).toContain('last_updated: 2026-06-15');
  });

  it('is a SpecApprovalError instance', async () => {
    const deps = makeFinalizerDeps({
      artifacts: { findByRunAndKind: vi.fn().mockResolvedValue(null) }
    });
    await expect(finalizeSpecApproval(makeFinalizeInput(), deps)).rejects.toBeInstanceOf(SpecApprovalError);
  });
});
