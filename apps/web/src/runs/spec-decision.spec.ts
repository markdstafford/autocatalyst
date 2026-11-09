/**
 * Unit tests for the pure spec-gate decision logic: gate availability, artifact-only
 * feedback counting, decision label/kind, the operator's addressed co-confirmation, and
 * the decision-error shaping (including the gate-blocked special case).
 */
import type { FeedbackResponse, FeedbackStatus, Run } from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import { describe, expect, it } from 'vitest';

import {
  SPEC_GATE_STEP,
  addressedConfirmationCopy,
  countAddressedByPrincipal,
  countOpenFeedback,
  countResolvedFeedback,
  decisionErrorInfo,
  decisionKind,
  decisionLabel,
  isFeedbackGateBlocked,
  isSpecGateDecisionAvailable
} from './spec-decision.js';

const NOW = '2026-11-08T01:00:00.000Z';
const OWNER = { kind: 'human', id: 'operator-1', tenantId: 'tenant_dev' } as const;

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    topicId: 'topic-run-1',
    owner: OWNER,
    tenant: 'tenant_dev',
    workKind: 'feature',
    currentStep: SPEC_GATE_STEP,
    waitingOn: 'human',
    status: 'in_progress',
    terminal: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function feedback(
  overrides: Partial<FeedbackResponse> & { id: string }
): FeedbackResponse {
  return {
    id: overrides.id,
    runId: 'run-1',
    owner: OWNER,
    tenant: 'tenant_dev',
    target: 'artifact',
    status: 'open',
    title: 'Title',
    body: 'Body text',
    thread: [
      { id: `${overrides.id}-t1`, author: { id: 'operator-1', kind: 'human', tenantId: 'tenant_dev' }, body: 'Body text', createdAt: NOW }
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as FeedbackResponse;
}

function authoredBy(id: string, status: FeedbackStatus, principalId: string): FeedbackResponse {
  return feedback({
    id,
    status,
    thread: [{ id: `${id}-t1`, author: { id: principalId, kind: 'human', tenantId: 'tenant_dev' }, body: 'Body text', createdAt: NOW }]
  });
}

describe('isSpecGateDecisionAvailable', () => {
  it('is true at the spec human-review gate', () => {
    expect(isSpecGateDecisionAvailable(makeRun({ currentStep: 'spec.human_review' }))).toBe(true);
  });

  it('is false at other human-review gates', () => {
    expect(isSpecGateDecisionAvailable(makeRun({ currentStep: 'implementation.human_review' }))).toBe(false);
    expect(isSpecGateDecisionAvailable(makeRun({ currentStep: 'pr.human_review' }))).toBe(false);
  });

  it('is false for a terminal run', () => {
    expect(isSpecGateDecisionAvailable(makeRun({ currentStep: 'done', status: 'done', terminal: true }))).toBe(false);
    expect(isSpecGateDecisionAvailable(makeRun({ currentStep: 'failed', status: 'failed', terminal: true }))).toBe(false);
  });

  it('is false for an in-progress non-gate step', () => {
    expect(isSpecGateDecisionAvailable(makeRun({ currentStep: 'spec.author' }))).toBe(false);
  });

  // Contract gap: a stale / derived run can retain currentStep 'spec.human_review' while it is
  // no longer waiting at the gate. The step alone must not expose the decision controls.
  it('is false when the run retains the gate step but is terminal', () => {
    expect(
      isSpecGateDecisionAvailable(makeRun({ currentStep: SPEC_GATE_STEP, terminal: true }))
    ).toBe(false);
  });

  it('is false when the run retains the gate step but has a finished status', () => {
    for (const status of ['done', 'failed', 'canceled'] as const) {
      expect(
        isSpecGateDecisionAvailable(makeRun({ currentStep: SPEC_GATE_STEP, status, terminal: true }))
      ).toBe(false);
      // Even if a stale object left terminal=false, a finished status is still non-gate.
      expect(
        isSpecGateDecisionAvailable(makeRun({ currentStep: SPEC_GATE_STEP, status, terminal: false }))
      ).toBe(false);
    }
  });

  it('is false when the run retains the gate step but is not waiting on a human', () => {
    for (const waitingOn of ['system', 'ai', 'none'] as const) {
      expect(
        isSpecGateDecisionAvailable(makeRun({ currentStep: SPEC_GATE_STEP, waitingOn }))
      ).toBe(false);
    }
  });

  it('is true at the gate step when status and waitingOn are absent (additive compatibility)', () => {
    expect(
      isSpecGateDecisionAvailable(
        makeRun({ currentStep: SPEC_GATE_STEP, status: undefined, waitingOn: undefined })
      )
    ).toBe(true);
  });

  it('requires all of step, non-terminal, in-progress, and waiting-on-human together', () => {
    expect(
      isSpecGateDecisionAvailable(
        makeRun({ currentStep: SPEC_GATE_STEP, status: 'in_progress', waitingOn: 'human', terminal: false })
      )
    ).toBe(true);
  });
});

describe('countOpenFeedback / countResolvedFeedback', () => {
  it('counts zero open', () => {
    expect(countOpenFeedback([])).toBe(0);
  });

  it('counts one open', () => {
    expect(countOpenFeedback([feedback({ id: 'f1', status: 'open' })])).toBe(1);
  });

  it('counts many open', () => {
    const items = [
      feedback({ id: 'f1', status: 'open' }),
      feedback({ id: 'f2', status: 'open' }),
      feedback({ id: 'f3', status: 'open' })
    ];
    expect(countOpenFeedback(items)).toBe(3);
  });

  it('counts addressed, resolved and wont_fix as resolved', () => {
    const items = [
      feedback({ id: 'f1', status: 'addressed' }),
      feedback({ id: 'f2', status: 'resolved' }),
      feedback({ id: 'f3', status: 'wont_fix' }),
      feedback({ id: 'f4', status: 'open' })
    ];
    expect(countResolvedFeedback(items)).toBe(3);
    expect(countOpenFeedback(items)).toBe(1);
  });

  it('ignores non-artifact targets in both counts', () => {
    const items = [
      feedback({ id: 'f1', status: 'open', target: 'implementation' }),
      feedback({ id: 'f2', status: 'open', target: 'docs' }),
      feedback({ id: 'f3', status: 'addressed', target: 'pr' }),
      feedback({ id: 'f4', status: 'open', target: 'artifact' }),
      feedback({ id: 'f5', status: 'resolved', target: 'artifact' })
    ];
    expect(countOpenFeedback(items)).toBe(1);
    expect(countResolvedFeedback(items)).toBe(1);
  });
});

describe('decisionLabel', () => {
  it('is Approve when no open feedback', () => {
    expect(decisionLabel(0)).toBe('Approve');
  });

  it('is Request changes (N) when feedback is open', () => {
    expect(decisionLabel(1)).toBe('Request changes (1)');
    expect(decisionLabel(3)).toBe('Request changes (3)');
  });
});

describe('decisionKind', () => {
  it('is approve when no open feedback', () => {
    expect(decisionKind(0)).toBe('approve');
  });

  it('is request_changes when feedback is open', () => {
    expect(decisionKind(2)).toBe('request_changes');
  });
});

describe('countAddressedByPrincipal', () => {
  it('counts addressed items authored by the given principal', () => {
    const items = [
      authoredBy('f1', 'addressed', 'operator-1'),
      authoredBy('f2', 'addressed', 'operator-1')
    ];
    expect(countAddressedByPrincipal(items, 'operator-1')).toBe(2);
  });

  it('excludes addressed items authored by other principals', () => {
    const items = [
      authoredBy('f1', 'addressed', 'operator-1'),
      authoredBy('f2', 'addressed', 'operator-2')
    ];
    expect(countAddressedByPrincipal(items, 'operator-1')).toBe(1);
  });

  it('excludes non-addressed items authored by the principal', () => {
    const items = [
      authoredBy('f1', 'open', 'operator-1'),
      authoredBy('f2', 'resolved', 'operator-1'),
      authoredBy('f3', 'addressed', 'operator-1')
    ];
    expect(countAddressedByPrincipal(items, 'operator-1')).toBe(1);
  });

  it('ignores non-artifact targets', () => {
    const items = [
      feedback({ id: 'f1', status: 'addressed', target: 'implementation', thread: [{ id: 'f1-t1', author: { id: 'operator-1', kind: 'human', tenantId: 'tenant_dev' }, body: 'b', createdAt: NOW }] })
    ];
    expect(countAddressedByPrincipal(items, 'operator-1')).toBe(0);
  });

  it('returns 0 when principalId is undefined', () => {
    const items = [authoredBy('f1', 'addressed', 'operator-1')];
    expect(countAddressedByPrincipal(items, undefined)).toBe(0);
  });
});

describe('addressedConfirmationCopy', () => {
  it('is undefined for zero', () => {
    expect(addressedConfirmationCopy(0)).toBeUndefined();
  });

  it('is the exact copy for a positive count', () => {
    expect(addressedConfirmationCopy(1)).toBe('Approving also confirms 1 of your addressed comments');
    expect(addressedConfirmationCopy(4)).toBe('Approving also confirms 4 of your addressed comments');
  });
});

describe('decisionErrorInfo / isFeedbackGateBlocked', () => {
  it('extracts message and code from a ControlPlaneClientError', () => {
    const err = new ControlPlaneClientError(409, { error: { code: 'feedback_gate_blocked', message: 'blocked msg' } });
    expect(decisionErrorInfo(err)).toEqual({ message: 'blocked msg', code: 'feedback_gate_blocked' });
    expect(isFeedbackGateBlocked(err)).toBe(true);
  });

  it('is not gate-blocked for a different control-plane code', () => {
    const err = new ControlPlaneClientError(422, { error: { code: 'validation_error', message: 'bad input' } });
    expect(decisionErrorInfo(err)).toEqual({ message: 'bad input', code: 'validation_error' });
    expect(isFeedbackGateBlocked(err)).toBe(false);
  });

  it('falls back for a plain error', () => {
    expect(decisionErrorInfo(new Error('x'))).toEqual({ message: 'The request could not be completed.', code: undefined });
    expect(decisionErrorInfo(new Error('x'), 'custom fallback')).toEqual({ message: 'custom fallback', code: undefined });
    expect(isFeedbackGateBlocked(new Error('x'))).toBe(false);
  });
});
