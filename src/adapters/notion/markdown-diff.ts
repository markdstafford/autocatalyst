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

/**
 * Prettify markdown content:
 * - Ensures a blank line after every heading (# through ######)
 * - Collapses multiple consecutive blank lines into one
 * - Removes the ## Orphaned comments section and all content below it
 *   until the next ## heading or end of file
 */
export function prettifyMarkdown(raw: string): string {
  // Step 1: Remove ## Orphaned comments section
  const orphanPattern = /\n## Orphaned comments\b[^\n]*(?:\n(?!##)[^\n]*)*/;
  let result = raw.replace(orphanPattern, '');

  // Also handle when orphaned comments is at the very start (unlikely but safe)
  if (result.startsWith('## Orphaned comments')) {
    result = result.replace(/^## Orphaned comments\b[^\n]*(?:\n(?!##)[^\n]*)*/, '');
  }

  // Step 2: Ensure blank line after every heading
  // A heading line is one that starts with one or more # followed by a space
  const lines = result.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const isHeading = /^#{1,6} /.test(lines[i]);
    if (isHeading) {
      const nextLine = lines[i + 1];
      // If next line is not already blank and we're not at the end, insert blank line
      if (nextLine !== undefined && nextLine !== '') {
        out.push('');
      }
    }
  }

  // Step 3: Collapse multiple consecutive blank lines into one
  const collapsed = out.join('\n').replace(/\n{3,}/g, '\n\n');

  return collapsed;
}

/**
 * Strip all HTML tags from Notion-flavored markdown, preserving inner text.
 * Handles <table>, <tr>, <td>, <span discussion-urls>, <br/>, and any other
 * Notion HTML artifacts.
 */
export function stripAllHtml(raw: string): string {
  return raw.replace(/<[^>]*>/g, '');
}
