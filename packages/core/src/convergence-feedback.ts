import type { Feedback, FeedbackTarget, Principal, Run } from '@autocatalyst/api-contract';
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
