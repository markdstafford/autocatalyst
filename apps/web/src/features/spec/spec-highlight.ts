/**
 * Lazy Shiki highlighting for spec code blocks.
 *
 * Like `highlight/highlight.ts`, this uses the fine-grained `shiki/core` API so Vite keeps the
 * core, engine, grammars, and themes out of the entry chunk — everything is pulled in through
 * `import()` on first use. Unlike that module (which emits HTML for a single known language), this
 * one returns per-line **token** data so the caller can colour text inside its own source-mapped
 * line wrappers without changing the DOM text. That is what keeps selection mapping identical
 * before and after highlighting: Shiki only splits a line into coloured spans whose concatenated
 * text is unchanged.
 *
 * Only languages actually present in a spec are loaded, and only from a fixed registry of
 * statically-analysable dynamic imports (a fully dynamic specifier would defeat Vite's code
 * splitting). An unknown or unsupported language resolves to `null`, so the code renders as plain
 * selectable text.
 */
import type { HighlighterCore } from 'shiki/core';

export type CodeBrightness = 'light' | 'dark';

/** One coloured token: its exact text and the resolved foreground colour. */
export interface HighlightToken {
  readonly content: string;
  readonly color: string | undefined;
}

export type HighlightLine = readonly HighlightToken[];

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

// Language grammars we are willing to load, keyed by the fence info string (lowercased). Each
// value is a statically-analysable dynamic import so Vite can split it into its own chunk.
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  ts: () => import('shiki/langs/typescript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  js: () => import('shiki/langs/javascript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  sh: () => import('shiki/langs/bash.mjs'),
  shell: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  py: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  yml: () => import('shiki/langs/yaml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  md: () => import('shiki/langs/markdown.mjs')
};

/** True when a fence language can be highlighted; false means render it as plain text. */
export function isHighlightableLanguage(lang: string | null | undefined): boolean {
  return lang !== null && lang !== undefined && Object.hasOwn(LANG_LOADERS, lang.toLowerCase());
}

let corePromise: Promise<HighlighterCore> | undefined;
const loadedLangs = new Set<string>();
const unsupportedLangs = new Set<string>();

async function getCore(): Promise<HighlighterCore> {
  if (corePromise === undefined) {
    corePromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubLight, githubDark] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs')
      ]);
      return createHighlighterCore({
        langs: [],
        themes: [githubLight.default, githubDark.default],
        engine: createJavaScriptRegexEngine()
      });
    })().catch((error: unknown) => {
      corePromise = undefined;
      throw error;
    });
  }
  return corePromise;
}

/**
 * Highlight `code` written in `lang` to per-line token data for the given brightness, or `null`
 * when the language is unsupported or highlighting fails (the caller then keeps the plain text).
 */
export async function highlightToLines(
  code: string,
  lang: string | null | undefined,
  brightness: CodeBrightness
): Promise<HighlightLine[] | null> {
  if (lang === null || lang === undefined) {
    return null;
  }
  const key = lang.toLowerCase();
  const loader = LANG_LOADERS[key];
  if (loader === undefined || unsupportedLangs.has(key)) {
    return null;
  }
  try {
    const core = await getCore();
    if (!loadedLangs.has(key)) {
      const grammar = await loader();
      await core.loadLanguage(grammar.default as Parameters<HighlighterCore['loadLanguage']>[0]);
      loadedLangs.add(key);
    }
    const theme = brightness === 'dark' ? DARK_THEME : LIGHT_THEME;
    const { tokens } = core.codeToTokens(code, { lang: key, theme });
    return tokens.map((line) => line.map((token) => ({ content: token.content, color: token.color })));
  } catch {
    unsupportedLangs.add(key);
    return null;
  }
}
