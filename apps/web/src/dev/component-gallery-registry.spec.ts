/**
 * Gallery completeness: every non-spec component file under `apps/web/src/ui/` must have
 * a gallery entry. This reads the real `ui/` directory and compares basenames against the
 * registry, so a future `ui/` component added without a gallery entry fails here — and the
 * failure names the missing file.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GALLERY_ENTRIES, GALLERY_ENTRY_IDS } from './component-gallery-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, '..', 'ui');

/** Non-spec component basenames under `src/ui/` (e.g. `chip` for `chip.tsx`). */
function uiComponentBasenames(): string[] {
  return readdirSync(UI_DIR)
    .filter((entry) => /\.(ts|tsx)$/.test(entry) && !/\.spec\.(ts|tsx)$/.test(entry))
    .map((entry) => entry.replace(/\.(ts|tsx)$/, ''));
}

describe('component gallery registry', () => {
  it('finds ui/ component files to check', () => {
    expect(uiComponentBasenames().length).toBeGreaterThan(0);
  });

  it('has a gallery entry for every ui/ component', () => {
    const ids = new Set(GALLERY_ENTRY_IDS);
    const missing = uiComponentBasenames().filter((basename) => !ids.has(basename));
    expect(missing, `ui/ components missing a gallery entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('declares no gallery entry without a matching ui/ file', () => {
    const present = new Set(uiComponentBasenames());
    const extra = GALLERY_ENTRY_IDS.filter((id) => !present.has(id));
    expect(extra, `gallery entries with no ui/ file: ${extra.join(', ')}`).toEqual([]);
  });

  it('uses unique entry ids', () => {
    expect(new Set(GALLERY_ENTRY_IDS).size).toBe(GALLERY_ENTRIES.length);
  });
});
