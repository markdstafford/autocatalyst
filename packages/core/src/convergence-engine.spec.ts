import { describe, it, expect } from 'vitest';
import {
  findingSignature,
  isBlockingFinding,
  computeCurrentBlockingSet,
  detectOscillation
} from './convergence-engine.js';
import type { ReviewerFinding } from '@autocatalyst/api-contract';

const warnFinding: ReviewerFinding = { title: 'Missing test', body: 'Add coverage for edge case.', severity: 'warning' };
const blockerFinding: ReviewerFinding = { title: 'Security hole', body: 'SQL injection risk.', severity: 'blocker' };
const infoFinding: ReviewerFinding = { title: 'Style note', body: 'Consider renaming.', severity: 'info' };

describe('findingSignature', () => {
  it('produces stable signature for same finding', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature(warnFinding);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different severities', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature({ ...warnFinding, severity: 'blocker' });
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different titles', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature({ ...warnFinding, title: 'Different title' });
    expect(sig1).not.toBe(sig2);
  });
});

describe('isBlockingFinding', () => {
  it('info is never blocking', () => {
    expect(isBlockingFinding(infoFinding, [])).toBe(false);
  });

  it('warning is blocking when not declined', () => {
    expect(isBlockingFinding(warnFinding, [])).toBe(true);
  });

  it('blocker is blocking when not declined', () => {
    expect(isBlockingFinding(blockerFinding, [])).toBe(true);
  });

  it('warning is non-blocking when its signature is in declined set', () => {
    const sig = findingSignature(warnFinding);
    expect(isBlockingFinding(warnFinding, [sig])).toBe(false);
  });
});

describe('detectOscillation', () => {
  it('returns false with no previous rounds', () => {
    expect(detectOscillation([], ['sig-1'])).toBe(false);
  });

  it('detects repeated blocking signature after implementer had chance to respond', () => {
    // Round 1 had a finding with same signature, implementer had a chance
    const previousRounds = [{
      round: 1,
      changedFileCount: 0,
      findings: [{ feedbackId: 'fb-1', title: 'Missing test', body: 'Add coverage for edge case.', severity: 'warning' as const, blocking: true, signature: 'sig-1' }],
      dispositions: [],
      outcome: 'continue' as const
    }];
    expect(detectOscillation(previousRounds, ['sig-1'])).toBe(true);
  });

  it('detects non-decreasing blocking count when implementer had at least one chance', () => {
    const previousRounds = [
      { round: 1, changedFileCount: 0, findings: [
        { feedbackId: 'fb-1', title: 'A', body: 'B', severity: 'warning' as const, blocking: true, signature: 'sig-1' },
        { feedbackId: 'fb-2', title: 'C', body: 'D', severity: 'blocker' as const, blocking: true, signature: 'sig-2' }
      ], dispositions: [], outcome: 'continue' as const }
    ];
    // Current blocking set has 2 or more items (non-decreasing from round 1's 2)
    expect(detectOscillation(previousRounds, ['sig-1', 'sig-2', 'sig-3'])).toBe(true);
  });

  it('does not trigger oscillation on first round', () => {
    // No previous rounds = no oscillation possible
    expect(detectOscillation([], ['sig-1', 'sig-2'])).toBe(false);
  });
});
