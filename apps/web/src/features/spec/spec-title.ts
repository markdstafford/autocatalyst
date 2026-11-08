/**
 * Derive a feedback title from the comment body: the first non-empty line, trimmed and cut to 80
 * Unicode code points (the control-plane title bound), with a fallback so the title is never empty.
 */
import { sliceByCodePoints } from './code-points.js';

export function firstLineTitle(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim() !== '') ?? body;
  const trimmed = firstLine.trim();
  const cut = sliceByCodePoints(trimmed, 0, 80).trim();
  return cut.length > 0 ? cut : 'Comment';
}
