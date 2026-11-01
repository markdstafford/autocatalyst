import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { FAKE_MARKER_FILENAME } from './paths.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely clear the fake-mode state directory before `serve-fake` starts.
 *
 * - A missing directory is a no-op.
 * - An empty directory is removed.
 * - A non-empty directory is removed only when it contains the fake-mode marker
 *   file created by fake-mode startup. Otherwise this throws, preventing
 *   accidental deletion when a caller passes the wrong path.
 */
export async function safelyClearFakeStateDir(stateDir: string): Promise<void> {
  if (!(await pathExists(stateDir))) {
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (error) {
    throw new Error(`Cannot inspect fake state directory "${stateDir}": ${(error as Error).message}`);
  }

  if (entries.length === 0) {
    await rm(stateDir, { recursive: true, force: true });
    return;
  }

  const hasMarker = await pathExists(join(stateDir, FAKE_MARKER_FILENAME));
  if (!hasMarker) {
    throw new Error(
      `Refusing to delete non-empty state directory "${stateDir}" because it has no fake-mode marker file (${FAKE_MARKER_FILENAME}). ` +
        'Pass a path created by fake-mode startup, or remove it manually.'
    );
  }

  await rm(stateDir, { recursive: true, force: true });
}
