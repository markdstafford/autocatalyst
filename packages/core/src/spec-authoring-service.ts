import type { Artifact, Run, SpecAuthorResult } from '@autocatalyst/api-contract';
import type { ArtifactRepository } from './domain-repositories.js';
import { parseSpecFrontmatter, renderCommittedSpecMarkdown } from './spec-frontmatter.js';

// --- Error types ---

export type SpecAuthoringErrorCode =
  | 'spec_workflow_kind_mismatch'
  | 'spec_path_invalid'
  | 'spec_issue_mismatch'
  | 'spec_initial_status_invalid'
  | 'spec_file_write_failed'
  | 'spec_file_validation_failed'
  | 'spec_commit_failed'
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

// --- Workspace ports ---

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
  commitFiles(input: {
    readonly workspaceRepoRoot: string;
    readonly relativePaths: readonly string[];
    readonly message: string;
  }): Promise<{ readonly commitSha?: string }>;
}

// --- Service types ---

export interface SpecAuthoringServiceDependencies {
  readonly artifacts: ArtifactRepository;
  readonly filesystem: WorkspaceFileSystemPort;
  readonly git: WorkspaceGitPort;
  readonly clock?: () => string;
}

export interface CompleteSpecAuthoringInput {
  readonly run: Run;
  readonly result: SpecAuthorResult;
  readonly workspaceRepoRoot: string;
  readonly workspaceHandle: string;
}

export interface CompleteSpecAuthoringOutput {
  readonly artifact: Artifact;
  readonly committedPath: string;
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

export async function completeSpecAuthoring(
  input: CompleteSpecAuthoringInput,
  deps: SpecAuthoringServiceDependencies
): Promise<CompleteSpecAuthoringOutput> {
  assertPreSideEffectInput(input);

  const { run, result, workspaceRepoRoot, workspaceHandle } = input;
  const { relativePath, frontmatter, body, kind, slug } = result;

  // Step 1: Render spec Markdown
  const contents = renderCommittedSpecMarkdown({ frontmatter, body, requireDraftStatus: true });

  // Step 2: Write the file
  try {
    await deps.filesystem.writeFile({ workspaceRepoRoot, relativePath, contents });
  } catch (cause) {
    throw new SpecAuthoringError('spec_file_write_failed', 'Failed to write spec file.', { cause });
  }

  // Step 3: Read back and validate
  try {
    const written = await deps.filesystem.readFile({ workspaceRepoRoot, relativePath });
    parseSpecFrontmatter(written);
  } catch (cause) {
    throw new SpecAuthoringError('spec_file_validation_failed', 'Spec file validation failed after write.', { cause });
  }

  // Step 4: Commit
  const prefix = commitMessagePrefix(kind as 'feature_spec' | 'enhancement_spec');
  try {
    await deps.git.commitFiles({
      workspaceRepoRoot,
      relativePaths: [relativePath],
      message: `docs: add ${prefix} spec ${slug}`
    });
  } catch (cause) {
    throw new SpecAuthoringError('spec_commit_failed', 'Failed to commit spec file.', { cause });
  }

  // Step 5: Create or recover Artifact
  let artifact: Artifact;
  let artifactCreated: 'created' | 'recovered';
  try {
    const existing = await deps.artifacts.findByRunAndKind({ runId: run.id, kind: kind as import('@autocatalyst/api-contract').ArtifactKind });
    if (existing === null) {
      artifact = await deps.artifacts.create({
        runId: run.id,
        owner: run.owner,
        tenant: run.tenant,
        kind: kind as import('@autocatalyst/api-contract').ArtifactKind,
        canonicalRecord: 'file',
        location: relativePath,
        cachedStatus: 'draft',
        linkedIssue: run.trackedIssue,
        publicationRefs: []
      });
      artifactCreated = 'created';
    } else {
      artifact = existing;
      artifactCreated = 'recovered';
    }
  } catch (cause) {
    throw new SpecAuthoringError('spec_artifact_persistence_failed', 'Failed to persist spec artifact.', { cause });
  }

  return {
    artifact,
    committedPath: relativePath,
    artifactCreated,
    checkpointResult: {
      artifactId: artifact.id,
      committedPath: relativePath,
      workspaceHandle
    }
  };
}
