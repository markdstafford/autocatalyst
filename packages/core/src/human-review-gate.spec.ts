import { describe, expect, it } from 'vitest';

import type { Feedback, Run } from '@autocatalyst/api-contract';
import {
  assertHumanReviewGateCanAdvance,
  getHumanReviewGateFeedbackTarget,
  HumanReviewGateError,
  isHumanReviewGateStep
} from './human-review-gate.js';

function makeRun(currentStep: string): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner: { kind: 'human', id: 'owner_1', tenantId: 'tenant_1' },
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep,
    terminal: false,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z'
  } as unknown as Run;
}

function makeFeedback(id: string): Feedback {
  return {
    id,
    runId: 'run_1',
    owner: { kind: 'human', id: 'owner_1', tenantId: 'tenant_1' },
    tenant: 'tenant_1',
    target: 'implementation',
    status: 'open',
    title: 'Test',
    body: 'Test body',
    thread: [{ id: 'thread_1', author: { kind: 'human', id: 'author_1', tenantId: 'tenant_1' }, body: 'Test body', createdAt: '2026-06-15T00:00:00.000Z' }],
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z'
  } as unknown as Feedback;
}

describe('human review gate', () => {
  it('maps supported gate steps to server-derived targets', () => {
    expect(isHumanReviewGateStep('spec.human_review')).toBe(true);
    expect(isHumanReviewGateStep('implementation.human_review')).toBe(true);
    expect(isHumanReviewGateStep('spec.author')).toBe(false);
    expect(getHumanReviewGateFeedbackTarget('spec.human_review')).toBe('artifact');
    expect(getHumanReviewGateFeedbackTarget('implementation.human_review')).toBe('implementation');
  });

  it('passes when no blocking feedback exists', async () => {
    await expect(assertHumanReviewGateCanAdvance(
      { run: makeRun('implementation.human_review'), target: 'implementation' },
      { listBlockingFeedback: async () => [] }
    )).resolves.toBeUndefined();
  });

  it('blocks when matching open or addressed feedback remains', async () => {
    await expect(assertHumanReviewGateCanAdvance(
      { run: makeRun('implementation.human_review'), target: 'implementation' },
      { listBlockingFeedback: async ({ target }) => target === 'implementation' ? [makeFeedback('fb_1')] : [] }
    )).rejects.toMatchObject({ code: 'feedback_gate_blocked', blockingFeedbackIds: ['fb_1'] });
  });

  it('rejects invalid steps with invalid_step code', async () => {
    await expect(assertHumanReviewGateCanAdvance(
      { run: makeRun('spec.author'), target: 'artifact' },
      { listBlockingFeedback: async () => [] }
    )).rejects.toMatchObject({ code: 'invalid_step' });
  });

  it('rejects target mismatches with target_mismatch code', async () => {
    await expect(assertHumanReviewGateCanAdvance(
      { run: makeRun('spec.human_review'), target: 'implementation' },
      { listBlockingFeedback: async () => [] }
    )).rejects.toMatchObject({ code: 'target_mismatch' });
  });

  it('throws HumanReviewGateError instances', async () => {
    await expect(assertHumanReviewGateCanAdvance(
      { run: makeRun('spec.author'), target: 'artifact' },
      { listBlockingFeedback: async () => [] }
    )).rejects.toBeInstanceOf(HumanReviewGateError);
  });
});
