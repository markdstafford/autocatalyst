import type { CredentialReference, TrackedIssue } from '@autocatalyst/api-contract';

export type IssueTrackerErrorCode =
  | 'tracker_not_configured'
  | 'unsupported_tracker_provider'
  | 'tracker_target_invalid'
  | 'tracker_credential_missing'
  | 'tracker_auth_failed'
  | 'issue_not_found'
  | 'tracker_provider_unavailable'
  | 'tracker_response_invalid';

export interface IssueTrackerTarget {
  readonly provider: string;
  readonly repository?: {
    readonly owner: string;
    readonly name: string;
  };
  readonly projectKey?: string;
  readonly url?: string;
  readonly credentialRef?: CredentialReference;
}

export interface ReadTrackedIssueInput {
  readonly target: IssueTrackerTarget;
  readonly issueNumber: number;
}

export interface IssueTrackerPort {
  read(input: ReadTrackedIssueInput): Promise<TrackedIssue>;
}

export interface IssueTrackerErrorOptions {
  readonly safeDetails?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class IssueTrackerError extends Error {
  readonly code: IssueTrackerErrorCode;
  readonly safeDetails?: Record<string, unknown>;

  constructor(code: IssueTrackerErrorCode, message: string, options?: IssueTrackerErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'IssueTrackerError';
    this.code = code;
    if (options?.safeDetails !== undefined) {
      this.safeDetails = options.safeDetails;
    }
  }
}
