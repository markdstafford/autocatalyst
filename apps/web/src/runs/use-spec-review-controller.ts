/**
 * The pane-level spec-review controller: the single owner of comment selection, document-order
 * navigation, scroll/flash requests, open/resolved counts, and the resolve/reopen lifecycle action
 * state. Lifting this above `SpecReview` lets the pane, the shell footer, and the expanded overlay
 * all read one source of truth, so a selection or a resolved comment made in one surface is visible
 * in the others (ADR-031: the client stays stateless; this holds only view state).
 *
 * Navigation order is the same order `SpecReview` renders: anchored comments in document order, then
 * the stale group, then the no-range group. Navigating to an anchored comment scrolls the spec to its
 * marker and flashes it once; navigating to a stale/no-range comment scrolls to its card. `SpecReview`
 * performs the scroll/flash when `navSignal` changes.
 *
 * Lifecycle actions are originator-only and gate-only: Resolve shows on an `addressed` card and Reopen
 * on a `wont_fix` card, but only while the run waits at `spec.human_review` and the loaded current
 * principal matches the card originator (`thread[0].author.id`). Unknown identity hides both. The
 * control plane stays authoritative; 403/409 responses surface as per-card errors.
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { useCallback, useMemo, useRef, useState } from 'react';

import { isSpecGateDecisionAvailable } from './spec-decision.js';
import type { RunActionResult } from './use-run-detail.js';
import { codePointLength } from '../features/spec/code-points.js';
import { classifySpecFeedback } from '../features/spec/spec-comments.js';
import { decisionErrorInfo } from './spec-decision.js';

export type ScrollTarget = 'marker' | 'card';

/** One entry in the document-order navigation list. */
export interface SpecNavItem {
  readonly id: string;
  readonly kind: 'anchored' | 'stale' | 'no-range';
}

/** Per-card lifecycle action state (resolve/reopen). */
export interface CardActionState {
  readonly busy: boolean;
  readonly error?: string;
}

export interface SpecReviewController {
  readonly selectedId: string | null;
  readonly order: readonly SpecNavItem[];
  readonly hasComments: boolean;
  readonly openCount: number;
  readonly resolvedCount: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  /** Bumped on every selection/navigation so `SpecReview` can scroll + flash as a one-shot effect. */
  readonly navSignal: number;
  readonly navTargetId: string | null;
  readonly navTargetKind: ScrollTarget | null;
  select(id: string, scrollTarget: ScrollTarget): void;
  selectNext(): void;
  selectPrevious(): void;
  cardState(id: string): CardActionState;
  canResolve(id: string): boolean;
  canReopen(id: string): boolean;
  resolve(id: string): void;
  reopen(id: string, reason: string): void;
}

export interface UseSpecReviewControllerOptions {
  readonly feedback: readonly FeedbackResponse[];
  readonly markdown: string;
  readonly run: Run;
  readonly currentPrincipalId: string | undefined;
  resolveComment(feedbackId: string): Promise<RunActionResult>;
  reopenComment(feedbackId: string, reason: string): Promise<RunActionResult>;
}

export function useSpecReviewController(options: UseSpecReviewControllerOptions): SpecReviewController {
  const { feedback, markdown, run, currentPrincipalId, resolveComment, reopenComment } = options;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nav, setNav] = useState<{ signal: number; id: string | null; kind: ScrollTarget | null }>({
    signal: 0,
    id: null,
    kind: null
  });
  const [cardStates, setCardStates] = useState<ReadonlyMap<string, CardActionState>>(new Map());

  const groups = useMemo(
    () => classifySpecFeedback(feedback, codePointLength(markdown)),
    [feedback, markdown]
  );

  const order = useMemo<SpecNavItem[]>(() => {
    const items: SpecNavItem[] = [];
    for (const comment of groups.anchored) {
      items.push({ id: comment.id, kind: 'anchored' });
    }
    for (const comment of groups.stale) {
      items.push({ id: comment.id, kind: 'stale' });
    }
    for (const comment of groups.noRange) {
      items.push({ id: comment.id, kind: 'no-range' });
    }
    return items;
  }, [groups]);

  const byId = useMemo(() => {
    const map = new Map<string, FeedbackResponse>();
    for (const item of feedback) {
      map.set(item.id, item);
    }
    return map;
  }, [feedback]);

  const openCount = useMemo(
    () => feedback.filter((item) => item.target === 'artifact' && item.status === 'open').length,
    [feedback]
  );
  const resolvedCount = useMemo(
    () =>
      feedback.filter(
        (item) =>
          item.target === 'artifact' &&
          (item.status === 'addressed' || item.status === 'resolved' || item.status === 'wont_fix')
      ).length,
    [feedback]
  );

  const selectedIndex = order.findIndex((item) => item.id === selectedId);
  const canPrevious = selectedIndex > 0;
  const canNext = order.length > 0 && selectedIndex < order.length - 1;

  const select = useCallback((id: string, scrollTarget: ScrollTarget): void => {
    setSelectedId(id);
    setNav((prev) => ({ signal: prev.signal + 1, id, kind: scrollTarget }));
  }, []);

  const selectAtIndex = useCallback(
    (index: number): void => {
      const item = order[index];
      if (item === undefined) {
        return;
      }
      select(item.id, item.kind === 'anchored' ? 'marker' : 'card');
    },
    [order, select]
  );

  const selectNext = useCallback((): void => {
    selectAtIndex(selectedIndex + 1);
  }, [selectAtIndex, selectedIndex]);

  const selectPrevious = useCallback((): void => {
    if (selectedIndex > 0) {
      selectAtIndex(selectedIndex - 1);
    }
  }, [selectAtIndex, selectedIndex]);

  const atGate = isSpecGateDecisionAvailable(run);

  const canResolve = useCallback(
    (id: string): boolean => {
      if (!atGate || currentPrincipalId === undefined) {
        return false;
      }
      const item = byId.get(id);
      return item?.status === 'addressed' && item.thread[0]?.author.id === currentPrincipalId;
    },
    [atGate, byId, currentPrincipalId]
  );

  const canReopen = useCallback(
    (id: string): boolean => {
      if (!atGate || currentPrincipalId === undefined) {
        return false;
      }
      const item = byId.get(id);
      return item?.status === 'wont_fix' && item.thread[0]?.author.id === currentPrincipalId;
    },
    [atGate, byId, currentPrincipalId]
  );

  const setCardState = useCallback((id: string, next: CardActionState | undefined): void => {
    setCardStates((prev) => {
      const map = new Map(prev);
      if (next === undefined) {
        map.delete(id);
      } else {
        map.set(id, next);
      }
      return map;
    });
  }, []);

  const runningRef = useRef<Set<string>>(new Set());

  const runCardAction = useCallback(
    (id: string, action: () => Promise<RunActionResult>): void => {
      if (runningRef.current.has(id)) {
        return;
      }
      runningRef.current.add(id);
      setCardState(id, { busy: true });
      void (async () => {
        const result = await action();
        runningRef.current.delete(id);
        if (result.status === 'ok') {
          // The refresh replaces the card with its new status; drop the local busy/error state.
          setCardState(id, undefined);
        } else {
          setCardState(id, { busy: false, error: decisionErrorInfo(result.error).message });
        }
      })();
    },
    [setCardState]
  );

  const resolve = useCallback(
    (id: string): void => {
      runCardAction(id, () => resolveComment(id));
    },
    [runCardAction, resolveComment]
  );

  const reopen = useCallback(
    (id: string, reason: string): void => {
      runCardAction(id, () => reopenComment(id, reason));
    },
    [runCardAction, reopenComment]
  );

  const cardState = useCallback(
    (id: string): CardActionState => cardStates.get(id) ?? { busy: false },
    [cardStates]
  );

  return {
    selectedId,
    order,
    hasComments: order.length > 0,
    openCount,
    resolvedCount,
    canPrevious,
    canNext,
    navSignal: nav.signal,
    navTargetId: nav.id,
    navTargetKind: nav.kind,
    select,
    selectNext,
    selectPrevious,
    cardState,
    canResolve,
    canReopen,
    resolve,
    reopen
  };
}
