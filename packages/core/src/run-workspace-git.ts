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

export interface RunWorkspaceGitPort {
  commitFiles(input: RunWorkspaceCommitFilesInput): Promise<RunWorkspaceCommitResult>;
  readonly reviewerPolicy: ReviewerWorkspacePolicy;
}
