import { describe, expect, it, vi } from 'vitest';

import type { Feedback } from '@autocatalyst/api-contract';

import {
  isReconcilableSpecFeedback,
  reconcileAnchorAgainstSpec,
  reconcileSpecFeedback,
  type ReconcileSpecFeedbackDependencies
} from './spec-anchor-reconciler.js';

function item(partial: Partial<Feedback> & { id: string }): Feedback {
  return {
    runId: 'run_1',
    owner: { kind: 'human', id: 'alice', tenantId: 'tenant_1' },
    tenant: 'tenant_1',
    target: 'artifact',
    status: 'open',
    title: 'Comment',
    body: 'Body',
    thread: [{ id: 't1', author: { kind: 'human', id: 'alice', tenantId: 'tenant_1' }, body: 'Body', createdAt: '2026-06-11T00:00:00.000Z' }],
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...partial
  } as Feedback;
}

function anchor(from: number, to: number, quotedText?: string) {
  return { kind: 'artifact_range' as const, artifactId: 'art_1', from, to, ...(quotedText !== undefined ? { quotedText } : {}) };
}

describe('reconcileAnchorAgainstSpec', () => {
  const markdown = 'alpha beta gamma';

  it('returns unchanged when the stored slice still matches', () => {
    expect(reconcileAnchorAgainstSpec(anchor(6, 10, 'beta'), markdown)).toEqual({ kind: 'unchanged' });
  });

  it('repairs moved quotes to the first matching occurrence', () => {
    // 'gamma' moved: stored offsets point elsewhere.
    expect(reconcileAnchorAgainstSpec(anchor(0, 5, 'gamma'), markdown)).toEqual({ kind: 'repaired', from: 11, to: 16 });
  });

  it('repairs duplicate quotes to the first match', () => {
    // Stored offsets no longer point at the quote (they slice 'bar'); repair chooses the first 'foo'.
    const dup = 'foo bar foo';
    expect(reconcileAnchorAgainstSpec(anchor(4, 7, 'foo'), dup)).toEqual({ kind: 'repaired', from: 0, to: 3 });
  });

  it('marks missing quotes stale', () => {
    expect(reconcileAnchorAgainstSpec(anchor(0, 5, 'absent'), markdown)).toEqual({ kind: 'stale' });
  });

  it('treats legacy anchors without quotedText as unchanged', () => {
    expect(reconcileAnchorAgainstSpec(anchor(0, 5), markdown)).toEqual({ kind: 'unchanged' });
  });

  it('counts code points, not UTF-16 units, when repairing', () => {
    const emoji = '🙂 beta';
    expect(reconcileAnchorAgainstSpec(anchor(0, 4, 'beta'), emoji)).toEqual({ kind: 'repaired', from: 2, to: 6 });
  });
});

describe('isReconcilableSpecFeedback', () => {
  it('is true only for artifact-target artifact_range anchors with quotedText', () => {
    expect(isReconcilableSpecFeedback(item({ id: '1', anchor: anchor(0, 4, 'beta') }))).toBe(true);
    expect(isReconcilableSpecFeedback(item({ id: '2' }))).toBe(false);
    expect(isReconcilableSpecFeedback(item({ id: '3', anchor: anchor(0, 4) }))).toBe(false);
    expect(isReconcilableSpecFeedback(item({ id: '4', target: 'implementation', anchor: anchor(0, 4, 'beta') }))).toBe(false);
  });
});

describe('reconcileSpecFeedback', () => {
  const markdown = 'alpha beta gamma';

  function deps(overrides: Partial<ReconcileSpecFeedbackDependencies> = {}): ReconcileSpecFeedbackDependencies {
    return {
      runId: 'run_1',
      readCurrentSpec: async () => ({ artifactId: 'art_1', markdown }),
      ...overrides
    };
  }

  it('does not read the spec when no eligible anchor exists', async () => {
    const readCurrentSpec = vi.fn(async () => ({ artifactId: 'art_1', markdown }));
    const items = [item({ id: '1' }), item({ id: '2', anchor: anchor(0, 4) })];
    const result = await reconcileSpecFeedback(items, deps({ readCurrentSpec }));
    expect(readCurrentSpec).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it('returns unchanged matching anchors without persisting', async () => {
    const persistRepairedOffsets = vi.fn(async () => {});
    const result = await reconcileSpecFeedback([item({ id: '1', anchor: anchor(6, 10, 'beta') })], deps({ persistRepairedOffsets }));
    expect(persistRepairedOffsets).not.toHaveBeenCalled();
    expect(result[0]?.anchor).toEqual(anchor(6, 10, 'beta'));
  });

  it('persists repaired offsets and returns the repaired anchor', async () => {
    const persistRepairedOffsets = vi.fn(async () => {});
    const result = await reconcileSpecFeedback([item({ id: 'fb_1', anchor: anchor(0, 5, 'gamma') })], deps({ persistRepairedOffsets }));
    expect(persistRepairedOffsets).toHaveBeenCalledWith({ feedbackId: 'fb_1', from: 11, to: 16 });
    expect(result[0]?.anchor).toMatchObject({ from: 11, to: 16 });
    expect(result[0]?.anchor && 'stale' in result[0].anchor).toBe(false);
  });

  it('marks missing quotes stale, persists nothing, and leaves status/thread intact', async () => {
    const persistRepairedOffsets = vi.fn(async () => {});
    const original = item({ id: 'fb_1', status: 'resolved', anchor: anchor(0, 5, 'absent') });
    const result = await reconcileSpecFeedback([original], deps({ persistRepairedOffsets }));
    expect(persistRepairedOffsets).not.toHaveBeenCalled();
    expect(result[0]?.anchor).toMatchObject({ stale: true, from: 0, to: 5 });
    expect(result[0]?.status).toBe('resolved');
    expect(result[0]?.thread).toEqual(original.thread);
  });

  it('reconciles resolved and non-open items too', async () => {
    const result = await reconcileSpecFeedback([
      item({ id: 'a', status: 'resolved', anchor: anchor(0, 5, 'gamma') }),
      item({ id: 'b', status: 'wont_fix', anchor: anchor(0, 5, 'absent') })
    ], deps());
    expect(result[0]?.anchor).toMatchObject({ from: 11, to: 16 });
    expect(result[1]?.anchor).toMatchObject({ stale: true });
  });

  it('degrades to stored, unreconciled items when the spec cannot be read', async () => {
    const persistRepairedOffsets = vi.fn(async () => {});
    const warn = vi.fn();
    const result = await reconcileSpecFeedback(
      [item({ id: 'fb_1', anchor: anchor(0, 5, 'gamma') })],
      deps({ readCurrentSpec: async () => null, persistRepairedOffsets, logger: { warn } })
    );
    expect(persistRepairedOffsets).not.toHaveBeenCalled();
    expect(result[0]?.anchor).toEqual(anchor(0, 5, 'gamma'));
    expect(result[0]?.anchor && 'stale' in result[0].anchor).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('repairs a previously-stale anchor when the quote returns on a later read', async () => {
    // First read: quote absent → stale.
    const stale = await reconcileSpecFeedback([item({ id: 'fb_1', anchor: anchor(0, 5, 'gamma') })], deps({ readCurrentSpec: async () => ({ artifactId: 'art_1', markdown: 'no match here' }) }));
    expect(stale[0]?.anchor).toMatchObject({ stale: true });
    // Later read: quote returns → repaired, no stale.
    const repaired = await reconcileSpecFeedback([item({ id: 'fb_1', anchor: anchor(0, 5, 'gamma') })], deps());
    expect(repaired[0]?.anchor).toMatchObject({ from: 11, to: 16 });
    expect(repaired[0]?.anchor && 'stale' in repaired[0].anchor).toBe(false);
  });
});
