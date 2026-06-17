import type { PullRequestState } from '@autocatalyst/api-contract';

export type CodeHostErrorCode =
  | 'unsupported_provider'
  | 'duplicate_provider'
  | 'ambiguous_branch_match'
  | 'provider_unavailable'
  | 'authentication_failed'
  | 'resource_not_found'
  | 'invalid_pull_request_content'
  | 'unsupported_merge_strategy'
  | 'unsafe_provider_error';

export interface CodeHostTarget {
  readonly provider: string;
  readonly owner: string;
  readonly name: string;
}

export interface CodeHostCredential {
  readonly token: string;
  readonly secretRef?: string;
}

export interface PullRequestContent {
  readonly title: string;
  readonly body: string;
}

export interface CodeHostPullRequestFacts {
  readonly provider: string;
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
  readonly branch: string;
}

export interface CreateCodeHostPullRequestInput {
  readonly target: CodeHostTarget;
  readonly workspaceRepoRoot: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly content: PullRequestContent;
  readonly credential: CodeHostCredential;
}

export interface ReadCodeHostPullRequestInput {
  readonly target: CodeHostTarget;
  readonly number: number;
  readonly credential: CodeHostCredential;
}

export interface FindCodeHostPullRequestByBranchInput {
  readonly target: CodeHostTarget;
  readonly headBranch: string;
  readonly baseBranch?: string;
  readonly credential: CodeHostCredential;
}

export interface UpdateCodeHostPullRequestInput {
  readonly target: CodeHostTarget;
  readonly number: number;
  readonly content: PullRequestContent;
  readonly credential: CodeHostCredential;
}

export interface MergeStrategy {
  readonly method: 'squash';
  readonly deleteBranch: boolean;
}

export interface MergeCodeHostPullRequestInput {
  readonly target: CodeHostTarget;
  readonly number: number;
  readonly credential: CodeHostCredential;
  readonly strategy?: MergeStrategy;
}

export interface CodeHostPort {
  create(input: CreateCodeHostPullRequestInput): Promise<CodeHostPullRequestFacts>;
  read(input: ReadCodeHostPullRequestInput): Promise<CodeHostPullRequestFacts>;
  findByBranch(input: FindCodeHostPullRequestByBranchInput): Promise<CodeHostPullRequestFacts | null>;
  update(input: UpdateCodeHostPullRequestInput): Promise<void>;
  merge(input: MergeCodeHostPullRequestInput): Promise<CodeHostPullRequestFacts>;
}

const safeDetailKeys = new Set(['provider', 'repository', 'owner', 'name', 'branch', 'headBranch', 'baseBranch', 'number', 'state', 'url']);

export function sanitizeCodeHostDetails(details: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([key]) => safeDetailKeys.has(key)));
}

export class CodeHostError extends Error {
  readonly code: CodeHostErrorCode;
  readonly safeDetails: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: CodeHostErrorCode, message: string, safeDetails: Record<string, unknown> = {}, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'CodeHostError';
    this.code = code;
    this.safeDetails = sanitizeCodeHostDetails(safeDetails);
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isCodeHostError(error: unknown): error is CodeHostError {
  return error instanceof CodeHostError;
}

export function repositorySlug(target: CodeHostTarget): string {
  return `${target.owner}/${target.name}`;
}

export function defaultMergeStrategy(): MergeStrategy {
  return { method: 'squash', deleteBranch: true };
}
