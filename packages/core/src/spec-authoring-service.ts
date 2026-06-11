import type { Artifact, Run, SpecAuthorResult } from '@autocatalyst/api-contract';
import type { ArtifactRepository } from './domain-repositories.js';

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

// completeSpecAuthoring: validation implemented in T-006, side effects will be implemented in T-007
export async function completeSpecAuthoring(
  input: CompleteSpecAuthoringInput,
  _deps: SpecAuthoringServiceDependencies
): Promise<CompleteSpecAuthoringOutput> {
  assertPreSideEffectInput(input);
  // Side effects will be implemented in T-007
  throw new SpecAuthoringError('spec_file_write_failed', 'Side effects not yet implemented.');
}
