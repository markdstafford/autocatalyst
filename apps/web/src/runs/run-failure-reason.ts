export function formatRunFailureReason(reason: string | undefined): string | undefined {
  return reason === 'pull_request_closed_without_merge'
    ? 'The pull request was closed without merging.'
    : reason;
}
