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

// completeSpecAuthoring will be implemented in T-006 and T-007
export async function completeSpecAuthoring(
  _input: CompleteSpecAuthoringInput,
  _deps: SpecAuthoringServiceDependencies
): Promise<CompleteSpecAuthoringOutput> {
  throw new SpecAuthoringError('spec_path_invalid', 'Not yet implemented.');
}
