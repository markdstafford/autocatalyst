/**
 * Spec review surface: rendering, marker/card pairing, groups, and the full composer lifecycle
 * (keyboard-opened selection, submit with the stored anchor even after the DOM selection clears,
 * duplicate-submit prevention, 422 reread, too-long refusal, and read-only away from the gate).
 */
import type { FeedbackResponse, ResponseFeedbackAnchor } from '@autocatalyst/api-contract';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  SpecReview,
  type CreateCommentInput,
  type CreateCommentResult
} from './spec-review.js';

const MARKDOWN = '# Heading\n\nAlpha paragraph here.\n\nBeta paragraph here.';
const NOW = '2026-11-08T01:00:00.000Z';

function feedback(overrides: Partial<FeedbackResponse> & { id: string }): FeedbackResponse {
  return {
    id: overrides.id,
    runId: 'run-1',
    owner: { id: 'user-1', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' },
    tenant: 'tenant-1',
    target: 'artifact',
    status: 'open',
    title: 'Title',
    body: 'Body text',
    thread: [{ id: 't1', author: { id: 'user-1', kind: 'human', tenantId: 'tenant-1' }, body: 'Body text', createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as FeedbackResponse;
}

function range(from: number, to: number, extra?: Partial<ResponseFeedbackAnchor>): ResponseFeedbackAnchor {
  return { kind: 'artifact_range', artifactId: 'artifact-1', from, to, quotedText: 'Alpha', ...extra } as ResponseFeedbackAnchor;
}

function alphaOffsets(): { from: number; to: number } {
  const from = [...MARKDOWN.slice(0, MARKDOWN.indexOf('Alpha'))].length;
  return { from, to: from + 'Alpha paragraph here.'.length };
}

interface Harness {
  readonly root: HTMLElement;
  readonly onCreateComment: ReturnType<typeof vi.fn>;
  readonly onReloadNeeded: ReturnType<typeof vi.fn>;
}

function renderReview(options?: {
  feedback?: FeedbackResponse[];
  canComment?: boolean;
  createResult?: CreateCommentResult;
}): Harness {
  const onCreateComment = vi.fn(async (_input: CreateCommentInput): Promise<CreateCommentResult> => options?.createResult ?? { status: 'created' });
  const onReloadNeeded = vi.fn();
  const { container } = render(
    <SpecReview
      markdown={MARKDOWN}
      artifactId="artifact-1"
      feedback={options?.feedback ?? []}
      canComment={options?.canComment ?? true}
      onCreateComment={onCreateComment}
      onReloadNeeded={onReloadNeeded}
      nowIso={NOW}
    />
  );
  return { root: container as HTMLElement, onCreateComment, onReloadNeeded };
}

/** Select rendered text by its first occurrence and fire a selectionchange (mouse or keyboard). */
async function selectText(root: HTMLElement, needle: string): Promise<void> {
  const doc = root.querySelector('[data-spec-document]') as HTMLElement;
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  let offset = -1;
  let current = walker.nextNode();
  while (current !== null) {
    const idx = (current as Text).data.indexOf(needle);
    if (idx >= 0) {
      node = current as Text;
      offset = idx;
      break;
    }
    current = walker.nextNode();
  }
  if (node === null) {
    throw new Error(`needle not found: ${needle}`);
  }
  const domRange = document.createRange();
  domRange.setStart(node, offset);
  domRange.setEnd(node, offset + needle.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(domRange);
  document.dispatchEvent(new Event('selectionchange'));
  // Wait past the debounce.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320));
  });
}

describe('SpecReview — rendering and groups', () => {
  it('shows the empty hint when there are no comments', () => {
    const { root } = renderReview();
    expect(within(root).getByTestId('comment-empty-hint')).toBeDefined();
  });

  it('renders an anchored card and a marker for an in-bounds comment', () => {
    const { from, to } = alphaOffsets();
    const { root } = renderReview({ feedback: [feedback({ id: 'c1', anchor: range(from, to) })] });
    expect(root.querySelector('[data-card-for="c1"]')).not.toBeNull();
    expect(root.querySelector('[data-marker-for="c1"]')).not.toBeNull();
  });

  it('draws open markers for open comments and resolved markers otherwise', () => {
    const { from, to } = alphaOffsets();
    const { root } = renderReview({
      feedback: [
        feedback({ id: 'open', anchor: range(from, to) }),
        feedback({ id: 'done', status: 'resolved', anchor: range(from + 1, to) })
      ]
    });
    expect(root.querySelector('[data-marker-for="open"]')?.getAttribute('data-marker-style')).toBe('open');
    expect(root.querySelector('[data-marker-for="done"]')?.getAttribute('data-marker-style')).toBe('resolved');
  });

  it('shows stale and no-range groups when present', () => {
    const { root } = renderReview({
      feedback: [
        feedback({ id: 'stale', anchor: range(5, 10, { stale: true }) }),
        feedback({ id: 'norange', anchor: undefined })
      ]
    });
    expect(within(root).getByTestId('comment-group-stale')).toBeDefined();
    expect(within(root).getByTestId('comment-group-no-range')).toBeDefined();
    expect(within(root).getByTestId('stale-chip')).toBeDefined();
  });

  it('pairs a marker click to its card and vice versa', () => {
    const { from, to } = alphaOffsets();
    const { root } = renderReview({ feedback: [feedback({ id: 'c1', anchor: range(from, to) })] });
    fireEvent.click(root.querySelector('[data-marker-for="c1"]') as HTMLElement);
    expect(root.querySelector('[data-card-for="c1"]')?.getAttribute('data-selected')).toBe('true');
  });
});

describe('SpecReview — composer', () => {
  it('opens the composer for a keyboard/mouse selection at the gate', async () => {
    const { root } = renderReview();
    await selectText(root, 'Alpha paragraph here.');
    expect(within(root).getByTestId('composer')).toBeDefined();
    expect((within(root).getByTestId('composer-quote') as HTMLElement).textContent).toBe('Alpha paragraph here.');
  });

  it('does not open the composer away from the spec gate', async () => {
    const { root } = renderReview({ canComment: false });
    await selectText(root, 'Alpha paragraph here.');
    expect(within(root).queryByTestId('composer')).toBeNull();
  });

  it('refuses a selection longer than the quoted-text maximum', async () => {
    const longMarkdown = `x${'a'.repeat(2100)}`;
    const onCreateComment = vi.fn(async (): Promise<CreateCommentResult> => ({ status: 'created' }));
    const { container } = render(
      <SpecReview
        markdown={longMarkdown}
        artifactId="artifact-1"
        feedback={[]}
        canComment
        onCreateComment={onCreateComment}
        onReloadNeeded={vi.fn()}
        nowIso={NOW}
      />
    );
    const root = container as HTMLElement;
    await selectText(root, 'a'.repeat(2100));
    expect(within(root).getByTestId('composer-too-long')).toBeDefined();
    expect(onCreateComment).not.toHaveBeenCalled();
  });

  it('submits the stored anchor even after the DOM selection is cleared', async () => {
    const { root, onCreateComment } = renderReview();
    await selectText(root, 'Alpha paragraph here.');
    // Focus moving into the textarea clears the live selection.
    window.getSelection()?.removeAllRanges();
    fireEvent.change(within(root).getByTestId('composer-textarea'), { target: { value: 'Please clarify' } });
    await act(async () => {
      fireEvent.click(within(root).getByTestId('composer-submit'));
    });
    expect(onCreateComment).toHaveBeenCalledTimes(1);
    const input = onCreateComment.mock.calls[0]?.[0] as CreateCommentInput;
    const { from, to } = alphaOffsets();
    expect(input.from).toBe(from);
    expect(input.to).toBe(to);
    expect(input.quotedText).toBe('Alpha paragraph here.');
    expect(input.title).toBe('Please clarify');
    expect(input.body).toBe('Please clarify');
  });

  it('submits with Cmd+Enter and closes on success', async () => {
    const { root, onCreateComment } = renderReview();
    await selectText(root, 'Alpha paragraph here.');
    fireEvent.change(within(root).getByTestId('composer-textarea'), { target: { value: 'Looks good' } });
    await act(async () => {
      fireEvent.keyDown(within(root).getByTestId('composer'), { key: 'Enter', metaKey: true });
    });
    expect(onCreateComment).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(root).queryByTestId('composer')).toBeNull());
  });

  it('keeps the draft and rereads on an invalid anchor (422)', async () => {
    const { root, onCreateComment, onReloadNeeded } = renderReview({ createResult: { status: 'invalid_anchor' } });
    await selectText(root, 'Alpha paragraph here.');
    fireEvent.change(within(root).getByTestId('composer-textarea'), { target: { value: 'Draft text' } });
    await act(async () => {
      fireEvent.click(within(root).getByTestId('composer-submit'));
    });
    expect(onCreateComment).toHaveBeenCalledTimes(1);
    expect(onReloadNeeded).toHaveBeenCalledTimes(1);
    expect(within(root).getByTestId('composer')).toBeDefined();
    expect((within(root).getByTestId('composer-textarea') as HTMLTextAreaElement).value).toBe('Draft text');
    expect(within(root).getByTestId('composer-message').textContent).toContain('changed');
  });

  it('closes and discards the draft when the run leaves the gate', async () => {
    const { from, to } = alphaOffsets();
    const onCreateComment = vi.fn(async (): Promise<CreateCommentResult> => ({ status: 'created' }));
    const { rerender, container } = render(
      <SpecReview markdown={MARKDOWN} artifactId="artifact-1" feedback={[]} canComment onCreateComment={onCreateComment} onReloadNeeded={vi.fn()} nowIso={NOW} />
    );
    const root = container as HTMLElement;
    await selectText(root, 'Alpha paragraph here.');
    expect(within(root).getByTestId('composer')).toBeDefined();
    rerender(
      <SpecReview markdown={MARKDOWN} artifactId="artifact-1" feedback={[feedback({ id: 'c1', anchor: range(from, to) })]} canComment={false} onCreateComment={onCreateComment} onReloadNeeded={vi.fn()} nowIso={NOW} />
    );
    expect(within(root).queryByTestId('composer')).toBeNull();
  });
});
