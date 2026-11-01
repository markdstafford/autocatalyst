/**
 * Exact-pair contrast coverage for every theme and every primary accent.
 *
 * The test parses the generated `themes.css` (and the accent/on-primary selector
 * blocks) directly, resolves each tested token to a concrete color, and computes
 * the WCAG 2.x contrast ratio. It fails if any pair listed in the feature spec
 * (`feature-web-app-foundation.md` -> "Exact contrast tests") falls below its
 * threshold. There are no exemptions: an upstream value that fails must be
 * adjusted in `src/styles/`, not excused here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const THEMES_CSS = readFileSync(join(HERE, 'themes.css'), 'utf-8');

const THEME_IDS = [
  'catppuccin-latte',
  'github-light',
  'solarized-light',
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'github-dark',
  'dracula'
] as const;

const ACCENT_IDS = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach',
  'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'
] as const;

// ---------------------------------------------------------------------------
// Minimal CSS parsing (rule selector -> { property: value })
// ---------------------------------------------------------------------------

interface Rule {
  readonly selector: string;
  readonly decls: Record<string, string>;
}

function parseRules(cssWithComments: string): Rule[] {
  const css = cssWithComments.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null = ruleRe.exec(css);
  while (m !== null) {
    const selector = (m[1] ?? '').trim();
    const body = m[2] ?? '';
    const decls: Record<string, string> = {};
    for (const part of body.split(';')) {
      const idx = part.indexOf(':');
      if (idx === -1) continue;
      const prop = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (prop.length > 0) decls[prop] = value;
    }
    rules.push({ selector, decls });
    m = ruleRe.exec(css);
  }
  return rules;
}

const RULES = parseRules(THEMES_CSS);

function themeDecls(themeId: string): Record<string, string> {
  const rule = RULES.find((r) => r.selector === `[data-theme='${themeId}']`);
  if (rule === undefined) throw new Error(`missing theme block for ${themeId}`);
  return rule.decls;
}

function onPrimary(themeId: string, accentId: string): string {
  const rule = RULES.find(
    (r) => r.selector === `[data-theme='${themeId}'][data-primary-accent='${accentId}']`
  );
  if (rule === undefined || rule.decls['--color-on-primary'] === undefined) {
    throw new Error(`missing --color-on-primary for ${themeId}/${accentId}`);
  }
  return rule.decls['--color-on-primary'];
}

// ---------------------------------------------------------------------------
// Color math (WCAG 2.x)
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

describe('theme contrast', () => {
  it('covers all eight themes', () => {
    for (const id of THEME_IDS) {
      expect(() => themeDecls(id)).not.toThrow();
    }
  });

  for (const themeId of THEME_IDS) {
    const decls = themeDecls(themeId);
    const bg = decls['--color-background'] ?? '';
    const mantle = decls['--color-mantle'] ?? '';
    const text = decls['--color-text'] ?? '';
    const subtext = decls['--color-subtext'] ?? '';
    const border = decls['--color-border'] ?? '';
    const red = decls['--color-red'] ?? '';
    const onDestructive = decls['--color-on-destructive'] ?? '';

    describe(themeId, () => {
      it('declares concrete hex for every tested token and all 14 accents', () => {
        for (const v of [bg, mantle, text, subtext, border, red, onDestructive]) {
          expect(v).toMatch(HEX);
        }
        for (const a of ACCENT_IDS) {
          expect(decls[`--accent-${a}`] ?? '').toMatch(HEX);
        }
      });

      it('body text >= 4.5:1 on background and mantle', () => {
        expect(contrast(text, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(text, mantle)).toBeGreaterThanOrEqual(4.5);
      });

      it('secondary text >= 4.5:1 on background', () => {
        expect(contrast(subtext, bg)).toBeGreaterThanOrEqual(4.5);
      });

      it('destructive foreground >= 4.5:1 on red', () => {
        expect(contrast(onDestructive, red)).toBeGreaterThanOrEqual(4.5);
      });

      it('component border >= 3:1 on background and mantle', () => {
        expect(contrast(border, bg)).toBeGreaterThanOrEqual(3);
        expect(contrast(border, mantle)).toBeGreaterThanOrEqual(3);
      });

      for (const accentId of ACCENT_IDS) {
        it(`primary accent ${accentId}: focus >= 3:1 and on-primary >= 4.5:1`, () => {
          const accent = decls[`--accent-${accentId}`] ?? '';
          // --color-focus and --color-primary both read the selected accent.
          expect(contrast(accent, bg)).toBeGreaterThanOrEqual(3);
          expect(contrast(accent, mantle)).toBeGreaterThanOrEqual(3);
          expect(contrast(onPrimary(themeId, accentId), accent)).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }
});
