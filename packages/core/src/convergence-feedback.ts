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
  /**
   * Map from deterministicKey → existing open feedbackId for deterministic findings
   * that were created in a prior round of the same altitude. When a key is present
   * here, the existing feedback is reused instead of creating a duplicate.
   */
  readonly deterministicFeedbackIdByKey?: Readonly<Record<string, string>>;
  /**
   * Feedback IDs of deterministic findings that were open in a prior round but are
   * NOT re-emitted this round (the deterministic check has passed). These are
   * auto-resolved with a system resolution reason.
   */
  readonly staleDeterministicFeedbackIds?: readonly string[];
}

export interface ConvergenceFeedbackResult {
  readonly feedback: readonly Feedback[];
  readonly updatedFindings: readonly ConvergenceRoundFinding[];
  /** Updated map of deterministicKey → feedbackId for all deterministic findings persisted in this call. */
  readonly deterministicFeedbackIdByKey: Readonly<Record<string, string>>;
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

  // Build the set of deterministic keys that are being emitted this round.
  const emittedDeterministicKeys = new Set<string>();
  for (const finding of input.findings) {
    if (isDeterministic(finding) && finding.deterministicKey !== undefined) {
      emittedDeterministicKeys.add(finding.deterministicKey);
    }
  }

  // Auto-resolve stale deterministic feedback whose key is no longer emitted.
  if (input.staleDeterministicFeedbackIds !== undefined && input.staleDeterministicFeedbackIds.length > 0) {
    const staleIds = input.staleDeterministicFeedbackIds.filter((id) => !emittedDeterministicKeys.has(id));
    for (const staleId of staleIds) {
      try {
        const existing = await input.repository.findById(staleId);
        if (existing !== null && existing.status === 'open') {
          sequence += 1;
          const threadId = input.idGenerator?.() ?? `thread_resolve_${sequence}`;
          await input.repository.updateStatusAndAppendThread({
            feedbackId: staleId,
            expectedStatus: 'open',
            nextStatus: 'resolved',
            threadEntry: {
              id: threadId,
              author: sys,
              body: 'Deterministic check passed — no longer blocking.',
              createdAt: now
            },
            updatedAt: now
          });
        }
      } catch {
        // Best-effort: if resolution fails, the id is simply omitted from
        // openFeedbackIds in the checkpoint (the engine handles that separately).
      }
    }
  }

  // Accumulate updated deterministic key → feedbackId mapping.
  const deterministicFeedbackIdByKey: Record<string, string> = {
    ...(input.deterministicFeedbackIdByKey ?? {})
  };

  for (const finding of input.findings) {
    sequence += 1;
    const author: Principal = isDeterministic(finding) ? sys : (input.reviewerPrincipal ?? sys);

    if (isDeterministic(finding) && finding.deterministicKey !== undefined) {
      const key = finding.deterministicKey;
      const existingId = deterministicFeedbackIdByKey[key];
      if (existingId !== undefined) {
        // Reuse existing open deterministic feedback instead of creating a duplicate.
        const existingFb = await input.repository.findById(existingId);
        if (existingFb !== null && existingFb.status === 'open') {
          created.push(existingFb);
          updatedFindings.push({ ...finding, feedbackId: existingFb.id });
          continue;
        }
        // Existing feedback not found or closed — fall through to create new.
      }

      const feedback = await input.repository.create({
        runId: input.run.id,
        owner: input.run.owner,
        tenant: input.run.tenant,
        target,
        status: 'open',
        title: finding.title,
        body: finding.body,
        thread: [{ id: input.idGenerator?.() ?? `thread_${sequence}`, author, body: finding.body, createdAt: now }]
      });
      created.push(feedback);
      updatedFindings.push({ ...finding, feedbackId: feedback.id });
      deterministicFeedbackIdByKey[key] = feedback.id;
      continue;
    }

    // Reviewer finding — always create fresh feedback.
    const feedback = await input.repository.create({
      runId: input.run.id,
      owner: input.run.owner,
      tenant: input.run.tenant,
      target,
      status: 'open',
      title: finding.title,
      body: finding.body,
      thread: [{ id: input.idGenerator?.() ?? `thread_${sequence}`, author, body: finding.body, createdAt: now }]
    });
    created.push(feedback);
    updatedFindings.push({ ...finding, feedbackId: feedback.id });
  }

  return { feedback: created, updatedFindings, deterministicFeedbackIdByKey };
}
