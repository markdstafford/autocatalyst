import type { Artifact, ArtifactKind, Run, SpecAuthorResult } from '@autocatalyst/api-contract';
import type { ArtifactRepository } from './domain-repositories.js';
import { addressOpenFeedbackForRunTarget } from './feedback-lifecycle.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import { parseSpecFrontmatter, renderCommittedSpecMarkdown } from './spec-frontmatter.js';

export type SpecAuthoringErrorCode =
  | 'spec_workflow_kind_mismatch'
  | 'spec_path_invalid'
  | 'spec_issue_mismatch'
  | 'spec_initial_status_invalid'
  | 'spec_file_write_failed'
  | 'spec_file_validation_failed'
  | 'spec_commit_failed'
  | 'spec_artifact_location_mismatch'
  | 'spec_artifact_persistence_failed';

export class SpecAuthoringError extends Error {
  readonly code: SpecAuthoringErrorCode;

  constructor(code: SpecAuthoringErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'SpecAuthoringError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface WorkspaceFileSystemPort {
  writeFile(input: {
    readonly workspaceRepoRoot: string;
    readonly relativePath: string;
    readonly contents: string;
  }): Promise<void>;
  readFile(input: {
    readonly workspaceRepoRoot: string;
    readonly relativePath: string;
  }): Promise<string>;
}

export interface WorkspaceGitPort {
  readHeadFile?(input: {
    readonly workspaceRepoRoot: string;
    readonly relativePath: string;
  }): Promise<string | null>;
  commitFiles(input: {
    readonly workspaceRepoRoot: string;
    readonly relativePaths: readonly string[];
    readonly message: string;
    readonly expectedContents?: string;
  }): Promise<{ readonly commitSha?: string }>;
}

export interface SpecAuthoringServiceDependencies {
  readonly artifacts: ArtifactRepository;
  readonly filesystem: WorkspaceFileSystemPort;
  readonly git: WorkspaceGitPort;
  readonly clock?: () => string;
  readonly feedbackLifecycle?: FeedbackLifecycleDependencies;
}

export interface CompleteSpecAuthoringInput {
  readonly run: Run;
  readonly result: SpecAuthorResult;
  readonly workspaceRepoRoot: string;
  readonly workspaceHandle: string;
  readonly reviewedMarkdown?: string;
}

export interface CompleteSpecAuthoringOutput {
  readonly artifact: Artifact;
  readonly committedPath: string;
  readonly committedMarkdown?: string;
  readonly artifactCreated: 'created' | 'recovered';
  readonly checkpointResult: {
    readonly artifactId: string;
    readonly committedPath: string;
    readonly workspaceHandle: string;
  };
}

function expectedKindForRun(run: Run): 'feature_spec' | 'enhancement_spec' | null {
  if (run.workKind === 'feature') return 'feature_spec';
  if (run.workKind === 'enhancement') return 'enhancement_spec';
  return null;
}

function assertPreSideEffectInput(input: CompleteSpecAuthoringInput): void {
  const expectedKind = expectedKindForRun(input.run);
  if (expectedKind === null || input.result.kind !== expectedKind) {
    throw new SpecAuthoringError('spec_workflow_kind_mismatch', 'Spec result kind does not match run workflow.');
  }

  const expectedPrefix = input.result.kind === 'feature_spec' ? 'feature' : 'enhancement';
  const expectedPath = `context-human/specs/${expectedPrefix}-${input.result.slug}.md`;

  if (
    input.result.relativePath.startsWith('/') ||
    input.result.relativePath.includes('..') ||
    !input.result.relativePath.startsWith('context-human/specs/') ||
    input.result.relativePath !== expectedPath
  ) {
    throw new SpecAuthoringError('spec_path_invalid', 'Spec path is outside the allowed specs directory.');
  }

  if (input.result.frontmatter.status !== 'draft') {
    throw new SpecAuthoringError('spec_initial_status_invalid', 'Initial spec frontmatter status must be draft.');
  }

  const expectedIssue = input.run.trackedIssue?.number;
  if (expectedIssue !== undefined && input.result.frontmatter.issue === undefined) {
    throw new SpecAuthoringError('spec_issue_mismatch', 'Spec frontmatter must include issue when run has a tracked issue.');
  }
  if (
    expectedIssue !== undefined &&
    input.result.frontmatter.issue !== undefined &&
    input.result.frontmatter.issue !== expectedIssue
  ) {
    throw new SpecAuthoringError('spec_issue_mismatch', 'Spec issue does not match the tracked issue.');
  }
}

function commitMessagePrefix(kind: 'feature_spec' | 'enhancement_spec'): string {
  return kind === 'feature_spec' ? 'feature' : 'enhancement';
}

function assertExistingArtifactLocation(existingArtifact: Artifact, relativePath: string): void {
  if (existingArtifact.location !== relativePath) {
    throw new SpecAuthoringError(
      'spec_artifact_location_mismatch',
      'Existing spec artifact location does not match the authored spec path.'
    );
  }
}

async function writeValidateAndCommitSpec(input: {
  readonly workspaceRepoRoot: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly kind: 'feature_spec' | 'enhancement_spec';
  readonly slug: string;
  readonly operation: 'add' | 'revise';
  readonly reviewed?: boolean;
}, deps: Pick<SpecAuthoringServiceDependencies, 'filesystem' | 'git'>): Promise<void> {
  const { workspaceRepoRoot, relativePath, contents, kind, slug, operation } = input;

  try {
    await deps.filesystem.writeFile({ workspaceRepoRoot, relativePath, contents });
  } catch (cause) {
    throw new SpecAuthoringError('spec_file_write_failed', 'Failed to write spec file.', { cause });
  }

  try {
    const written = await deps.filesystem.readFile({ workspaceRepoRoot, relativePath });
    parseSpecFrontmatter(written);
    if (input.reviewed && written !== contents) throw new Error('Spec contents changed during write.');
  } catch (cause) {
    throw new SpecAuthoringError('spec_file_validation_failed', 'Spec file validation failed after write.', { cause });
  }

  const prefix = commitMessagePrefix(kind);
  try {
    await deps.git.commitFiles({
      workspaceRepoRoot,
      relativePaths: [relativePath],
      ...(input.reviewed ? { expectedContents: contents } : {}),
      message: operation === 'add'
        ? `docs: add ${prefix} spec ${slug}`
        : `docs: revise ${prefix} spec ${slug}`
    });
  } catch (cause) {
    throw new SpecAuthoringError('spec_commit_failed', 'Failed to commit spec file.', { cause });
  }
}

export async function completeSpecAuthoring(
  input: CompleteSpecAuthoringInput,
  deps: SpecAuthoringServiceDependencies
): Promise<CompleteSpecAuthoringOutput> {
  assertPreSideEffectInput(input);

  const { run, result, workspaceRepoRoot, workspaceHandle } = input;
  const { relativePath, frontmatter, body, kind, slug } = result;

  const contents = renderCommittedSpecMarkdown({ frontmatter, body, requireDraftStatus: true });

  // Check for an existing artifact first so retries can skip write/commit when content is unchanged.
  let existingArtifact: Artifact | null;
  try {
    existingArtifact = await deps.artifacts.findByRunAndKind({ runId: run.id, kind: kind as ArtifactKind });
  } catch (cause) {
    throw new SpecAuthoringError('spec_artifact_persistence_failed', 'Failed to look up existing spec artifact.', { cause });
  }

  const typedKind = kind as 'feature_spec' | 'enhancement_spec';

  if (input.reviewedMarkdown !== undefined) {
    if (input.reviewedMarkdown !== contents || deps.git.readHeadFile === undefined) {
      throw new SpecAuthoringError('spec_file_validation_failed', 'Reviewed Markdown or HEAD reader is invalid.');
    }
    if (existingArtifact !== null) assertExistingArtifactLocation(existingArtifact, relativePath);
    const target = { workspaceRepoRoot, relativePath };
    const head = await deps.git.readHeadFile(target);
    if (head !== contents) {
      await writeValidateAndCommitSpec({
        ...target, contents, kind: typedKind, slug, reviewed: true, operation: head === null ? 'add' : 'revise'
      }, deps);
    }
    // A recovered commit is authoritative; reconcile the working copy used by the spec API.
    if (await deps.filesystem.readFile(target).catch(() => null) !== contents) {
      await deps.filesystem.writeFile({ ...target, contents });
    }
    if (await deps.git.readHeadFile(target) !== contents || await deps.filesystem.readFile(target) !== contents) {
      throw new SpecAuthoringError('spec_commit_failed', 'Committed spec differs from the reviewed Markdown.');
    }
  } else if (existingArtifact === null) {
    await writeValidateAndCommitSpec({
      workspaceRepoRoot,
      relativePath,
      contents,
      kind: typedKind,
      slug,
      operation: 'add'
    }, deps);
  } else {
    assertExistingArtifactLocation(existingArtifact, relativePath);

    let existingContents: string;
    try {
      existingContents = await deps.filesystem.readFile({ workspaceRepoRoot, relativePath: existingArtifact.location });
    } catch (cause) {
      throw new SpecAuthoringError('spec_file_validation_failed', 'Failed to read existing spec file.', { cause });
    }

    if (existingContents !== contents) {
      await writeValidateAndCommitSpec({
        workspaceRepoRoot,
        relativePath,
        contents,
        kind: typedKind,
        slug,
        operation: 'revise'
      }, deps);
    }
  }

  let artifact: Artifact;
  let artifactCreated: 'created' | 'recovered';
  try {
    if (existingArtifact !== null) {
      artifact = existingArtifact;
      artifactCreated = 'recovered';
    } else {
      artifact = await deps.artifacts.create({
        runId: run.id,
        owner: run.owner,
        tenant: run.tenant,
        kind: kind as ArtifactKind,
        canonicalRecord: 'file',
        location: relativePath,
        cachedStatus: 'draft',
        linkedIssue: run.trackedIssue,
        publicationRefs: []
      });
      artifactCreated = 'created';
    }
  } catch (cause) {
    throw new SpecAuthoringError('spec_artifact_persistence_failed', 'Failed to persist spec artifact.', { cause });
  }

  if (input.reviewedMarkdown === undefined && deps.feedbackLifecycle !== undefined) {
    await addressOpenFeedbackForRunTarget({
      runId: run.id,
      target: 'artifact',
      actor: run.owner,
      body: 'Addressed during spec revision.'
    }, deps.feedbackLifecycle);
  }

  return {
    artifact,
    ...(input.reviewedMarkdown !== undefined ? { committedMarkdown: contents } : {}),
    committedPath: relativePath,
    artifactCreated,
    checkpointResult: {
      artifactId: artifact.id,
      committedPath: relativePath,
      workspaceHandle
    }
  };
}
