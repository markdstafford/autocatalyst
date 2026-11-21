import {
  pullRequestCheckFailedErrorCode,
  pullRequestCheckFailedMessage,
  pullRequestCheckFailureReasonSchema,
  type PullRequestCheckFailureReason,
  type Run
} from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';

import type { PullRequestFact } from './run-detail-facts.js';

export function canCheckPullRequest(run: Run | undefined, fact: PullRequestFact): boolean {
  return (
    run !== undefined &&
    run.currentStep === 'pr.human_review' &&
    run.terminal === false &&
    (run.status === undefined || run.status === 'in_progress') &&
    run.waitingOn === 'human' &&
    fact.status === 'success' &&
    fact.value?.runId === run.id
  );
}

const CHECK_ERROR_MESSAGES: Record<PullRequestCheckFailureReason, string> = {
  credential_missing: "The code host credential is missing. Update it in this project's settings.",
  authentication_failed: "The code host rejected the credential. Update it in this project's settings.",
  not_found: 'The pull request was not found.',
  provider_unavailable: 'The code host could not be reached.'
};

export function pullRequestCheckErrorMessage(error: unknown): string {
  if (error instanceof ControlPlaneClientError) {
    const { code, message, details } = error.response.error;
    if (error.status === 409 && code === 'conflict') {
      return message;
    }
    if (
      error.status === 502 && code === pullRequestCheckFailedErrorCode &&
      typeof details === 'object' && details !== null && 'reason' in details
    ) {
      const reason = pullRequestCheckFailureReasonSchema.safeParse(details.reason);
      if (reason.success) {
        return CHECK_ERROR_MESSAGES[reason.data];
      }
    }
  }
  return pullRequestCheckFailedMessage;
}
