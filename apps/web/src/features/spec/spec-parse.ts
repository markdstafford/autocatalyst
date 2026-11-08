/**
 * Spec Markdown parser setup.
 *
 * The reviewed parser stack (ADR-033 / tech spec) is `unified` + `remark-parse` + `remark-gfm`
 * + `remark-frontmatter`, which gives an mdast tree with `position.start.offset` /
 * `position.end.offset` on every node. Those offsets are **UTF-16 code-unit** indexes into the
 * source string; callers must route them through `code-points.ts` before using them as anchor
 * offsets (see {@link ./code-points.ts}).
 *
 * We parse (not run the full transform pipeline) because the renderer consumes mdast directly
 * and builds React elements itself. We never produce HTML, never use rehype-raw, and never call
 * `dangerouslySetInnerHTML`, so raw HTML in the source is inert — it reaches the renderer as a
 * `html` mdast node and is shown as literal text.
 */
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import type { Root } from 'mdast';
import { unified } from 'unified';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // Front matter is parsed as a source-only `yaml` node: it keeps its characters in the source
  // offsets but the renderer skips it, so it never appears in the visible document.
  .use(remarkFrontmatter, ['yaml']);

/** Parse spec Markdown into an mdast tree with source positions. */
export function parseSpecMarkdown(markdown: string): Root {
  return processor.parse(markdown) as Root;
}
