import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { main } from './main.js';

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
});
