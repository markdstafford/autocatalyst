/**
 * A fenced code block: selectable source-mapped text first, Shiki colour layered on afterwards.
 *
 * Each code line is rendered as its own **identity** run (see `spec-runs.ts`) whose concatenated
 * DOM text equals the source line. Shiki, once loaded, only replaces a line's single text node
 * with coloured token spans whose concatenation is identical — so the run's text, its
 * `data-sr-*` range, and therefore selection mapping are unchanged before and after highlighting.
 * The newline between lines is a bare text node (no run); a cross-line selection still maps
 * correctly because the mapper resolves the two boundaries and slices the source between them.
 *
 * Highlighting is lazy and language-scoped (see `spec-highlight.ts`): unknown languages and load
 * failures leave the plain text in place, and a theme change re-highlights.
 */
import type { Code } from 'mdast';
import { Fragment, useEffect, useState, type ReactNode } from 'react';

import {
  highlightToLines,
  isHighlightableLanguage,
  type CodeBrightness,
  type HighlightLine
} from './spec-highlight.js';
import { SR_END_ATTR, SR_KIND_ATTR, SR_START_ATTR } from './spec-runs.js';

export interface CodeBlockProps {
  readonly node: Code;
  readonly markdown: string;
  readonly toCp: (utf16: number) => number;
}

interface LineInfo {
  readonly text: string;
  readonly cpStart: number;
  readonly cpEnd: number;
}

const PRE_CLASS = 'my-3 overflow-x-auto rounded-sm border border-border bg-mantle p-3';
const CODE_CLASS = 'block whitespace-pre font-mono text-sm text-text';

export function CodeBlock({ node, markdown, toCp }: CodeBlockProps): ReactNode {
  const lang = node.lang ?? null;
  const brightness = useDocumentBrightness();
  const layout = computeLineInfos(node, markdown, toCp);
  const [highlighted, setHighlighted] = useState<HighlightLine[] | null>(null);

  const lineCount = layout.kind === 'lines' ? layout.lines.length : 0;
  useEffect(() => {
    let cancelled = false;
    if (layout.kind !== 'lines' || !isHighlightableLanguage(lang)) {
      setHighlighted(null);
      return;
    }
    const expected = layout.lines.map((line) => line.text);
    void highlightToLines(node.value, lang, brightness)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setHighlighted(normalizeTokens(result, expected));
      })
      .catch(() => {
        if (!cancelled) {
          setHighlighted(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // Re-highlight when the code, its language, the theme brightness, or the line count change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.value, lang, brightness, lineCount]);

  if (layout.kind === 'opaque') {
    return (
      <pre className={PRE_CLASS}>
        <code
          className={CODE_CLASS}
          data-spec-code=""
          {...{ [SR_START_ATTR]: layout.cpStart, [SR_END_ATTR]: layout.cpEnd, [SR_KIND_ATTR]: 'opaque' }}
        >
          {node.value}
        </code>
      </pre>
    );
  }

  return (
    <pre className={PRE_CLASS}>
      <code className={CODE_CLASS} data-spec-code="" {...(lang !== null ? { 'data-lang': lang } : {})}>
        {layout.lines.map((line, index) => (
          <Fragment key={index}>
            {index > 0 ? '\n' : null}
            <span {...{ [SR_START_ATTR]: line.cpStart, [SR_END_ATTR]: line.cpEnd, [SR_KIND_ATTR]: 'identity' }}>
              {renderLine(line.text, highlighted?.[index])}
            </span>
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

function renderLine(text: string, tokens: HighlightLine | undefined): ReactNode {
  if (tokens === undefined) {
    return text;
  }
  return tokens.map((token, index) => (
    <span key={index} style={token.color !== undefined ? { color: token.color } : undefined}>
      {token.content}
    </span>
  ));
}

type Layout =
  | { readonly kind: 'lines'; readonly lines: readonly LineInfo[] }
  | { readonly kind: 'opaque'; readonly cpStart: number; readonly cpEnd: number };

function computeLineInfos(node: Code, markdown: string, toCp: (utf16: number) => number): Layout {
  const position = node.position;
  const fenceStart = position?.start.offset ?? 0;
  const fenceEnd = position?.end.offset ?? markdown.length;
  // Locate the exact code text inside the fence so each line maps to real source offsets. If the
  // value cannot be found (e.g. indentation was normalised), fall back to one opaque run.
  const contentStart = node.value.length > 0 ? markdown.indexOf(node.value, fenceStart) : -1;
  if (contentStart < 0) {
    return { kind: 'opaque', cpStart: toCp(fenceStart), cpEnd: toCp(fenceEnd) };
  }
  const lines: LineInfo[] = [];
  let offset = contentStart;
  for (const text of node.value.split('\n')) {
    lines.push({ text, cpStart: toCp(offset), cpEnd: toCp(offset + text.length) });
    offset += text.length + 1; // account for the stripped '\n'
  }
  return { kind: 'lines', lines };
}

/**
 * Accept Shiki token lines only when they reconstruct the plain text exactly, so colouring can
 * never change selection mapping. A single trailing empty token line (Shiki sometimes appends one)
 * is tolerated and dropped.
 */
function normalizeTokens(result: HighlightLine[] | null, expected: readonly string[]): HighlightLine[] | null {
  if (result === null) {
    return null;
  }
  let lines = result;
  if (lines.length === expected.length + 1) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.every((token) => token.content === '')) {
      lines = lines.slice(0, -1);
    }
  }
  if (lines.length !== expected.length) {
    return null;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const joined = (lines[i] ?? []).map((token) => token.content).join('');
    if (joined !== expected[i]) {
      return null;
    }
  }
  return lines;
}

function readBrightness(): CodeBrightness {
  if (typeof document === 'undefined') {
    return 'light';
  }
  return document.documentElement.getAttribute('data-theme-mode') === 'dark' ? 'dark' : 'light';
}

/**
 * Track the document brightness (`data-theme-mode` on `<html>`, set by the ThemeProvider) without
 * coupling the renderer to the theme React context, so the spec renderer can be used in isolation
 * (e.g. selection-mapping tests) and still re-highlight when the theme changes.
 */
function useDocumentBrightness(): CodeBrightness {
  const [brightness, setBrightness] = useState<CodeBrightness>(() => readBrightness());
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(() => setBrightness(readBrightness()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode'] });
    setBrightness(readBrightness());
    return () => observer.disconnect();
  }, []);
  return brightness;
}
