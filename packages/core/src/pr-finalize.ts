import type { CreateFeedbackInput, JsonValue, NonModelPrincipal, PullRequestFinalizeFinding, PullRequestFinalizeResult } from '@autocatalyst/api-contract';
import { prFinalizeResultSchema } from '@autocatalyst/api-contract';

import type { CumulativeImplementationSummary } from './implementation-summary.js';

export type { PullRequestFinalizeFinding, PullRequestFinalizeResult };

export interface PullRequestFinalizePromptInput {
  readonly runId: string;
  readonly workKind: string;
  readonly branch: string;
  readonly workspacePath: string;
  readonly specArtifactPath?: string | null;
  readonly cumulativeSummary: CumulativeImplementationSummary;
}

export function buildPullRequestFinalizePrompt(input: PullRequestFinalizePromptInput): string {
  const summarySection = [
    `Round count: ${input.cumulativeSummary.sourceRoundCount}`,
    '',
    input.cumulativeSummary.cumulativeSummary,
    '',
    input.cumulativeSummary.changedFiles.length > 0
      ? `Changed files:\n${input.cumulativeSummary.changedFiles.map((f) => `- ${f}`).join('\n')}`
      : '',
    input.cumulativeSummary.validationSummary.length > 0
      ? `Validation:\n${input.cumulativeSummary.validationSummary.map((v) => `- ${v}`).join('\n')}`
      : '',
    input.cumulativeSummary.followUps.length > 0
      ? `Follow-ups:\n${input.cumulativeSummary.followUps.map((f) => `- ${f}`).join('\n')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n');

  const specLine = input.specArtifactPath ? `- Spec artifact: ${input.specArtifactPath}\n` : '';

  return `# Pull Request Final Review

## Run information
- Run ID: ${input.runId}
- Work kind: ${input.workKind}
- Branch: ${input.branch}
- Workspace: ${input.workspacePath}
${specLine}
## Cumulative implementation summary
${summarySection}

## Your task
You are a final pull-request readiness and security reviewer. Review the final branch state for:
1. Obvious credential leaks or secrets committed to the branch
2. Unsafe generated files (compiled secrets, private keys, sensitive config)
3. Missing final validation evidence
4. Misleading or inaccurate implementation summary
5. Changes that should not be exposed as a pull request

**IMPORTANT CONSTRAINTS:**
- You are in read-only mode. Do not write files, do not commit, do not push, do not merge.
- Do not checkout, switch, reset, or rebase branches.
- Do not make any git changes whatsoever.
- Do not call the code host (no gh commands, no GitHub API calls).
- Only inspect and report.

## Output format
Return a JSON object with this exact structure.

For a clean result (no blockers):
\`\`\`json
{
  "directive": "advance",
  "reconciledSummary": "Full reconciled summary of the change for the PR body",
  "titleSubject": "Short subject line describing the change",
  "validationSummary": ["Validation step 1", "Validation step 2"],
  "findings": []
}
\`\`\`

For a revise result (blockers found):
\`\`\`json
{
  "directive": "revise",
  "findings": [
    {
      "severity": "blocker",
      "summary": "Description of what must be fixed",
      "target": "implementation"
    }
  ]
}
\`\`\`

Only return "revise" if there is a material or user-visible blocker. Warnings and info findings should still allow "advance".`;
}

/**
 * @deprecated Use validatePullRequestFinalizeResult for AI-step candidates so
 * normalization and correction run before workflow logic. This strict parser is
 * for direct-call or already-tolerated compatibility paths only.
 */
export function parsePullRequestFinalizeResult(value: unknown): PullRequestFinalizeResult {
  const result = prFinalizeResultSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid pr.finalize result: ${result.error.message}`);
  }
  return result.data;
}

export interface BuildPullRequestFinalizeCheckpointOptions {
  readonly clock?: () => string;
}

export function buildPullRequestFinalizeCheckpoint(
  result: PullRequestFinalizeResult,
  options: BuildPullRequestFinalizeCheckpointOptions = {}
): JsonValue {
  const completedAt = options.clock?.() ?? new Date().toISOString();
  return {
    kind: 'pull_request_finalize',
    directive: result.directive,
    reconciledSummary: result.reconciledSummary ?? null,
    titleSubject: result.titleSubject ?? null,
    validationSummary: result.validationSummary ?? [],
    findings: result.findings.map((finding) => ({
      severity: finding.severity,
      summary: finding.summary,
      target: finding.target ?? null
    })),
    completedAt
  } as unknown as JsonValue;
}

export interface FeedbackInputsFromPullRequestFinalizeFindingsOptions {
  readonly clock?: () => string;
  readonly ids?: () => string;
}

export function feedbackInputsFromPullRequestFinalizeFindings(
  runId: string,
  tenant: string,
  owner: NonModelPrincipal,
  findings: readonly PullRequestFinalizeFinding[],
  options: FeedbackInputsFromPullRequestFinalizeFindingsOptions = {}
): readonly CreateFeedbackInput[] {
  const now = options.clock?.() ?? new Date().toISOString();
  let sequence = 0;
  return findings
    .filter((finding) => finding.severity === 'blocker' || finding.severity === 'warning')
    .map((finding) => {
      sequence += 1;
      const id = options.ids?.() ?? `thread_pr_finalize_${sequence}`;
      const body = `Severity: ${finding.severity}\n\n${finding.summary}`;
      const input: CreateFeedbackInput = {
        runId,
        owner,
        tenant,
        target: 'implementation' as const,
        status: 'open' as const,
        title: finding.summary,
        body,
        thread: [{ id, author: owner, body, createdAt: now }]
      };
      return input;
    });
}
