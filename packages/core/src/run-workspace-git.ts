import type { ImplementationAltitude } from '@autocatalyst/api-contract';

export interface RunWorkspaceCommitFilesInput {
  readonly runId: string;
  readonly workspaceRepoRoot: string;
  readonly message: string;
  readonly allowEmpty?: boolean;
}

export interface RunWorkspaceCommitResult {
  readonly commitSha: string | null;
  readonly changedFileCount: number;
}

export interface ReviewerWorkspacePolicy {
  readonly fileAccess: 'read_only';
  readonly gitAccess: 'read_only';
  readonly forbiddenGitActions: ReadonlyArray<string>;
}

export const defaultReviewerWorkspacePolicy: ReviewerWorkspacePolicy = {
  fileAccess: 'read_only',
  gitAccess: 'read_only',
  forbiddenGitActions: ['commit', 'push', 'merge', 'checkout', 'switch', 'reset', 'rebase']
} as const;

/**
 * Altitudes that can be checkpointed as host-owned refs between altitude gates.
 * The terminal `'build'` altitude is excluded — it is never checkpointed because
 * it is the final convergence target rather than an intermediate gate.
 */
export type CheckpointAltitude = Exclude<ImplementationAltitude, 'build'>;

export interface CaptureCheckpointRefInput {
  readonly runId: string;
  readonly workspaceRepoRoot: string;
  readonly altitude: CheckpointAltitude;
  readonly commitSha: string;
}

export interface CaptureCheckpointRefResult {
  readonly ref: string;
  readonly commitSha: string;
}

export interface ReadFileAtRefInput {
  readonly workspaceRepoRoot: string;
  readonly ref: string;
  readonly path: string;
}

export interface ListFilesAtRefInput {
  readonly workspaceRepoRoot: string;
  readonly ref: string;
}

export interface RunWorkspaceGitPort {
  commitFiles(input: RunWorkspaceCommitFilesInput): Promise<RunWorkspaceCommitResult>;
  captureCheckpointRef(input: CaptureCheckpointRefInput): Promise<CaptureCheckpointRefResult>;
  readFileAtRef(input: ReadFileAtRefInput): Promise<string | null>;
  listFilesAtRef(input: ListFilesAtRefInput): Promise<readonly string[]>;
  readonly reviewerPolicy: ReviewerWorkspacePolicy;
}
