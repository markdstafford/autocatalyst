import type { Feedback, FeedbackResponse, ResponseFeedbackAnchor } from '@autocatalyst/api-contract';

/**
 * Read-side reconciliation of spec feedback anchors (ADR-033).
 *
 * When feedback is read (list, thread-reply response, PATCH response), anchored spec comments are
 * reconciled against the current spec markdown:
 * - unchanged anchors are returned as-is,
 * - moved quotes have their stored offsets repaired to the first matching occurrence and persisted,
 * - missing quotes are returned with a response-only `stale: true` and nothing is persisted,
 * - legacy anchors without `quotedText` are returned unchanged and never marked stale.
 *
 * Offsets are counted in Unicode code points, never UTF-16 code units.
 */

interface ArtifactRangeAnchor {
  readonly kind: 'artifact_range';
  readonly artifactId: string;
  readonly from: number;
  readonly to: number;
  readonly quotedText?: string;
}

/**
 * True when the item is a spec (artifact-target) comment carrying an `artifact_range` anchor with
 * `quotedText` — the only items eligible for reconciliation. Target-level, non-spec, legacy
 * (quotedText-less), and non-artifact_range anchors are all ineligible.
 */
export function isReconcilableSpecFeedback(item: Feedback): boolean {
  return (
    item.target === 'artifact' &&
    item.anchor !== undefined &&
    item.anchor.kind === 'artifact_range' &&
    typeof (item.anchor as ArtifactRangeAnchor).quotedText === 'string'
  );
}

export type AnchorReconciliation =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'repaired'; readonly from: number; readonly to: number }
  | { readonly kind: 'stale' };

/** Find the first code-point index at which `needle` occurs in `haystackCodePoints`, or -1. */
function indexOfCodePoints(haystackCodePoints: readonly string[], needle: string): number {
  const needleCodePoints = Array.from(needle);
  if (needleCodePoints.length === 0) return -1;
  const limit = haystackCodePoints.length - needleCodePoints.length;
  for (let start = 0; start <= limit; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needleCodePoints.length; offset += 1) {
      if (haystackCodePoints[start + offset] !== needleCodePoints[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/**
 * Compare a stored artifact_range anchor against the current spec markdown. Pure: performs no I/O
 * and no persistence. Callers persist repairs and apply stale decoration from the result.
 */
export function reconcileAnchorAgainstSpec(
  anchor: ArtifactRangeAnchor,
  markdown: string
): AnchorReconciliation {
  const quotedText = anchor.quotedText;
  if (typeof quotedText !== 'string' || quotedText.length === 0) {
    // Legacy anchor without quotedText: never reconciled, never stale.
    return { kind: 'unchanged' };
  }

  const codePoints = Array.from(markdown);
  const n = codePoints.length;

  // Does the stored slice still match the quote exactly?
  if (anchor.from >= 0 && anchor.from < anchor.to && anchor.to <= n) {
    const slice = codePoints.slice(anchor.from, anchor.to).join('');
    if (slice === quotedText) {
      return { kind: 'unchanged' };
    }
  }

  // Search for the first occurrence of the quote elsewhere.
  const found = indexOfCodePoints(codePoints, quotedText);
  if (found === -1) {
    return { kind: 'stale' };
  }
  return { kind: 'repaired', from: found, to: found + Array.from(quotedText).length };
}

export interface ReconcileLogger {
  info?(message: string, details?: unknown): void;
  debug?(message: string, details?: unknown): void;
  warn?(message: string, details?: unknown): void;
}

export interface ReconcileSpecFeedbackDependencies {
  /**
   * Read the current spec once per request. Returns the spec metadata/text, or `null` when the
   * spec cannot be read — in which case the stored items are returned unreconciled (read-side
   * repair is opportunistic; feedback history must stay readable after workspace pruning).
   */
  readonly readCurrentSpec: () => Promise<{ readonly artifactId: string; readonly markdown: string } | null>;
  /**
   * Persist a repaired anchor's `from`/`to` offsets. Optional: when absent (test doubles without
   * the capability), the repaired offsets are still returned in the response but not persisted.
   */
  readonly persistRepairedOffsets?: (input: { readonly feedbackId: string; readonly from: number; readonly to: number }) => Promise<void>;
  readonly runId: string;
  readonly logger?: ReconcileLogger;
}

/**
 * Reconcile a batch of feedback items for a single read response. Reads the current spec at most
 * once, and only when at least one eligible item exists. On read failure, returns stored items
 * unreconciled (no `stale`, no writes) and logs a safe warning with the run id only.
 */
export async function reconcileSpecFeedback(
  items: readonly Feedback[],
  deps: ReconcileSpecFeedbackDependencies
): Promise<readonly FeedbackResponse[]> {
  const eligible = items.some((item) => isReconcilableSpecFeedback(item));
  if (!eligible) {
    // No spec read when nothing is reconcilable (unanchored or legacy-only reads).
    return items as readonly FeedbackResponse[];
  }

  let spec: { readonly artifactId: string; readonly markdown: string } | null;
  try {
    spec = await deps.readCurrentSpec();
  } catch {
    spec = null;
  }
  if (spec === null) {
    deps.logger?.warn?.('Spec unreadable during feedback reconciliation; returning stored anchors unreconciled.', {
      runId: deps.runId
    });
    return items as readonly FeedbackResponse[];
  }

  const markdown = spec.markdown;
  const result: FeedbackResponse[] = [];
  for (const item of items) {
    if (!isReconcilableSpecFeedback(item)) {
      result.push(item as FeedbackResponse);
      continue;
    }
    const anchor = item.anchor as ArtifactRangeAnchor;
    const outcome = reconcileAnchorAgainstSpec(anchor, markdown);
    if (outcome.kind === 'unchanged') {
      result.push(item as FeedbackResponse);
      continue;
    }
    if (outcome.kind === 'repaired') {
      if (deps.persistRepairedOffsets !== undefined) {
        try {
          await deps.persistRepairedOffsets({ feedbackId: item.id, from: outcome.from, to: outcome.to });
        } catch {
          // A persistence failure during opportunistic repair must not fail the read. Return the
          // repaired anchor in the response so clients see the current range anyway.
          deps.logger?.warn?.('Failed to persist repaired spec anchor offsets; returning repaired anchor unpersisted.', {
            runId: deps.runId,
            feedbackId: item.id
          });
        }
      }
      deps.logger?.info?.('Repaired spec anchor offsets on read.', {
        runId: deps.runId,
        feedbackId: item.id,
        from: outcome.from,
        to: outcome.to,
        quotedTextCodePointLength: Array.from(anchor.quotedText ?? '').length
      });
      const repairedAnchor: ResponseFeedbackAnchor = {
        ...anchor,
        from: outcome.from,
        to: outcome.to
      };
      result.push({ ...(item as FeedbackResponse), anchor: repairedAnchor });
      continue;
    }
    // stale
    deps.logger?.debug?.('Spec anchor quote no longer present; marking stale (response-only).', {
      runId: deps.runId,
      feedbackId: item.id
    });
    const staleAnchor: ResponseFeedbackAnchor = { ...anchor, stale: true };
    result.push({ ...(item as FeedbackResponse), anchor: staleAnchor });
  }
  return result;
}
