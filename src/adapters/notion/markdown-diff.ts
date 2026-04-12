// src/adapters/notion/markdown-diff.ts

/**
 * Strip Notion inline comment span tags, preserving the inner text.
 * Only removes spans with discussion-urls attribute (comment anchors).
 */
export function stripCommentSpans(raw: string): string {
  return raw
    .replace(/<span\s[^>]*discussion-urls="[^"]*"[^>]*>([\s\S]*?)<\/span>/g, '$1');
}

export interface CommentSpan {
  uuid: string;       // full discussion-urls value, e.g. "discussion://abc-123"
  inner_text: string;  // text wrapped by the span
}

/**
 * Extract all comment span anchors from markdown content.
 * Returns spans in document order with their discussion-urls UUID and inner text.
 */
export function extractCommentSpans(markdown: string): CommentSpan[] {
  const re = /<span\s[^>]*discussion-urls="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g;
  const spans: CommentSpan[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    spans.push({ uuid: match[1], inner_text: match[2] });
  }
  return spans;
}

/**
 * Ensure all original comment spans are present in the revised content.
 * Missing spans are appended to an "## Orphaned comments" section with
 * a "[dropped by Claude]" tag.
 *
 * Returns content unchanged if no spans are missing.
 */
export function ensureSpansPreserved(
  revisedContent: string,
  originalSpans: CommentSpan[],
): string {
  if (originalSpans.length === 0) return revisedContent;

  const missing = originalSpans.filter(span => !revisedContent.includes(span.uuid));
  if (missing.length === 0) return revisedContent;

  const orphanLines = missing.map(
    s => `- <span discussion-urls="${s.uuid}">${s.inner_text}</span> [dropped by Claude]`,
  );

  const orphanedHeading = '## Orphaned comments';
  if (revisedContent.includes(orphanedHeading)) {
    return revisedContent + '\n' + orphanLines.join('\n');
  }

  return revisedContent + '\n\n' + orphanedHeading + '\n\n' + orphanLines.join('\n');
}
