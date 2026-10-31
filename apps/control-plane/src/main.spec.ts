import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './main.js';
import { FAKE_MARKER_FILENAME } from './fake/paths.js';

describe('main', () => {
  it('starts and returns a closeable handle for test callers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-main-'));
    try {
      const handle = await main(
        ['--port', '0', '--database-path', join(directory, 'app.sqlite'), '--bearer-token', 'test-token', '--master-secret', 'test-secret'],
        {}
      );
      expect(handle.port).toBeGreaterThan(0);
      await handle.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe('fake mode', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prints exactly one fake-mode readiness line and serves health with the fake token', async () => {
      const stateDir = await mkdtemp(join(tmpdir(), 'autocatalyst-main-fake-'));
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.join(' '));
      });

      const handle = await main(['--fake-mode', '--fake-state-dir', stateDir, '--port', '0'], {});
      try {
        const readiness = lines.filter((line) => line.startsWith('fake-mode ready'));
        expect(readiness).toHaveLength(1);
        expect(readiness[0]).toBe(
          `fake-mode ready port=${handle.port} stateDir=${stateDir} baseUrl=http://127.0.0.1:${handle.port}`
        );

        // The marker file exists for safe cleanup.
        await expect(access(join(stateDir, FAKE_MARKER_FILENAME))).resolves.toBeUndefined();

        const healthResp = await fetch(`http://127.0.0.1:${handle.port}/health`, {
          headers: { authorization: 'Bearer fake-mode-token' }
        });
        expect(healthResp.status).toBe(200);
      } finally {
        await handle.close();
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 60_000);
  });
});
