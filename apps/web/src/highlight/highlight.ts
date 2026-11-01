/**
 * Lazy, fine-grained Shiki highlighter for JSON.
 *
 * This is the first browser use of Shiki (ADR-033 reserves spec rendering for a
 * later issue). It uses the fine-grained `shiki/core` API rather than the bundled
 * `createHighlighter`, so Vite does not pull every grammar and theme into the
 * bundle. Everything Shiki needs — the core, the JavaScript regex engine, the
 * JSON grammar, and the GitHub light/dark code themes — is pulled in through
 * `import()` on first use, which keeps all of it out of the entry chunk (the
 * manifest test asserts this). The highlighter is created once and reused.
 *
 * Only JSON is loaded for this issue; a later caller may extend the language list
 * with its own explicit imports.
 */
import type { HighlighterCore } from 'shiki/core';

/** Resolved app brightness, used to pick the matching code theme. */
export type CodeBrightness = 'light' | 'dark';

const LIGHT_CODE_THEME = 'github-light';
const DARK_CODE_THEME = 'github-dark';

let highlighterPromise: Promise<HighlighterCore> | undefined;

async function loadHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, jsonLang, githubLight, githubDark] =
    await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs/json.mjs'),
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs')
    ]);

  return createHighlighterCore({
    langs: [jsonLang.default],
    themes: [githubLight.default, githubDark.default],
    engine: createJavaScriptRegexEngine()
  });
}

/**
 * Resolve the shared highlighter, creating it on first use and reusing it after.
 * A failed load is not cached, so a later call can retry.
 */
export function getJsonHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === undefined) {
    highlighterPromise = loadHighlighter().catch((error: unknown) => {
      highlighterPromise = undefined;
      throw error;
    });
  }
  return highlighterPromise;
}

/**
 * Highlight a JSON string to HTML markup using the GitHub code theme that matches
 * the resolved app brightness.
 */
export async function highlightJson(json: string, brightness: CodeBrightness): Promise<string> {
  const highlighter = await getJsonHighlighter();
  return highlighter.codeToHtml(json, {
    lang: 'json',
    theme: brightness === 'dark' ? DARK_CODE_THEME : LIGHT_CODE_THEME
  });
}
