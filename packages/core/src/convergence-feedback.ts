import type {
  ConvergenceRoundFinding,
  Feedback,
  FeedbackTarget,
  ImplementationAltitude,
  Principal,
  Run
} from '@autocatalyst/api-contract';
import type { ReviewerFinding } from '@autocatalyst/api-contract';
import type { FeedbackRepository } from './domain-repositories.js';

export interface ReviewerFeedbackCreationInput {
  readonly run: Run;
  readonly step: string;
  readonly reviewerPrincipal: Principal;
  readonly findings: readonly ReviewerFinding[];
  readonly repository: FeedbackRepository;
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
}

export interface ReviewerFeedbackCreationResult {
  readonly feedback: readonly Feedback[];
  readonly findingsByFeedbackId: Readonly<Record<string, ReviewerFinding>>;
}

function feedbackTargetForStep(step: string): FeedbackTarget {
  if (step === 'spec.author') return 'artifact';
  if (step === 'implementation.build') return 'implementation';
  throw new Error('reviewer_feedback_target_unsupported');
}

export async function createReviewerFeedback(input: ReviewerFeedbackCreationInput): Promise<ReviewerFeedbackCreationResult> {
  const target = feedbackTargetForStep(input.step);
  const now = input.clock?.() ?? new Date().toISOString();
  const created: Feedback[] = [];
  const findingsByFeedbackId: Record<string, ReviewerFinding> = {};
  let sequence = 0;

  for (const finding of input.findings) {
    sequence += 1;
    const threadId = input.idGenerator?.() ?? `thread_${sequence}`;
    const feedback = await input.repository.create({
      runId: input.run.id,
      owner: input.run.owner,
      tenant: input.run.tenant,
      target,
      status: 'open',
      title: finding.title,
      body: finding.body,
      ...(finding.anchor !== undefined ? { anchor: finding.anchor } : {}),
      thread: [{ id: threadId, author: input.reviewerPrincipal, body: finding.body, createdAt: now }]
    });
    created.push(feedback);
    findingsByFeedbackId[feedback.id] = finding;
  }

  return { feedback: created, findingsByFeedbackId };
}

export interface ConvergenceFeedbackInput {
  readonly run: Run;
  readonly step: string;
  readonly altitude?: ImplementationAltitude;
  readonly round: number;
  readonly findings: readonly ConvergenceRoundFinding[];
  readonly reviewerPrincipal?: Principal;
  readonly repository: FeedbackRepository;
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
}

export interface ConvergenceFeedbackResult {
  readonly feedback: readonly Feedback[];
  readonly updatedFindings: readonly ConvergenceRoundFinding[];
}

function systemPrincipal(tenant: string): Principal {
  return { id: 'system', kind: 'system', tenantId: tenant };
}

function isDeterministic(finding: ConvergenceRoundFinding): boolean {
  return finding.source === 'altitude_contract' || finding.source === 'build_drift';
}

export async function createConvergenceFeedback(
  input: ConvergenceFeedbackInput
): Promise<ConvergenceFeedbackResult> {
  const target = feedbackTargetForStep(input.step);
  const now = input.clock?.() ?? new Date().toISOString();
  const created: Feedback[] = [];
  const updatedFindings: ConvergenceRoundFinding[] = [];
  let sequence = 0;

  const sys = systemPrincipal(input.run.tenant);

  for (const finding of input.findings) {
    sequence += 1;
    const threadId = input.idGenerator?.() ?? `thread_${sequence}`;
    const author: Principal = isDeterministic(finding)
      ? sys
      : input.reviewerPrincipal ?? sys;

    const feedback = await input.repository.create({
      runId: input.run.id,
      owner: input.run.owner,
      tenant: input.run.tenant,
      target,
      status: 'open',
      title: finding.title,
      body: finding.body,
      thread: [{ id: threadId, author, body: finding.body, createdAt: now }]
    });
    created.push(feedback);
    updatedFindings.push({ ...finding, feedbackId: feedback.id });
  }

  return { feedback: created, updatedFindings };
}
