import { describe, it, expect, beforeEach } from 'vitest';
import type { ConvergenceRoundFinding, Feedback, NonModelPrincipal, Principal, Run } from '@autocatalyst/api-contract';
import type { ReviewerFinding } from '@autocatalyst/api-contract';
import type { CreateFeedbackInput, FeedbackRepository } from './domain-repositories.js';
import { createConvergenceFeedback, createReviewerFeedback } from './convergence-feedback.js';

class InMemoryFeedbackRepository implements FeedbackRepository {
  private store = new Map<string, Feedback>();
  private seq = 0;

  async create(input: CreateFeedbackInput): Promise<Feedback> {
    this.seq += 1;
    const now = new Date().toISOString();
    const feedback: Feedback = {
      id: `feedback_${this.seq}`,
      runId: input.runId,
      owner: input.owner,
      tenant: input.tenant,
      target: input.target,
      status: input.status,
      title: input.title,
      body: input.body,
      ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
      thread: input.thread,
      createdAt: now,
      updatedAt: now
    };
    this.store.set(feedback.id, feedback);
    return feedback;
  }

  async findById(id: string): Promise<Feedback | null> {
    return this.store.get(id) ?? null;
  }

  async listByRun(runId: string): Promise<readonly Feedback[]> {
    return [...this.store.values()].filter(f => f.runId === runId);
  }

  async updateStatusAndAppendThread(): Promise<Feedback> {
    throw new Error('not implemented');
  }

  async appendThreadEntry(): Promise<Feedback> {
    throw new Error('not implemented');
  }
}

const runOwner: NonModelPrincipal = {
  id: 'user-1',
  kind: 'human' as const,
  tenantId: 'tenant-1',
  displayName: 'Test User'
};

const baseRun: Run = {
  id: 'run-1',
  topicId: 'topic-1',
  owner: runOwner,
  tenant: 'tenant-1',
  workKind: 'feature',
  currentStep: 'spec.author',
  terminal: false,
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z'
};

const reviewerPrincipal: Principal = {
  id: 'reviewer-model-1',
  kind: 'model' as const,
  tenantId: 'tenant-1',
  displayName: 'Claude Reviewer'
};

const sampleFindings: ReviewerFinding[] = [
  { title: 'Missing error handling', body: 'The function does not handle null input.', severity: 'blocker' },
  { title: 'Style issue', body: 'Variable name should be camelCase.', severity: 'info' }
];

describe('createReviewerFeedback', () => {
  let repository: InMemoryFeedbackRepository;

  beforeEach(() => {
    repository = new InMemoryFeedbackRepository();
  });

  it('maps spec.author step findings to target: artifact', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: sampleFindings,
      repository,
      clock: () => '2026-06-15T12:00:00.000Z',
      idGenerator: (() => { let n = 0; return () => `thread_${++n}`; })()
    });

    expect(result.feedback).toHaveLength(2);
    for (const f of result.feedback) {
      expect(f.target).toBe('artifact');
    }
  });

  it('maps implementation.build step findings to target: implementation', async () => {
    const run = { ...baseRun, currentStep: 'implementation.build' };
    const result = await createReviewerFeedback({
      run,
      step: 'implementation.build',
      reviewerPrincipal,
      findings: sampleFindings,
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    expect(result.feedback).toHaveLength(2);
    for (const f of result.feedback) {
      expect(f.target).toBe('implementation');
    }
  });

  it('copies owner and tenant from the run onto created feedback', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: [sampleFindings[0]],
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    expect(result.feedback[0].owner).toEqual(baseRun.owner);
    expect(result.feedback[0].tenant).toBe(baseRun.tenant);
  });

  it('creates feedback with status: open', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: [sampleFindings[0]],
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    expect(result.feedback[0].status).toBe('open');
  });

  it('sets the first thread entry author to the reviewer principal', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: [sampleFindings[0]],
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    const entry = result.feedback[0].thread[0];
    expect(entry.author).toEqual(reviewerPrincipal);
  });

  it('returns feedback array and findingsByFeedbackId map', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: sampleFindings,
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    expect(result.feedback).toHaveLength(2);
    expect(Object.keys(result.findingsByFeedbackId)).toHaveLength(2);
    for (const f of result.feedback) {
      expect(result.findingsByFeedbackId[f.id]).toBeDefined();
    }
  });

  it('maps each feedback id to its originating finding', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: sampleFindings,
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    for (const f of result.feedback) {
      const finding = result.findingsByFeedbackId[f.id];
      expect(finding.title).toBe(f.title);
    }
  });

  it('throws for an unsupported step', async () => {
    await expect(
      createReviewerFeedback({
        run: baseRun,
        step: 'implementation.plan',
        reviewerPrincipal,
        findings: [sampleFindings[0]],
        repository,
        clock: () => '2026-06-15T12:00:00.000Z'
      })
    ).rejects.toThrow('reviewer_feedback_target_unsupported');
  });

  it('does not leak credentials or secrets in returned data', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: [sampleFindings[0]],
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/password|secret|credential|token|apiKey/i);
    const f = result.feedback[0];
    expect(f).not.toHaveProperty('password');
    expect(f).not.toHaveProperty('secret');
  });

  it('returns empty arrays when given no findings', async () => {
    const result = await createReviewerFeedback({
      run: baseRun,
      step: 'spec.author',
      reviewerPrincipal,
      findings: [],
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    expect(result.feedback).toHaveLength(0);
    expect(Object.keys(result.findingsByFeedbackId)).toHaveLength(0);
  });

  it('reviewer findings appear alongside human feedback in listByRun', async () => {
    // Create a human feedback item (owner kind: 'human')
    const humanFeedback = await repository.create({
      runId: baseRun.id,
      owner: runOwner,
      tenant: baseRun.tenant,
      target: 'artifact',
      status: 'open',
      title: 'Human feedback item',
      body: 'Something a human noticed.',
      thread: [{ id: 'thread_human_1', author: runOwner, body: 'Something a human noticed.', createdAt: '2026-06-15T10:00:00.000Z' }]
    });

    // Create reviewer feedback via createReviewerFeedback
    const reviewerResult = await createReviewerFeedback({
      run: { ...baseRun, currentStep: 'implementation.build' },
      step: 'implementation.build',
      reviewerPrincipal,
      findings: [sampleFindings[0]],
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });

    // Call repository.listByRun(run.id)
    const allFeedback = await repository.listByRun(baseRun.id);

    // Assert both items are returned
    expect(allFeedback).toHaveLength(2);
    const ids = allFeedback.map((f) => f.id);
    expect(ids).toContain(humanFeedback.id);
    expect(ids).toContain(reviewerResult.feedback[0].id);

    // Assert implementation finding uses target: 'implementation'
    const reviewerFeedbackItem = allFeedback.find((f) => f.id === reviewerResult.feedback[0].id);
    expect(reviewerFeedbackItem?.target).toBe('implementation');
  });
});

describe('createConvergenceFeedback', () => {
  let repository: InMemoryFeedbackRepository;

  beforeEach(() => {
    repository = new InMemoryFeedbackRepository();
  });

  const reviewerFinding: ConvergenceRoundFinding = {
    feedbackId: 'placeholder_1',
    title: 'Reviewer-found issue',
    body: 'Reviewer body.',
    severity: 'blocker',
    blocking: true,
    signature: 'sig_reviewer_1',
    source: 'reviewer',
    category: 'public_api'
  };

  const deterministicFinding: ConvergenceRoundFinding = {
    feedbackId: 'placeholder_det',
    title: 'Early altitude contract violation',
    body: 'Function in src/foo.ts has an executable body.',
    severity: 'blocker',
    blocking: true,
    signature: 'altitude_contract:public_api:src/foo.ts:has_function_body',
    source: 'altitude_contract',
    category: 'contract_violation',
    altitude: 'public_api',
    deterministicKey: 'altitude_contract:public_api:src/foo.ts:has_function_body',
    sourcePath: 'src/foo.ts'
  };

  it('creates feedback for reviewer findings with the reviewer principal as thread author', async () => {
    const result = await createConvergenceFeedback({
      run: { ...baseRun, currentStep: 'implementation.build' },
      step: 'implementation.build',
      altitude: 'public_api',
      round: 1,
      findings: [reviewerFinding],
      reviewerPrincipal,
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });
    expect(result.feedback).toHaveLength(1);
    expect(result.feedback[0].thread[0].author).toEqual(reviewerPrincipal);
  });

  it('creates feedback for deterministic findings with a system principal as thread author', async () => {
    const result = await createConvergenceFeedback({
      run: { ...baseRun, currentStep: 'implementation.build' },
      step: 'implementation.build',
      altitude: 'public_api',
      round: 1,
      findings: [deterministicFinding],
      reviewerPrincipal,
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });
    expect(result.feedback).toHaveLength(1);
    const author = result.feedback[0].thread[0].author as Principal;
    expect(author.kind).toBe('system');
    expect(author.id).toBe('system');
    expect(author.tenantId).toBe(baseRun.tenant);
  });

  it('sets feedbackId on the returned findings to the persisted feedback id', async () => {
    const result = await createConvergenceFeedback({
      run: { ...baseRun, currentStep: 'implementation.build' },
      step: 'implementation.build',
      altitude: 'public_api',
      round: 1,
      findings: [reviewerFinding, deterministicFinding],
      reviewerPrincipal,
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });
    expect(result.updatedFindings).toHaveLength(2);
    expect(result.updatedFindings[0].feedbackId).toBe(result.feedback[0].id);
    expect(result.updatedFindings[1].feedbackId).toBe(result.feedback[1].id);
  });

  it('falls back to system principal for reviewer findings when no reviewerPrincipal is supplied', async () => {
    const result = await createConvergenceFeedback({
      run: { ...baseRun, currentStep: 'implementation.build' },
      step: 'implementation.build',
      round: 1,
      findings: [reviewerFinding],
      repository,
      clock: () => '2026-06-15T12:00:00.000Z'
    });
    const author = result.feedback[0].thread[0].author as Principal;
    expect(author.kind).toBe('system');
  });
});
