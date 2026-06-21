import type {
  ArtifactKind,
  ConvergenceRoundRecord,
  ImplementationAltitude,
  ReviewerFindingContext,
  ReviewerFindingSeverity,
  Run
} from '@autocatalyst/api-contract';

export type ImplementationBuildRole = 'implementer' | 'reviewer';

export const REVIEWER_RESULT_SCHEMA_ID = 'autocatalyst.reviewer_result.v1' as const;
export const IMPLEMENTER_DISPOSITIONS_SCHEMA_ID = 'autocatalyst.implementer_dispositions.v1' as const;

/**
 * The immutable result file for one (step, role, round). One file per role and
 * round means the implementer's dispositions and the reviewer's verdict are
 * never written to — or validated against — the same file, and no result is
 * ever overwritten or clobbered. The name is ordered least-to-most specific:
 * step, then round, then role.
 */
export function implementationBuildResultFile(role: ImplementationBuildRole, round: number): string {
  return `implementation-build-round-${round}-${role}-result.json`;
}

export interface ImplementationBuildApprovedSpecContext {
  readonly kind: Extract<ArtifactKind, 'feature_spec' | 'enhancement_spec'>;
  readonly relativePath: string;
  readonly cachedStatus?: string;
}

export interface ImplementationBuildReviewContext {
  readonly previousFindings?: readonly ReviewerFindingContext[];
  readonly requiredDispositions?: readonly {
    readonly feedbackId: string;
    readonly title: string;
    readonly severity: ReviewerFindingSeverity;
    readonly body: string;
  }[];
  readonly previousRounds?: readonly ConvergenceRoundRecord[];
  readonly altitudeContext?: {
    readonly altitude: ImplementationAltitude;
    readonly altitudeRound: number;
    readonly allowedWork?: string;
    readonly acceptedCheckpoints?: readonly unknown[];
    readonly findingCategories?: readonly string[];
  };
  readonly humanGuidance?: string;
}

export interface ImplementationBuildPromptInput {
  readonly run: Run;
  readonly role: ImplementationBuildRole;
  readonly round: number;
  readonly approvedSpec?: ImplementationBuildApprovedSpecContext;
  readonly reviewContext?: ImplementationBuildReviewContext;
}

export interface ImplementationBuildTaskInputs {
  readonly role: ImplementationBuildRole;
  readonly round: number;
  readonly run: {
    readonly id: string;
    readonly tenant: string;
    readonly workKind: string;
    readonly currentStep: 'implementation.build';
    readonly issueNumber?: number;
  };
  readonly approvedSpec?: ImplementationBuildApprovedSpecContext;
  readonly altitude?: {
    readonly altitude: ImplementationAltitude;
    readonly altitudeRound: number;
    readonly allowedWork?: string;
    readonly findingCategories?: readonly string[];
  };
  readonly previousFindings?: readonly ReviewerFindingContext[];
  readonly requiredDispositions?: ImplementationBuildReviewContext['requiredDispositions'];
  readonly previousRoundCount?: number;
  readonly humanGuidance?: string;
  readonly outputContract?: {
    readonly schemaId: typeof REVIEWER_RESULT_SCHEMA_ID | typeof IMPLEMENTER_DISPOSITIONS_SCHEMA_ID;
    readonly resultFile: string;
    readonly statusValues?: readonly ['satisfied', 'findings'];
  };
  readonly reviewMode?: {
    readonly accessMode: 'read_only';
    readonly mayModifyWorkspace: false;
  };
  readonly runtimeOwnership: {
    readonly currentBranchOnly: true;
    readonly prohibitBranchCreation: true;
    readonly prohibitBranchSwitching: true;
    readonly prohibitWorktreeCreation: true;
    readonly prohibitPush: true;
    readonly prohibitMerge: true;
    readonly prohibitPullRequest: true;
  };
}

export interface ImplementationBuildContext {
  readonly prompt: string;
  readonly taskInputs: ImplementationBuildTaskInputs;
}

function specLine(input: ImplementationBuildPromptInput): string {
  if (input.approvedSpec === undefined) {
    return '- Approved spec: no feature/enhancement spec artifact is attached to this run; use run inputs and repository context.';
  }
  return `- Approved spec: \`${input.approvedSpec.relativePath}\` (${input.approvedSpec.kind}${input.approvedSpec.cachedStatus !== undefined ? `, status ${input.approvedSpec.cachedStatus}` : ''}).`;
}

function altitudeLines(input: ImplementationBuildPromptInput): readonly string[] {
  const altitude = input.reviewContext?.altitudeContext;
  if (altitude === undefined) return ['- Altitude: build.', '- Altitude round: 1.'];
  return [
    `- Altitude: ${altitude.altitude}.`,
    `- Altitude round: ${altitude.altitudeRound}.`,
    `- Allowed work: ${altitude.allowedWork ?? 'implement and validate only the work permitted by this altitude.'}`,
    `- Finding categories: ${(altitude.findingCategories ?? []).join(', ') || 'not restricted.'}`
  ];
}

function requiredDispositionLines(input: ImplementationBuildPromptInput): readonly string[] {
  const resultFile = implementationBuildResultFile('implementer', input.round);
  const dispositions = input.reviewContext?.requiredDispositions ?? [];
  if (dispositions.length === 0) {
    return [
      '- Required dispositions: none for this round.',
      `- Always write \`${resultFile}\` when advancing. Write \`{}\` when there are no dispositions.`
    ];
  }
  return [
    '- Required dispositions:',
    ...dispositions.map((finding) => `  - ${finding.feedbackId} [${finding.severity}] ${finding.title}: ${finding.body}`),
    `- When advancing, write \`${resultFile}\` with \`{ "dispositions": [{ "feedbackId": "...", "disposition": "fixed", "summary": "..." }] }\` for fixed findings or \`{ "feedbackId": "...", "disposition": "declined", "reason": "..." }\` for declined findings.`
  ];
}

function commonHeader(input: ImplementationBuildPromptInput): readonly string[] {
  return [
    `Run: ${input.run.id}`,
    `Work kind: ${input.run.workKind}`,
    `Round: ${input.round}`,
    specLine(input),
    ...altitudeLines(input),
    '',
    'Runtime ownership rules:',
    '- Stay on the current branch only.',
    '- Do not create branches.',
    '- Do not switch branches.',
    '- Do not create worktrees.',
    '- Do not push, merge, or open PRs.'
  ];
}

export function buildImplementationBuildPrompt(input: ImplementationBuildPromptInput): string {
  if (input.role === 'implementer') {
    return [
      'You are the implementer for `implementation.build`.',
      '',
      ...commonHeader(input),
      '',
      'Implementation instructions:',
      '- Read the approved spec before editing code when a spec path is supplied.',
      '- Make the smallest repository changes that satisfy the approved spec, current altitude, and unresolved findings.',
      '- Run focused tests for the changed behavior before advancing.',
      '- If previous reviewer findings are supplied, address each blocker or record a concrete declined disposition.',
      ...requiredDispositionLines(input),
      input.reviewContext?.humanGuidance !== undefined ? `- Human guidance: ${input.reviewContext.humanGuidance}` : '- Human guidance: none supplied.',
      '',
      'Do not write a reviewer verdict. Do not emit a spec-shaped result.'
    ].join('\n');
  }

  return [
    'You are the reviewer for `implementation.build`.',
    '',
    ...commonHeader(input),
    '',
    'Reviewer access and scope:',
    '- This is a read-only review session. Inspect files and test output; do not modify the workspace.',
    '- Check whether the implementer satisfied the approved spec, required dispositions, altitude contract, and test expectations.',
    '- Do not write patches, do not commit, and do not change files.',
    '',
    'Output contract:',
    '- You are read-only and cannot write files. Your verdict is recorded from your final message.',
    '- End your turn with exactly one JSON object matching `autocatalyst.reviewer_result.v1` as your final message, and nothing else.',
    '- If satisfied, your final message must be exactly: `{ "status": "satisfied", "findings": [] }`.',
    '- If there are findings, it must be `{ "status": "findings", "findings": [{ "title": "...", "body": "...", "severity": "blocker" }] }`.',
    '- Finding severity must be `blocker`, `warning`, or `info`.',
    '- Do not emit a feature_spec, enhancement_spec, task list, prose-only review, implementation summary, or patch.',
    '',
    'Produce no verdict and the round is recorded as a fault — it is never treated as a satisfied review.'
  ].join('\n');
}

export function buildImplementationBuildTaskInputs(input: ImplementationBuildPromptInput): ImplementationBuildTaskInputs {
  const altitude = input.reviewContext?.altitudeContext;
  return {
    role: input.role,
    round: input.round,
    run: {
      id: input.run.id,
      tenant: input.run.tenant,
      workKind: input.run.workKind,
      currentStep: 'implementation.build',
      ...(input.run.trackedIssue?.number !== undefined ? { issueNumber: input.run.trackedIssue.number } : {})
    },
    ...(input.approvedSpec !== undefined ? { approvedSpec: input.approvedSpec } : {}),
    ...(altitude !== undefined ? {
      altitude: {
        altitude: altitude.altitude,
        altitudeRound: altitude.altitudeRound,
        ...(altitude.allowedWork !== undefined ? { allowedWork: altitude.allowedWork } : {}),
        ...(altitude.findingCategories !== undefined ? { findingCategories: altitude.findingCategories } : {})
      }
    } : {}),
    ...(input.reviewContext?.previousFindings !== undefined && input.reviewContext.previousFindings.length > 0 ? { previousFindings: input.reviewContext.previousFindings } : {}),
    ...(input.reviewContext?.requiredDispositions !== undefined && input.reviewContext.requiredDispositions.length > 0 ? { requiredDispositions: input.reviewContext.requiredDispositions } : {}),
    ...(input.reviewContext?.previousRounds !== undefined && input.reviewContext.previousRounds.length > 0 ? { previousRoundCount: input.reviewContext.previousRounds.length } : {}),
    ...(input.reviewContext?.humanGuidance !== undefined ? { humanGuidance: input.reviewContext.humanGuidance } : {}),
    ...(input.role === 'reviewer'
      ? {
          outputContract: {
            schemaId: REVIEWER_RESULT_SCHEMA_ID,
            resultFile: implementationBuildResultFile('reviewer', input.round),
            statusValues: ['satisfied', 'findings']
          } as const,
          reviewMode: { accessMode: 'read_only', mayModifyWorkspace: false } as const
        }
      : {
          outputContract: {
            schemaId: IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
            resultFile: implementationBuildResultFile('implementer', input.round)
          } as const
        }),
    runtimeOwnership: {
      currentBranchOnly: true,
      prohibitBranchCreation: true,
      prohibitBranchSwitching: true,
      prohibitWorktreeCreation: true,
      prohibitPush: true,
      prohibitMerge: true,
      prohibitPullRequest: true
    }
  };
}

export function buildImplementationBuildContext(input: ImplementationBuildPromptInput): ImplementationBuildContext {
  return {
    prompt: buildImplementationBuildPrompt(input),
    taskInputs: buildImplementationBuildTaskInputs(input)
  };
}
