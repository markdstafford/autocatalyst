/**
 * Inverse of the selection mapper: turn a source code-point range `[from, to)` into a DOM Range in
 * the rendered document, so markers and the composer's pending highlight can be drawn over the
 * exact rendered text an anchor covers. Because it walks the same `data-sr-*` runs, it survives
 * Shiki splitting a code line into coloured spans.
 */
import { codePointOffsetToUtf16Index } from './code-points.js';
import { readRunRange, SR_START_ATTR } from './spec-runs.js';

type BoundarySide = 'start' | 'end';

interface DomPoint {
  node: Node;
  offset: number;
}

/** Build a DOM Range covering source `[from, to)`, or null if it cannot be resolved. */
export function sourceRangeToDomRange(documentRoot: HTMLElement, from: number, to: number): Range | null {
  if (from >= to) {
    return null;
  }
  const runs = [...documentRoot.querySelectorAll<HTMLElement>(`[${SR_START_ATTR}]`)].filter(
    (run) => readRunRange(run) !== null
  );
  if (runs.length === 0) {
    return null;
  }
  const start = locatePoint(runs, from, 'start');
  const end = locatePoint(runs, to, 'end');
  if (start === null || end === null) {
    return null;
  }
  const range = documentRoot.ownerDocument.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  if (range.collapsed) {
    return null;
  }
  return range;
}

/** Client rectangles for a source range, relative to the given container's box. */
export function sourceRangeRects(
  documentRoot: HTMLElement,
  container: HTMLElement,
  from: number,
  to: number
): Array<{ top: number; left: number; width: number; height: number }> {
  const range = sourceRangeToDomRange(documentRoot, from, to);
  if (range === null) {
    return [];
  }
  // jsdom does not implement Range.getClientRects; with no layout there is no geometry to report.
  if (typeof range.getClientRects !== 'function' || typeof container.getBoundingClientRect !== 'function') {
    return [];
  }
  const base = container.getBoundingClientRect();
  return [...range.getClientRects()].map((rect) => ({
    top: rect.top - base.top + container.scrollTop,
    left: rect.left - base.left + container.scrollLeft,
    width: rect.width,
    height: rect.height
  }));
}

function locatePoint(runs: readonly HTMLElement[], cp: number, side: BoundarySide): DomPoint | null {
  // Prefer the run that contains cp. For the start side a boundary belongs to the following run; for
  // the end side it belongs to the preceding run.
  for (const run of runs) {
    const range = readRunRange(run);
    if (range === null) {
      continue;
    }
    const containsStart = range.start <= cp && cp < range.end;
    const containsEnd = range.start < cp && cp <= range.end;
    if ((side === 'start' && containsStart) || (side === 'end' && containsEnd)) {
      if (range.kind === 'opaque') {
        return side === 'start' ? { node: run, offset: 0 } : { node: run, offset: run.childNodes.length };
      }
      return pointInIdentityRun(run, cp - range.start);
    }
  }
  // cp sits between runs (hidden syntax). Snap to the nearest run boundary in the right direction.
  if (side === 'start') {
    for (const run of runs) {
      const range = readRunRange(run);
      if (range !== null && range.start >= cp) {
        return { node: run, offset: 0 };
      }
    }
    const last = runs[runs.length - 1];
    return last !== undefined ? { node: last, offset: last.childNodes.length } : null;
  }
  let candidate: HTMLElement | null = null;
  for (const run of runs) {
    const range = readRunRange(run);
    if (range !== null && range.end <= cp) {
      candidate = run;
    }
  }
  if (candidate !== null) {
    return { node: candidate, offset: candidate.childNodes.length };
  }
  const first = runs[0];
  return first !== undefined ? { node: first, offset: 0 } : null;
}

/** Resolve a UTF-16 offset within an identity run to a concrete (text node, offset) DOM point. */
function pointInIdentityRun(run: HTMLElement, codePointWithinRun: number): DomPoint {
  const runText = run.textContent ?? '';
  const targetUtf16 = codePointOffsetToUtf16Index(runText, codePointWithinRun);
  const walker = run.ownerDocument.createTreeWalker(run, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let current = walker.nextNode();
  let lastText: Text | null = null;
  while (current !== null) {
    const textNode = current as Text;
    lastText = textNode;
    const length = textNode.data.length;
    if (targetUtf16 <= consumed + length) {
      return { node: textNode, offset: targetUtf16 - consumed };
    }
    consumed += length;
    current = walker.nextNode();
  }
  if (lastText !== null) {
    return { node: lastText, offset: lastText.data.length };
  }
  return { node: run, offset: 0 };
}
