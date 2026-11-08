/**
 * mdast → React renderer with an embedded source map.
 *
 * We render the mdast tree to React elements ourselves (no rehype, no `dangerouslySetInnerHTML`,
 * no HTML sanitizer) so raw HTML in the spec is inert literal text and every selectable text run
 * carries its source range. The "render source map" is not a separate data structure: it lives on
 * the DOM as the `data-sr-*` attributes defined in `spec-runs.ts`, which the selection mapper and
 * marker placement read back.
 *
 * Offsets on mdast nodes are UTF-16 code units; every one is converted to a Unicode code-point
 * offset through `code-points.ts` before it becomes a run's `data-sr-start` / `data-sr-end`.
 *
 * Text runs:
 * - A text node whose `value` equals its source slice is an **identity** run (the common case,
 *   including soft line breaks, whose `\n` / `\r\n` the mdast value preserves verbatim).
 * - A text node transformed by Markdown (entities, escapes), inline code (backticks hidden), and
 *   raw HTML shown as text are **opaque** runs: a selection boundary inside them snaps outward.
 */
import type {
  Blockquote,
  Code,
  Heading,
  Link,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
  Text
} from 'mdast';
import { Fragment, type ReactNode } from 'react';

import { utf16IndexToCodePointOffset } from './code-points.js';
import { CodeBlock } from './spec-code-block.js';
import { SPEC_DOCUMENT_ATTR, SR_END_ATTR, SR_KIND_ATTR, SR_START_ATTR } from './spec-runs.js';
import { parseSpecMarkdown } from './spec-parse.js';

export interface SpecDocumentProps {
  readonly markdown: string;
}

/** Render the spec markdown as a selectable, source-mapped React document. */
export function SpecDocument({ markdown }: SpecDocumentProps): ReactNode {
  const tree = parseSpecMarkdown(markdown);
  const toCp = (utf16: number): number => utf16IndexToCodePointOffset(markdown, utf16);
  return (
    <div
      {...{ [SPEC_DOCUMENT_ATTR]: '' }}
      data-testid="spec-document"
      style={{ maxWidth: 'var(--width-reading-column)' }}
      className="text-base leading-[1.6] text-text [&_a]:text-primary [&_a]:underline"
    >
      {renderBlocks(tree.children, markdown, toCp, 'b')}
    </div>
  );
}

type ToCp = (utf16: number) => number;

function renderBlocks(nodes: readonly RootContent[], markdown: string, toCp: ToCp, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, index) => {
    const key = `${keyPrefix}-${index}`;
    const rendered = renderBlock(node, markdown, toCp, key);
    if (rendered !== null) {
      out.push(<Fragment key={key}>{rendered}</Fragment>);
    }
  });
  return out;
}

function renderBlock(node: RootContent, markdown: string, toCp: ToCp, key: string): ReactNode {
  switch (node.type) {
    case 'yaml':
      // Front matter: counted in source offsets, never rendered.
      return null;
    case 'heading':
      return renderHeading(node, markdown, toCp, key);
    case 'paragraph':
      return <p className="my-3">{renderInline((node as Paragraph).children, markdown, toCp, key)}</p>;
    case 'list':
      return renderList(node as List, markdown, toCp, key);
    case 'table':
      return renderTable(node as Table, markdown, toCp, key);
    case 'code':
      return <CodeBlock node={node as Code} markdown={markdown} toCp={toCp} />;
    case 'blockquote':
      return (
        <blockquote className="my-3 border-l-2 border-border pl-3 text-subtext">
          {renderBlocks((node as Blockquote).children, markdown, toCp, key)}
        </blockquote>
      );
    case 'thematicBreak':
      return <hr className="my-4 border-border" />;
    case 'html':
      // Block-level raw HTML: shown as literal text, never as markup.
      return renderOpaqueText(node, markdown, toCp);
    default:
      return renderUnknownBlock(node, markdown, toCp, key);
  }
}

function renderUnknownBlock(node: RootContent, markdown: string, toCp: ToCp, key: string): ReactNode {
  const anyNode = node as { children?: unknown; value?: unknown; position?: Text['position'] };
  if (Array.isArray(anyNode.children)) {
    return <div className="my-3">{renderInline(anyNode.children as PhrasingContent[], markdown, toCp, key)}</div>;
  }
  if (typeof anyNode.value === 'string' && node.position !== undefined) {
    return renderOpaqueText(node as unknown as Text, markdown, toCp);
  }
  return null;
}

function renderHeading(node: Heading, markdown: string, toCp: ToCp, key: string): ReactNode {
  const children = renderInline(node.children, markdown, toCp, key);
  const common = 'mt-5 mb-2 font-semibold';
  switch (node.depth) {
    case 1:
      return <h1 className={`${common} text-xl`}>{children}</h1>;
    case 2:
      return <h2 className={`${common} text-lg`}>{children}</h2>;
    case 3:
      return <h3 className={`${common} text-md`}>{children}</h3>;
    default:
      return <h4 className={`${common} text-md`}>{children}</h4>;
  }
}

function renderList(node: List, markdown: string, toCp: ToCp, key: string): ReactNode {
  const items = node.children.map((item, index) => renderListItem(item, markdown, toCp, `${key}-i${index}`, index));
  if (node.ordered === true) {
    const start = node.start ?? 1;
    return (
      <ol start={start} className="my-3 list-decimal pl-6">
        {items}
      </ol>
    );
  }
  return <ul className="my-3 list-disc pl-6">{items}</ul>;
}

function renderListItem(node: ListItem, markdown: string, toCp: ToCp, key: string, index: number): ReactNode {
  const checkbox =
    node.checked === null || node.checked === undefined ? null : (
      <input
        type="checkbox"
        checked={node.checked}
        readOnly
        className="mr-2 align-middle"
        aria-label={node.checked ? 'completed task' : 'task'}
      />
    );
  // Task-list items drop the list disc so the checkbox reads as the marker.
  const className = checkbox === null ? 'my-1' : 'my-1 list-none -ml-6';
  return (
    <li key={key} className={className} data-list-index={index}>
      {checkbox}
      {renderBlocks(node.children, markdown, toCp, key)}
    </li>
  );
}

function renderTable(node: Table, markdown: string, toCp: ToCp, key: string): ReactNode {
  const [headerRow, ...bodyRows] = node.children;
  return (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {headerRow !== undefined ? (
          <thead>
            <tr>{renderCells(headerRow, markdown, toCp, `${key}-h`, true)}</tr>
          </thead>
        ) : null}
        <tbody>
          {bodyRows.map((row, index) => (
            <tr key={`${key}-r${index}`}>{renderCells(row, markdown, toCp, `${key}-r${index}`, false)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderCells(row: TableRow, markdown: string, toCp: ToCp, key: string, header: boolean): ReactNode[] {
  return row.children.map((cell, index) => {
    const content = renderInline((cell as TableCell).children, markdown, toCp, `${key}-c${index}`);
    const className = 'border border-border px-2 py-1 text-left align-top';
    return header ? (
      <th key={`${key}-c${index}`} className={`${className} bg-mantle font-semibold`}>
        {content}
      </th>
    ) : (
      <td key={`${key}-c${index}`} className={className}>
        {content}
      </td>
    );
  });
}

function renderInline(nodes: readonly PhrasingContent[], markdown: string, toCp: ToCp, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, index) => {
    out.push(<Fragment key={`${keyPrefix}-p${index}`}>{renderPhrasing(node, markdown, toCp, `${keyPrefix}-p${index}`)}</Fragment>);
  });
  return out;
}

function renderPhrasing(node: PhrasingContent, markdown: string, toCp: ToCp, key: string): ReactNode {
  switch (node.type) {
    case 'text':
      return renderText(node, markdown, toCp);
    case 'emphasis':
      return <em>{renderInline(node.children, markdown, toCp, key)}</em>;
    case 'strong':
      return <strong>{renderInline(node.children, markdown, toCp, key)}</strong>;
    case 'delete':
      return <del>{renderInline(node.children, markdown, toCp, key)}</del>;
    case 'inlineCode':
      return renderInlineCode(node, markdown, toCp);
    case 'break':
      // Hard line break: visual only. Boundary resolution uses the neighbouring runs, and the
      // source between them (the trailing spaces + newline) is included by slicing.
      return <br />;
    case 'link':
      return renderLink(node, markdown, toCp, key);
    case 'html':
      return renderOpaqueText(node, markdown, toCp);
    default:
      return renderUnknownPhrasing(node, markdown, toCp, key);
  }
}

function renderUnknownPhrasing(node: PhrasingContent, markdown: string, toCp: ToCp, key: string): ReactNode {
  const anyNode = node as { children?: unknown; value?: unknown; position?: Text['position'] };
  if (Array.isArray(anyNode.children)) {
    return <>{renderInline(anyNode.children as PhrasingContent[], markdown, toCp, key)}</>;
  }
  if (typeof anyNode.value === 'string' && node.position !== undefined) {
    return renderOpaqueText(node as unknown as Text, markdown, toCp);
  }
  return null;
}

function renderText(node: Text, markdown: string, toCp: ToCp): ReactNode {
  const range = sourceRange(node, markdown, toCp);
  if (range === null) {
    return node.value;
  }
  // Identity when the rendered value is exactly the source slice; otherwise the Markdown layer
  // transformed it (entity, escape) and the run is opaque.
  const identity = node.value === range.sourceSlice;
  return (
    <span {...{ [SR_START_ATTR]: range.cpStart, [SR_END_ATTR]: range.cpEnd, [SR_KIND_ATTR]: identity ? 'identity' : 'opaque' }}>
      {node.value}
    </span>
  );
}

function renderInlineCode(node: { value: string; position?: Text['position'] }, markdown: string, toCp: ToCp): ReactNode {
  const range = sourceRange(node, markdown, toCp);
  const attrs = range === null ? {} : { [SR_START_ATTR]: range.cpStart, [SR_END_ATTR]: range.cpEnd, [SR_KIND_ATTR]: 'opaque' };
  return (
    <code className="rounded-xs bg-mantle px-1 font-mono text-sm" {...attrs}>
      {node.value}
    </code>
  );
}

function renderOpaqueText(node: { value: string; position?: Text['position'] }, markdown: string, toCp: ToCp): ReactNode {
  const range = sourceRange(node, markdown, toCp);
  if (range === null) {
    return node.value;
  }
  return (
    <span {...{ [SR_START_ATTR]: range.cpStart, [SR_END_ATTR]: range.cpEnd, [SR_KIND_ATTR]: 'opaque' }}>{node.value}</span>
  );
}

function renderLink(node: Link, markdown: string, toCp: ToCp, key: string): ReactNode {
  const children = renderInline(node.children, markdown, toCp, key);
  if (isSafeHref(node.url)) {
    return (
      <a href={node.url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  // Unsupported scheme: render the link text as plain, non-clickable content.
  return <>{children}</>;
}

/** Only http, https, and mailto are rendered as clickable anchors; everything else is plain text. */
export function isSafeHref(url: string): boolean {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u.exec(url);
  if (match === null) {
    return false;
  }
  const scheme = (match[1] ?? '').toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function sourceRange(
  node: { position?: Nodes['position'] },
  markdown: string,
  toCp: ToCp
): { cpStart: number; cpEnd: number; sourceSlice: string } | null {
  const position = node.position;
  if (position === undefined || position.start.offset === undefined || position.end.offset === undefined) {
    return null;
  }
  const startUtf16 = position.start.offset;
  const endUtf16 = position.end.offset;
  return {
    cpStart: toCp(startUtf16),
    cpEnd: toCp(endUtf16),
    sourceSlice: markdown.slice(startUtf16, endUtf16)
  };
}
