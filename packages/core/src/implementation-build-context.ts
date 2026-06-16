import type {
  ArtifactKind,
  ConvergenceRoundRecord,
  ImplementationAltitude,
  ReviewerFindingContext,
  ReviewerFindingSeverity,
  Run
} from '@autocatalyst/api-contract';

export type ImplementationBuildRole = 'implementer' | 'reviewer';

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
  readonly requiredDispositions?: readonly ImplementationBuildReviewContext['requiredDispositions'];
  readonly previousRoundCount?: number;
  readonly humanGuidance?: string;
  readonly outputContract?: {
    readonly schemaId: 'autocatalyst.reviewer_result.v1';
    readonly resultFile: 'step-result.json';
    readonly statusValues: readonly ['satisfied', 'findings'];
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
  const dispositions = input.reviewContext?.requiredDispositions ?? [];
  if (dispositions.length === 0) return ['- Required dispositions: none for this round.'];
  return [
    '- Required dispositions:',
    ...dispositions.map((finding) => `  - ${finding.feedbackId} [${finding.severity}] ${finding.title}: ${finding.body}`),
    '- When advancing, write `step-result.json` with `{ "dispositions": [{ "feedbackId": "...", "disposition": "fixed", "summary": "..." }] }` for fixed findings or `{ "feedbackId": "...", "disposition": "declined", "reason": "..." }` for declined findings.'
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
    '- Write `step-result.json` matching `autocatalyst.reviewer_result.v1`.',
    '- If satisfied, write exactly this shape: `{ "status": "satisfied", "findings": [] }`.',
    '- If there are findings, write `{ "status": "findings", "findings": [{ "title": "...", "body": "...", "severity": "blocker" }] }`.',
    '- Finding severity must be `blocker`, `warning`, or `info`.',
    '- Do not emit a feature_spec, enhancement_spec, task list, prose-only review, implementation summary, or patch.',
    '',
    'Advance only after `step-result.json` exists with one of the two valid reviewer shapes.'
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
    ...(input.role === 'reviewer' ? {
      outputContract: {
        schemaId: 'autocatalyst.reviewer_result.v1',
        resultFile: 'step-result.json',
        statusValues: ['satisfied', 'findings']
      } as const,
      reviewMode: { accessMode: 'read_only', mayModifyWorkspace: false } as const
    } : {}),
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
