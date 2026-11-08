/**
 * The Spec review surface: the rendered document, anchored/stale/no-range comments, and the
 * selection-driven composer.
 *
 * Data in: the spec `markdown`, the target `artifactId`, the reconciled `feedback` list, and whether
 * the run is at the spec gate (`canComment`). Behaviour out: `onCreateComment` (the SDK write, owned
 * by the caller) and `onReloadNeeded` (reread spec+feedback after an invalid anchor). The component
 * owns only view state: which comment is selected and the composer.
 *
 * Anchoring rules live in the pure modules this composes: `selection-source-map` (DOM Range →
 * source anchor), `source-to-dom` (anchor → DOM rects for markers and the pending highlight), and
 * `spec-comments` (grouping). The composer stores its anchor when it opens and never reads the live
 * selection again, so moving focus into the textarea (which clears the DOM selection) cannot change
 * what is submitted.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { codePointLength } from './code-points.js';
import {
  classifySpecFeedback,
  markerStyleForStatus,
  type AnchoredComment,
  type NoRangeComment,
  type SpecCommentBase,
  type StaleComment
} from './spec-comments.js';
import { mapSelectionToSourceAnchor, type SpecAnchorCandidate } from './selection-source-map.js';
import { sourceRangeRects } from './source-to-dom.js';
import { SpecDocument } from './spec-render.js';
import { firstLineTitle } from './spec-title.js';
import { formatAge } from '../../runs/run-fields.js';

/** The maximum quotedText length the API accepts, counted as JavaScript string length. */
export const MAX_QUOTED_TEXT_LENGTH = 2000;

const SELECTION_DEBOUNCE_MS = 250;

export interface CreateCommentInput {
  readonly from: number;
  readonly to: number;
  readonly quotedText: string;
  readonly title: string;
  readonly body: string;
}

export type CreateCommentResult =
  | { readonly status: 'created' }
  | { readonly status: 'invalid_anchor' }
  | { readonly status: 'error'; readonly message: string };

export interface SpecReviewProps {
  readonly markdown: string;
  readonly artifactId: string;
  readonly feedback: readonly import('@autocatalyst/api-contract').FeedbackResponse[];
  /** True only while the run is waiting at spec.human_review. */
  readonly canComment: boolean;
  onCreateComment(input: CreateCommentInput): Promise<CreateCommentResult>;
  /** Reread spec + feedback (after an invalid anchor, or an out-of-bounds returned offset). */
  onReloadNeeded(): void;
  /** Test/display seam for comment ages; defaults to the current time. */
  readonly nowIso?: string;
}

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

type ComposerState =
  | { readonly mode: 'edit'; readonly anchor: SpecAnchorCandidate; readonly body: string; readonly busy: boolean; readonly message?: string }
  | { readonly mode: 'too-long' };

export function SpecReview(props: SpecReviewProps): ReactNode {
  const { markdown, feedback, canComment, onCreateComment, onReloadNeeded } = props;
  const nowIso = props.nowIso ?? new Date().toISOString();
  const markdownLength = codePointLength(markdown);
  const groups = classifySpecFeedback(feedback, markdownLength);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  const [markerRects, setMarkerRects] = useState<Map<string, Rect[]>>(new Map());
  const [pendingRects, setPendingRects] = useState<Rect[]>([]);
  const [cardTops, setCardTops] = useState<Map<string, number>>(new Map());

  const composerRef = useRef<ComposerState | null>(composer);
  composerRef.current = composer;

  const docRoot = (): HTMLElement | null =>
    wrapperRef.current?.querySelector<HTMLElement>('[data-spec-document]') ?? null;

  // When the run leaves the spec gate, close the composer and discard the draft.
  useEffect(() => {
    if (!canComment) {
      setComposer(null);
    }
  }, [canComment]);

  // Selection-driven composer: open after a debounced selectionchange while at the gate.
  useEffect(() => {
    if (!canComment) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSelectionChange = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(evaluateSelection, SELECTION_DEBOUNCE_MS);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canComment, markdown]);

  function evaluateSelection(): void {
    const root = docRoot();
    if (root === null) {
      return;
    }
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
      // A collapsed selection (a click, or focus moving into the textarea) must not close an open
      // composer; the composer keeps the anchor it captured.
      return;
    }
    // Ignore selections that are not entirely inside the document (comment column, composer, header).
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (anchorNode === null || focusNode === null || !root.contains(anchorNode) || !root.contains(focusNode)) {
      return;
    }
    const candidate = mapSelectionToSourceAnchor(markdown, root, selection);
    if (candidate === null) {
      return;
    }
    if (candidate.quotedText.length > MAX_QUOTED_TEXT_LENGTH) {
      setComposer({ mode: 'too-long' });
      return;
    }
    setComposer({ mode: 'edit', anchor: candidate, body: '', busy: false });
  }

  // Recompute marker / pending / card geometry after render and on resize, Shiki load, theme change.
  useLayoutEffect(() => {
    const root = docRoot();
    const container = wrapperRef.current?.querySelector<HTMLElement>('[data-doc-column]') ?? null;
    if (root === null || container === null) {
      return;
    }
    const nextMarkers = new Map<string, Rect[]>();
    for (const comment of groups.anchored) {
      nextMarkers.set(comment.id, sourceRangeRects(root, container, comment.from, comment.to));
    }
    setMarkerRects(nextMarkers);

    const current = composerRef.current;
    setPendingRects(
      current !== null && current.mode === 'edit'
        ? sourceRangeRects(root, container, current.anchor.from, current.anchor.to)
        : []
    );

    // Card tops: each anchored card sits at its marker's top, pushed down below the previous card.
    const tops = new Map<string, number>();
    let cursor = 0;
    const CARD_GAP = 8;
    const CARD_ESTIMATE = 96;
    for (const comment of groups.anchored) {
      const rects = nextMarkers.get(comment.id) ?? [];
      const anchorTop = rects[0]?.top ?? cursor;
      const top = Math.max(anchorTop, cursor);
      tops.set(comment.id, top);
      cursor = top + CARD_ESTIMATE + CARD_GAP;
    }
    setCardTops(tops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, feedback, composer, selectedId, layoutTick]);

  // Bump the layout tick on container resize and when Shiki rewrites code (mutations under the doc).
  useEffect(() => {
    const container = wrapperRef.current?.querySelector<HTMLElement>('[data-doc-column]') ?? null;
    const root = docRoot();
    if (container === null || root === null) {
      return;
    }
    const bump = (): void => setLayoutTick((tick) => tick + 1);
    const observers: Array<{ disconnect(): void }> = [];
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(bump);
      ro.observe(container);
      observers.push(ro);
    }
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(bump);
      mo.observe(root, { childList: true, subtree: true });
      observers.push(mo);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, [markdown]);

  function selectComment(id: string, scrollTarget: 'marker' | 'card'): void {
    setSelectedId(id);
    const selector = scrollTarget === 'marker' ? `[data-marker-for="${id}"]` : `[data-card-for="${id}"]`;
    const target = wrapperRef.current?.querySelector(selector);
    if (target !== null && target !== undefined && typeof (target as HTMLElement).scrollIntoView === 'function') {
      (target as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }

  async function submitComposer(): Promise<void> {
    const current = composerRef.current;
    if (current === null || current.mode !== 'edit' || current.busy || current.body.trim() === '') {
      return;
    }
    setComposer({ ...current, busy: true, message: undefined });
    const result = await onCreateComment({
      from: current.anchor.from,
      to: current.anchor.to,
      quotedText: current.anchor.quotedText,
      title: firstLineTitle(current.body),
      body: current.body
    });
    const afterSubmit = composerRef.current;
    if (afterSubmit === null || afterSubmit.mode !== 'edit') {
      return;
    }
    if (result.status === 'created') {
      setComposer(null);
      return;
    }
    if (result.status === 'invalid_anchor') {
      onReloadNeeded();
      setComposer({ ...afterSubmit, busy: false, message: 'The spec changed since you selected this text. Review the updated spec and comment again.' });
      return;
    }
    setComposer({ ...afterSubmit, busy: false, message: result.message });
  }

  const hasComments = groups.anchored.length + groups.stale.length + groups.noRange.length > 0;

  return (
    <div ref={wrapperRef} className="flex h-full gap-4">
      <div data-doc-column className="relative min-w-0 flex-1">
        <SpecDocument markdown={markdown} />

        {/* Marker overlay. Shorter ranges render last so they sit on top of longer ones. */}
        <div className="pointer-events-none absolute inset-0">
          {[...groups.anchored]
            .sort((a, b) => b.to - b.from - (a.to - a.from))
            .map((comment) => (
              <MarkerButton
                key={comment.id}
                comment={comment}
                rects={markerRects.get(comment.id) ?? []}
                selected={selectedId === comment.id}
                onSelect={() => selectComment(comment.id, 'card')}
              />
            ))}
          {pendingRects.map((rect, index) => (
            <span
              key={index}
              data-testid="composer-pending-highlight"
              className="absolute rounded-xs bg-[var(--color-comment-selected-bg)]"
              style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
            />
          ))}
        </div>

        {composer !== null ? (
          <Composer
            state={composer}
            rect={pendingRects[0]}
            onChangeBody={(body) => {
              const current = composerRef.current;
              if (current !== null && current.mode === 'edit') {
                setComposer({ ...current, body, message: undefined });
              }
            }}
            onSubmit={() => void submitComposer()}
            onCancel={() => setComposer(null)}
          />
        ) : null}
      </div>

      <div
        data-testid="comment-column"
        style={{ width: 'var(--width-comment-column)' }}
        className="relative shrink-0 overflow-visible"
      >
        {!hasComments ? (
          <p data-testid="comment-empty-hint" className="text-xs text-subtext">
            Select text in the spec to start a comment.
          </p>
        ) : null}

        {groups.anchored.map((comment) => (
          <div
            key={comment.id}
            style={{ position: 'absolute', top: cardTops.get(comment.id) ?? 0, left: 0, right: 0 }}
          >
            <CommentCard
              comment={comment}
              nowIso={nowIso}
              selected={selectedId === comment.id}
              onSelect={() => selectComment(comment.id, 'marker')}
            />
          </div>
        ))}

        {groups.stale.length > 0 ? (
          <section data-testid="comment-group-stale" style={{ position: 'absolute', top: staleGroupTop(cardTops, groups.anchored), left: 0, right: 0 }}>
            <h3 className="mb-1 text-xs font-semibold text-subtext">Stale</h3>
            {groups.stale.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                nowIso={nowIso}
                selected={selectedId === comment.id}
                onSelect={() => setSelectedId(comment.id)}
              />
            ))}
          </section>
        ) : null}

        {groups.noRange.length > 0 ? (
          <section data-testid="comment-group-no-range" style={{ position: 'absolute', top: noRangeGroupTop(cardTops, groups.anchored, groups.stale.length), left: 0, right: 0 }}>
            <h3 className="mb-1 text-xs font-semibold text-subtext">No range</h3>
            {groups.noRange.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                nowIso={nowIso}
                selected={selectedId === comment.id}
                onSelect={() => setSelectedId(comment.id)}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function staleGroupTop(cardTops: Map<string, number>, anchored: readonly AnchoredComment[]): number {
  const last = anchored[anchored.length - 1];
  const base = last !== undefined ? cardTops.get(last.id) ?? 0 : 0;
  return base + (anchored.length > 0 ? 112 : 0);
}

function noRangeGroupTop(cardTops: Map<string, number>, anchored: readonly AnchoredComment[], staleCount: number): number {
  return staleGroupTop(cardTops, anchored) + (staleCount > 0 ? staleCount * 112 + 24 : 0);
}

interface MarkerButtonProps {
  readonly comment: AnchoredComment;
  readonly rects: readonly Rect[];
  readonly selected: boolean;
  onSelect(): void;
}

function MarkerButton({ comment, rects, selected, onSelect }: MarkerButtonProps): ReactNode {
  const style = markerStyleForStatus(comment.status);
  const className = selected
    ? 'bg-[var(--color-comment-selected-bg)] [border-bottom:2px_solid_var(--color-primary)]'
    : style === 'open'
      ? 'bg-[var(--color-comment-open-bg)] [border-bottom:2px_solid_var(--color-comment-open-line)]'
      : 'bg-[var(--color-comment-resolved-bg)]';
  // One clickable box per client rect; in a headless DOM with no layout there are none, so a single
  // zero-size hit target is still rendered so marker/card pairing works in component tests.
  const boxes = rects.length > 0 ? rects : [{ top: 0, left: 0, width: 0, height: 0 }];
  return (
    <>
      {boxes.map((rect, index) => (
        <button
          key={index}
          type="button"
          data-marker-for={comment.id}
          data-marker-style={selected ? 'selected' : style}
          aria-label={`Comment by ${comment.authorName}`}
          onClick={onSelect}
          className={`pointer-events-auto absolute rounded-xs transition-colors duration-[var(--duration-enter)] ${className}`}
          style={{ top: rect.top, left: rect.left, width: rect.width, height: Math.max(rect.height, 1) }}
        />
      ))}
    </>
  );
}

interface CommentCardProps {
  readonly comment: AnchoredComment | StaleComment | NoRangeComment;
  readonly nowIso: string;
  readonly selected: boolean;
  onSelect(): void;
}

function CommentCard({ comment, nowIso, selected, onSelect }: CommentCardProps): ReactNode {
  const resolved = comment.status !== 'open';
  const outlineClass = selected ? 'border-primary shadow-popover' : 'border-border-subtle';
  const dimClass = resolved && comment.kind !== 'anchored' ? '' : resolved ? 'opacity-80' : '';
  return (
    <button
      type="button"
      data-card-for={comment.id}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      className={`mb-2 block w-full rounded-sm border bg-mantle p-2 text-left text-sm ${outlineClass} ${dimClass}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-text">{comment.authorName}</span>
        <span className="text-xs text-subtext">{formatAge(comment.createdAt, nowIso)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <StatusChip status={comment.status} />
        {comment.kind === 'stale' ? <span data-testid="stale-chip" className="rounded-xs bg-mantle px-1 text-xs text-subtext">stale</span> : null}
      </div>
      {comment.quotedText !== undefined && comment.quotedText !== '' ? (
        <p className="mt-1 border-l-2 border-border pl-2 text-xs italic text-subtext">{comment.quotedText}</p>
      ) : null}
      <p className="mt-1 whitespace-pre-wrap text-text">{comment.body}</p>
      {comment.replies.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-border-subtle pt-1">
          {comment.replies.map((reply) => (
            <p key={reply.id} className="text-xs text-subtext">
              <span className="font-medium">{reply.author.displayName ?? reply.author.id}: </span>
              {reply.body}
            </p>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function StatusChip({ status }: { status: SpecCommentBase['status'] }): ReactNode {
  const tone = status === 'open' ? 'text-primary' : 'text-green';
  return (
    <span data-testid="status-chip" className={`rounded-xs border border-border px-1 text-xs ${tone}`}>
      {status}
    </span>
  );
}

interface ComposerProps {
  readonly state: ComposerState;
  readonly rect: Rect | undefined;
  onChangeBody(body: string): void;
  onSubmit(): void;
  onCancel(): void;
}

function Composer({ state, rect, onChangeBody, onSubmit, onCancel }: ComposerProps): ReactNode {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const top = (rect?.top ?? 0) + (rect?.height ?? 0) + 4;
  const left = rect?.left ?? 0;

  if (state.mode === 'too-long') {
    return (
      <div
        data-testid="composer-too-long"
        role="dialog"
        className="absolute z-10 w-64 rounded-sm border border-primary bg-background p-2 text-sm shadow-popover"
        style={{ top, left }}
      >
        <p className="text-subtext">That selection is too long to quote. Select a shorter passage.</p>
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={onCancel} className="rounded-sm border border-border px-2 py-1 text-xs">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const disabled = state.body.trim() === '' || state.busy;
  return (
    <div
      data-testid="composer"
      role="dialog"
      aria-label="New spec comment"
      className="absolute z-10 w-72 rounded-sm border border-primary bg-background p-2 shadow-popover"
      style={{ top, left }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          onSubmit();
        }
      }}
    >
      <p data-testid="composer-quote" className="mb-1 border-l-2 border-border pl-2 text-xs italic text-subtext">
        {state.anchor.quotedText}
      </p>
      <textarea
        ref={textareaRef}
        data-testid="composer-textarea"
        aria-label="Comment"
        value={state.body}
        onChange={(event) => onChangeBody(event.target.value)}
        rows={3}
        className="w-full rounded-sm border border-border bg-surface p-1 text-sm"
      />
      {state.message !== undefined ? (
        <p data-testid="composer-message" className="mt-1 text-xs text-red">
          {state.message}
        </p>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-sm border border-border px-2 py-1 text-xs">
          Cancel
        </button>
        <button
          type="button"
          data-testid="composer-submit"
          onClick={onSubmit}
          disabled={disabled}
          aria-busy={state.busy}
          className="rounded-sm bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-50"
        >
          Comment
        </button>
      </div>
    </div>
  );
}
