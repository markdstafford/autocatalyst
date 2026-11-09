/**
 * Unicode code-point helpers for spec source offsets.
 *
 * ADR-033 defines spec anchor offsets as zero-based Unicode **code-point** offsets into the
 * source Markdown string, not JavaScript UTF-16 code units. `"🚀".length` is 2 but the rocket
 * is one code point, so any arithmetic that uses `string.length` as an offset into the spec
 * markdown is wrong the moment the document contains an astral character. Every web module that
 * handles spec source offsets routes through this module; no other `apps/web` file may use
 * `string.length` as an offset into spec markdown.
 *
 * mdast positions (`position.start.offset` / `position.end.offset`) are UTF-16 code-unit
 * indexes. {@link utf16IndexToCodePointOffset} converts them before they become anchor offsets,
 * and {@link codePointOffsetToUtf16Index} converts back when placing a marker over DOM text.
 */

/** Count the Unicode code points in `text`. `codePointLength("🚀")` is 1. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/**
 * Slice `text` by code-point offsets `[from, to)`, never splitting a surrogate pair.
 *
 * `from`/`to` are clamped into `[0, codePointLength(text)]` and a `from` past `to` yields the
 * empty string, so callers cannot accidentally cut an astral character in half.
 */
export function sliceByCodePoints(text: string, from: number, to: number): string {
  const points = Array.from(text);
  const length = points.length;
  const start = clamp(from, 0, length);
  const end = clamp(to, 0, length);
  if (end <= start) {
    return '';
  }
  return points.slice(start, end).join('');
}

/**
 * Convert a UTF-16 code-unit index into the matching code-point offset.
 *
 * The result counts whole code points that lie fully before `index`. An `index` that lands in
 * the middle of a surrogate pair is rounded down to the boundary before that pair (the pair is
 * not yet complete before `index`), so the function never reports a position inside a surrogate.
 * `index` is clamped into `[0, text.length]`.
 */
export function utf16IndexToCodePointOffset(text: string, index: number): number {
  const target = clamp(index, 0, text.length);
  let utf16 = 0;
  let codePoints = 0;
  for (const char of text) {
    const next = utf16 + char.length;
    if (next > target) {
      // `target` falls before this code point completes (identity boundary or mid-surrogate):
      // round down, excluding this code point.
      break;
    }
    utf16 = next;
    codePoints += 1;
  }
  return codePoints;
}

/**
 * Convert a code-point offset into the matching UTF-16 code-unit index.
 *
 * `offset` is clamped into `[0, codePointLength(text)]`; the returned index always sits on a
 * code-point boundary, so it can be used directly with DOM Range offsets.
 */
export function codePointOffsetToUtf16Index(text: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }
  let utf16 = 0;
  let codePoints = 0;
  for (const char of text) {
    if (codePoints >= offset) {
      break;
    }
    utf16 += char.length;
    codePoints += 1;
  }
  return utf16;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
