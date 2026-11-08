import type { FeedbackResponse, ResponseFeedbackAnchor } from '@autocatalyst/api-contract';
import { describe, expect, it } from 'vitest';

import { classifySpecFeedback, hasOutOfBoundsArtifactAnchors, markerStyleForStatus } from './spec-comments.js';

function feedback(overrides: Partial<FeedbackResponse> & { id: string }): FeedbackResponse {
  return {
    id: overrides.id,
    runId: 'run-1',
    owner: { id: 'user-1', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' },
    tenant: 'tenant-1',
    target: 'artifact',
    status: 'open',
    title: 'A title',
    body: 'A body',
    thread: [{ id: 't1', author: { id: 'user-1', kind: 'human', tenantId: 'tenant-1' }, body: 'A body', createdAt: '2026-11-08T00:00:00.000Z' }],
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    ...overrides
  } as FeedbackResponse;
}

function artifactRange(from: number, to: number, extra?: Partial<ResponseFeedbackAnchor>): ResponseFeedbackAnchor {
  return { kind: 'artifact_range', artifactId: 'artifact-1', from, to, quotedText: 'quote', ...extra } as ResponseFeedbackAnchor;
}

describe('classifySpecFeedback', () => {
  it('keeps only artifact feedback', () => {
    const result = classifySpecFeedback(
      [feedback({ id: 'a', anchor: artifactRange(0, 5) }), feedback({ id: 'b', target: 'pr', anchor: undefined })],
      100
    );
    expect(result.anchored.map((c) => c.id)).toEqual(['a']);
    expect(result.noRange).toHaveLength(0);
  });

  it('anchors in-bounds artifact_range comments in document order', () => {
    const result = classifySpecFeedback(
      [feedback({ id: 'late', anchor: artifactRange(40, 50) }), feedback({ id: 'early', anchor: artifactRange(5, 10) })],
      100
    );
    expect(result.anchored.map((c) => c.id)).toEqual(['early', 'late']);
    expect(result.anchored[0]?.from).toBe(5);
  });

  it('places stale anchors in the stale group with their quote', () => {
    const result = classifySpecFeedback([feedback({ id: 's', anchor: artifactRange(5, 10, { stale: true }) })], 100);
    expect(result.anchored).toHaveLength(0);
    expect(result.stale.map((c) => c.id)).toEqual(['s']);
    expect(result.stale[0]?.quotedText).toBe('quote');
  });

  it('treats out-of-bounds anchors as stale', () => {
    const result = classifySpecFeedback([feedback({ id: 'oob', anchor: artifactRange(90, 200) })], 100);
    expect(result.stale.map((c) => c.id)).toEqual(['oob']);
  });

  it('places missing and non-range anchors in the no-range group', () => {
    const result = classifySpecFeedback(
      [
        feedback({ id: 'none', anchor: undefined }),
        feedback({ id: 'artifact', anchor: { kind: 'artifact', artifactId: 'artifact-1' } as ResponseFeedbackAnchor })
      ],
      100
    );
    expect(result.noRange.map((c) => c.id).sort()).toEqual(['artifact', 'none']);
  });

  it('exposes replies after the first thread entry', () => {
    const result = classifySpecFeedback(
      [
        feedback({
          id: 'r',
          anchor: artifactRange(0, 5),
          thread: [
            { id: 't1', author: { id: 'u', kind: 'human', tenantId: 'tenant-1' }, body: 'first', createdAt: '2026-11-08T00:00:00.000Z' },
            { id: 't2', author: { id: 'u', kind: 'human', tenantId: 'tenant-1' }, body: 'reply', createdAt: '2026-11-08T00:01:00.000Z' }
          ]
        })
      ],
      100
    );
    expect(result.anchored[0]?.replies.map((r) => r.body)).toEqual(['reply']);
  });

  it('falls back to the author id when there is no display name', () => {
    const result = classifySpecFeedback(
      [feedback({ id: 'x', anchor: artifactRange(0, 5), owner: { id: 'user-9', kind: 'human', tenantId: 'tenant-1' } })],
      100
    );
    expect(result.anchored[0]?.authorName).toBe('user-9');
  });
});

describe('hasOutOfBoundsArtifactAnchors', () => {
  it('is true when an anchor exceeds the markdown length', () => {
    expect(hasOutOfBoundsArtifactAnchors([feedback({ id: 'o', anchor: artifactRange(90, 200) })], 100)).toBe(true);
  });

  it('ignores already-stale anchors', () => {
    expect(hasOutOfBoundsArtifactAnchors([feedback({ id: 'o', anchor: artifactRange(90, 200, { stale: true }) })], 100)).toBe(false);
  });

  it('is false when all anchors fit', () => {
    expect(hasOutOfBoundsArtifactAnchors([feedback({ id: 'o', anchor: artifactRange(0, 5) })], 100)).toBe(false);
  });
});

describe('markerStyleForStatus', () => {
  it('maps open to open and the rest to resolved', () => {
    expect(markerStyleForStatus('open')).toBe('open');
    expect(markerStyleForStatus('addressed')).toBe('resolved');
    expect(markerStyleForStatus('resolved')).toBe('resolved');
    expect(markerStyleForStatus('wont_fix')).toBe('resolved');
  });
});
