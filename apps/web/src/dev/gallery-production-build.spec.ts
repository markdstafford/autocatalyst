// @vitest-environment node
/**
 * Production build-output assertion: the dev gallery must not reach production.
 *
 * This runs a real Vite production build into a temporary output directory, then scans
 * every emitted file. Because the gallery's dynamic import sits behind an
 * `import.meta.env.DEV` guard (see `dev-routes.tsx`), Vite replaces the flag with `false`
 * in production and tree-shakes the gallery out: no emitted file may contain the gallery
 * marker string, and no emitted chunk filename may reference the gallery module.
 *
 * It uses the Node test environment (no DOM) and spawns the Vite CLI in a child process so
 * the build is fully isolated from Vitest's own module graph. The child forces
 * `NODE_ENV=production` and `--mode production`: Vitest runs under `NODE_ENV=test`, which
 * Vite would otherwise treat as a non-production build (making `import.meta.env.DEV` true),
 * so forcing it reproduces exactly what `pnpm nx build web` emits.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
// src/dev -> src -> web
const WEB_ROOT = join(HERE, '..', '..');
// web -> apps -> <repo root>
const REPO_ROOT = join(WEB_ROOT, '..', '..');
const VITE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'vite');

/** Must match {@link GALLERY_MARKER} in `components-gallery.tsx`. */
const GALLERY_MARKER = 'AUTOCATALYST_DEV_COMPONENT_GALLERY';

const outDir = mkdtempSync(join(tmpdir(), 'web-dist-'));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

describe('production build excludes the dev gallery', () => {
  it(
    'emits no gallery chunk and no file containing the gallery marker',
    async () => {
      await execFileAsync(
        VITE_BIN,
        ['build', '--mode', 'production', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
        {
          cwd: WEB_ROOT,
          timeout: 170_000,
          env: { ...process.env, NODE_ENV: 'production' }
        }
      );

      const files: string[] = [];
      walk(outDir, files);
      expect(files.length).toBeGreaterThan(0);

      const galleryChunks = files.filter((file) => /gallery/i.test(file));
      expect(galleryChunks, `unexpected gallery chunk(s): ${galleryChunks.join(', ')}`).toEqual([]);

      const markerHits = files.filter((file) => readFileSync(file, 'utf-8').includes(GALLERY_MARKER));
      expect(markerHits, `gallery marker found in: ${markerHits.join(', ')}`).toEqual([]);
    },
    180_000
  );
});
