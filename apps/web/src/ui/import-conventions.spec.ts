/**
 * Import-convention enforcement for web source.
 *
 * Two rules, enforced here as a fast source scan (ESLint enforces the Base UI rule
 * too, under `lint`):
 *
 *  1. Only files under `src/ui/` may import `@base-ui/react` (or a subpath). A
 *     screen or other module importing Base UI directly is a violation.
 *  2. Icons come only from `lucide-react`, imported by name — never a default or
 *     namespace import, and never another icon package.
 *
 * The pure detectors are unit-tested with fixture snippets (proving a screen-file
 * Base UI import is rejected and a `src/ui/` one is allowed), then run across the
 * real tree to prove the invariant holds.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

const DISALLOWED_ICON_PACKAGES: readonly RegExp[] = [
  /^@heroicons\//,
  /^react-icons(\/|$)/,
  /^@tabler\/icons-react(\/|$)/,
  /^@phosphor-icons\//,
  /^@fortawesome\//,
  /^feather-icons(\/|$)/
];

function importSources(code: string): string[] {
  const sources: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(code);
    while (match !== null) {
      if (match[1] !== undefined) sources.push(match[1]);
      match = pattern.exec(code);
    }
  }
  return sources;
}

function importsBaseUi(code: string): boolean {
  return importSources(code).some(
    (source) => source === '@base-ui/react' || source.startsWith('@base-ui/react/')
  );
}

/** A Base UI import is a violation unless the file lives under `src/ui/`. */
export function detectBaseUiViolation(relPath: string, code: string): boolean {
  const normalized = relPath.split('\\').join('/');
  const underUi = normalized === 'ui' || normalized.startsWith('ui/');
  return importsBaseUi(code) && !underUi;
}

/** Returns the first disallowed icon-package source, or undefined. */
export function detectDisallowedIconImport(code: string): string | undefined {
  return importSources(code).find((source) =>
    DISALLOWED_ICON_PACKAGES.some((pattern) => pattern.test(source))
  );
}

/** A lucide default or namespace import is a violation; named imports are fine. */
export function detectNonNamedLucideImport(code: string): boolean {
  return (
    /\bimport\s+\w+\s*,?\s*(?:\{[^}]*\})?\s*from\s*['"]lucide-react['"]/.test(code) ||
    /\bimport\s+\*\s+as\s+\w+\s+from\s*['"]lucide-react['"]/.test(code)
  );
}

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
      continue;
    }
    // Scan production source only; spec files carry intentional fixture strings
    // (e.g. a disallowed icon package) that would otherwise trip the scan.
    if (/\.spec\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
}

const FILES: string[] = [];
collect(SRC, FILES);

describe('import-convention detectors', () => {
  it('flags a Base UI import from a screen file', () => {
    expect(
      detectBaseUiViolation('routes/foundation-page.tsx', "import { Button } from '@base-ui/react/button';")
    ).toBe(true);
  });

  it('allows a Base UI import from a src/ui file', () => {
    expect(
      detectBaseUiViolation('ui/button.tsx', "import { Button } from '@base-ui/react/button';")
    ).toBe(false);
  });

  it('flags a non-lucide icon package', () => {
    expect(detectDisallowedIconImport("import { X } from '@heroicons/react/24/solid';")).toBe(
      '@heroicons/react/24/solid'
    );
  });

  it('allows named lucide imports', () => {
    expect(detectDisallowedIconImport("import { PlugZap } from 'lucide-react';")).toBeUndefined();
    expect(detectNonNamedLucideImport("import { PlugZap } from 'lucide-react';")).toBe(false);
  });

  it('flags a default or namespace lucide import', () => {
    expect(detectNonNamedLucideImport("import Icons from 'lucide-react';")).toBe(true);
    expect(detectNonNamedLucideImport("import * as Icons from 'lucide-react';")).toBe(true);
  });
});

describe('web source obeys the conventions', () => {
  it('finds source files to scan', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    const rel = relative(SRC, file);
    it(`${rel} follows import conventions`, () => {
      const code = readFileSync(file, 'utf-8');
      expect(detectBaseUiViolation(rel, code), 'Base UI only under src/ui/').toBe(false);
      expect(detectDisallowedIconImport(code), 'icons only from lucide-react').toBeUndefined();
      expect(detectNonNamedLucideImport(code), 'lucide imported by name').toBe(false);
    });
  }
});
