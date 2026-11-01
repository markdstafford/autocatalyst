/**
 * Style-token safety: outside `src/styles/`, web source must use semantic tokens
 * only — never a raw hex color, an `rgb(`/`rgba(` value, or a raw `--ctp-*`
 * Catppuccin variable name. This keeps every component on the themeable token
 * layer so theme switching stays complete.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

const SKIP_DIRS = new Set(['styles']);
const SOURCE_EXT = /\.(ts|tsx|css)$/;

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(SRC, full);
    const top = rel.split('/')[0] ?? '';
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collect(full, out);
      continue;
    }
    if (top === 'styles') continue;
    if (SOURCE_EXT.test(entry)) out.push(full);
  }
}

const FILES: string[] = [];
collect(SRC, FILES);

const SIX_DIGIT_HEX = /#[0-9a-fA-F]{6}\b/;
const RGB_FUNC = /\brgba?\(/;
const CTP_VAR = /--ctp-/;

describe('style-token safety outside src/styles', () => {
  it('finds source files to scan', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    const rel = relative(SRC, file);
    it(`${rel} uses tokens only`, () => {
      const code = readFileSync(file, 'utf-8');
      expect(code, 'no raw hex color').not.toMatch(SIX_DIGIT_HEX);
      expect(code, 'no rgb()/rgba() literal').not.toMatch(RGB_FUNC);
      expect(code, 'no raw --ctp-* name').not.toMatch(CTP_VAR);
    });
  }
});
