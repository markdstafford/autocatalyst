import { describe, expect, it, vi } from 'vitest';
import type { Artifact, NonModelPrincipal, Run } from '@autocatalyst/api-contract';
import { renderSpecFrontmatter, parseSpecFrontmatter } from './spec-frontmatter.js';
import type { SpecFreezeDependencies, SpecFreezeInput } from './spec-freeze.js';
import { freezeRunSpecForPullRequest, SpecFreezeError } from './spec-freeze.js';

const timestamp = '2026-06-16T12:34:56.000Z';
const owner: NonModelPrincipal = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' };

const approvedFrontmatter = {
  created: '2026-06-10',
  last_updated: '2026-06-11',
  status: 'approved' as const,
  issue: 42,
  specced_by: 'autocatalyst'
};

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'pr.finalize',
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
    location: 'context-human/specs/feature-pull-request-merge.md',
    cachedStatus: 'approved',
    publicationRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

const validFileContents = `${renderSpecFrontmatter(approvedFrontmatter)}# Spec body\n\nDetails go here.\n`;

interface MakeDepsOptions {
  fileContents?: string;
  artifact?: Artifact | null;
  artifactFindError?: Error;
  readFileError?: Error;
  writeFileError?: Error;
  commitFilesError?: Error;
  commitSha?: string | null;
  updateCachedStatusError?: Error;
  clock?: () => string;
}

interface DepsHarness {
  deps: SpecFreezeDependencies;
  writtenContents: string[];
  commitCalls: Array<{ runId: string; workspaceRepoRoot: string; message: string }>;
  updatedStatuses: Array<{ artifactId: string; cachedStatus: string; updatedAt: string }>;
}

function makeDeps(options: MakeDepsOptions = {}): DepsHarness {
  const artifact = options.artifact === undefined ? makeArtifact() : options.artifact;
  const fileContents = options.fileContents ?? validFileContents;
  const writtenContents: string[] = [];
  const commitCalls: Array<{ runId: string; workspaceRepoRoot: string; message: string }> = [];
  const updatedStatuses: Array<{ artifactId: string; cachedStatus: string; updatedAt: string }> = [];

  const deps: SpecFreezeDependencies = {
    artifacts: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn(),
      findByRunAndKind: vi.fn().mockImplementation(async () => {
        if (options.artifactFindError !== undefined) throw options.artifactFindError;
        return artifact;
      }),
      updateCachedStatus: vi.fn().mockImplementation(async (input: { artifactId: string; cachedStatus: string; updatedAt: string }) => {
        if (options.updateCachedStatusError !== undefined) throw options.updateCachedStatusError;
        updatedStatuses.push(input);
        return { ...(artifact ?? makeArtifact()), cachedStatus: input.cachedStatus };
      })
    } as unknown as SpecFreezeDependencies['artifacts'],
    filesystem: {
      writeFile: vi.fn().mockImplementation(async ({ contents }: { workspaceRepoRoot: string; relativePath: string; contents: string }) => {
        if (options.writeFileError !== undefined) throw options.writeFileError;
        writtenContents.push(contents);
      }),
      readFile: vi.fn().mockImplementation(async () => {
        if (options.readFileError !== undefined) throw options.readFileError;
        return fileContents;
      })
    } as unknown as SpecFreezeDependencies['filesystem'],
    git: {
      commitFiles: vi.fn().mockImplementation(async (input: { runId: string; workspaceRepoRoot: string; message: string }) => {
        if (options.commitFilesError !== undefined) throw options.commitFilesError;
        commitCalls.push({ runId: input.runId, workspaceRepoRoot: input.workspaceRepoRoot, message: input.message });
        const commitSha = options.commitSha === undefined ? 'sha_abc' : options.commitSha;
        return { commitSha, changedFileCount: 1, changedFilePaths: [] };
      }),
      captureCheckpointRef: vi.fn(),
      readFileAtRef: vi.fn(),
      listFilesAtRef: vi.fn(),
      reviewerPolicy: { fileAccess: 'read_only', gitAccess: 'read_only', forbiddenGitActions: [] }
    } as unknown as SpecFreezeDependencies['git'],
    clock: options.clock ?? (() => timestamp)
  };

  return { deps, writtenContents, commitCalls, updatedStatuses };
}

function makeInput(overrides: Partial<SpecFreezeInput> = {}): SpecFreezeInput {
  return {
    run: makeRun(),
    workspaceRepoRoot: '/tmp/repo',
    ...overrides
  };
}

describe('freezeRunSpecForPullRequest', () => {
  it('updates frontmatter, commits the file, updates artifact cached status, and returns a result', async () => {
    const harness = makeDeps();
    const result = await freezeRunSpecForPullRequest(makeInput(), harness.deps);

    // Wrote shipped frontmatter (status: complete) with today's date.
    expect(harness.writtenContents).toHaveLength(1);
    const writtenFrontmatter = parseSpecFrontmatter(harness.writtenContents[0]!);
    expect(writtenFrontmatter.status).toBe('complete');
    expect(writtenFrontmatter.last_updated).toBe('2026-06-16');
    // Preserved other fields.
    expect(writtenFrontmatter.issue).toBe(42);
    expect(writtenFrontmatter.specced_by).toBe('autocatalyst');

    // Committed exactly one well-formed commit.
    expect(harness.commitCalls).toHaveLength(1);
    expect(harness.commitCalls[0]).toEqual({
      runId: 'run_1',
      workspaceRepoRoot: '/tmp/repo',
      message: 'docs: freeze shipped spec pull-request-merge'
    });

    // Updated artifact cached status to published.
    expect(harness.updatedStatuses).toEqual([
      { artifactId: 'art_1', cachedStatus: 'published', updatedAt: timestamp }
    ]);

    // Result fields are populated.
    expect(result.artifactPath).toBe('context-human/specs/feature-pull-request-merge.md');
    expect(result.shippedAt).toBe(timestamp);
    expect(result.commitSha).toBe('sha_abc');
  });

  it('returns a null commitSha when the git port reports no commit was created', async () => {
    const harness = makeDeps({ commitSha: null });
    const result = await freezeRunSpecForPullRequest(makeInput(), harness.deps);
    expect(result.commitSha).toBeNull();
  });

  it('supports enhancement specs by deriving the correct artifact kind and commit slug', async () => {
    const artifact = makeArtifact({
      kind: 'enhancement_spec',
      location: 'context-human/specs/enhancement-fast-merge.md'
    });
    const enhancementFile = `${renderSpecFrontmatter(approvedFrontmatter)}# Enhancement body\n`;
    const harness = makeDeps({ artifact, fileContents: enhancementFile });

    const result = await freezeRunSpecForPullRequest(
      makeInput({ run: makeRun({ workKind: 'enhancement' }) }),
      harness.deps
    );

    expect(harness.commitCalls[0]?.message).toBe('docs: freeze shipped spec fast-merge');
    expect(result.artifactPath).toBe('context-human/specs/enhancement-fast-merge.md');
    // findByRunAndKind was queried with enhancement_spec.
    const findByRunAndKind = harness.deps.artifacts.findByRunAndKind as ReturnType<typeof vi.fn>;
    expect(findByRunAndKind.mock.calls[0]?.[0]).toEqual({ runId: 'run_1', kind: 'enhancement_spec' });
  });

  it('throws SpecFreezeError when the run workKind is not spec-bearing', async () => {
    const harness = makeDeps();
    await expect(
      freezeRunSpecForPullRequest(
        makeInput({ run: makeRun({ workKind: 'bug' }) }),
        harness.deps
      )
    ).rejects.toBeInstanceOf(SpecFreezeError);
  });

  it('throws SpecFreezeError when the spec artifact is missing', async () => {
    const harness = makeDeps({ artifact: null });
    await expect(freezeRunSpecForPullRequest(makeInput(), harness.deps)).rejects.toMatchObject({
      name: 'SpecFreezeError',
      code: 'spec_freeze_failed'
    });
  });

  it('wraps filesystem read errors as SpecFreezeError without leaking raw cause text', async () => {
    const cause = new Error('ENOENT /tmp/repo/context-human/specs/feature-pull-request-merge.md');
    const harness = makeDeps({ readFileError: cause });
    try {
      await freezeRunSpecForPullRequest(makeInput(), harness.deps);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecFreezeError);
      const err = error as SpecFreezeError;
      expect(err.code).toBe('spec_freeze_failed');
      // Public message must not echo the raw underlying error text.
      expect(err.message).not.toContain('ENOENT');
      expect(err.cause).toBe(cause);
    }
  });

  it('wraps filesystem write errors as SpecFreezeError', async () => {
    const harness = makeDeps({ writeFileError: new Error('EACCES write denied') });
    await expect(freezeRunSpecForPullRequest(makeInput(), harness.deps)).rejects.toMatchObject({
      name: 'SpecFreezeError',
      code: 'spec_freeze_failed'
    });
  });

  it('wraps git commit errors as SpecFreezeError and never reaches artifact status update', async () => {
    const harness = makeDeps({ commitFilesError: new Error('git fatal: detached HEAD') });
    try {
      await freezeRunSpecForPullRequest(makeInput(), harness.deps);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecFreezeError);
      expect((error as SpecFreezeError).code).toBe('spec_freeze_failed');
    }
    expect(harness.updatedStatuses).toHaveLength(0);
  });

  it('wraps artifact cached-status update errors as SpecFreezeError', async () => {
    const harness = makeDeps({ updateCachedStatusError: new Error('db down') });
    await expect(freezeRunSpecForPullRequest(makeInput(), harness.deps)).rejects.toMatchObject({
      name: 'SpecFreezeError',
      code: 'spec_freeze_failed'
    });
  });
});
