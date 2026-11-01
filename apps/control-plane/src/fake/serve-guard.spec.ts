import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FAKE_MARKER_FILENAME } from './paths.js';
import { safelyClearFakeStateDir } from './serve-guard.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('safelyClearFakeStateDir', () => {
  it('is a no-op for a missing directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ac-guard-'));
    const missing = join(base, 'does-not-exist');
    await expect(safelyClearFakeStateDir(missing)).resolves.toBeUndefined();
  });

  it('removes an empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-guard-empty-'));
    await safelyClearFakeStateDir(dir);
    expect(await exists(dir)).toBe(false);
  });

  it('removes a non-empty directory that has the fake-mode marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-guard-marker-'));
    await writeFile(join(dir, FAKE_MARKER_FILENAME), 'autocatalyst-fake-mode\n', 'utf-8');
    await mkdir(join(dir, 'pull-requests'), { recursive: true });
    await safelyClearFakeStateDir(dir);
    expect(await exists(dir)).toBe(false);
  });

  it('refuses to remove a non-empty directory without the marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-guard-nomarker-'));
    await writeFile(join(dir, 'important.txt'), 'do not delete', 'utf-8');
    await expect(safelyClearFakeStateDir(dir)).rejects.toThrow(/Refusing to delete non-empty state directory/u);
    expect(await exists(dir)).toBe(true);
  });
});
