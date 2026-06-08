import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from '@autocatalyst/api-contract';
import {
  checkSqliteDatabaseReachability,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { createControlPlaneServer, startControlPlaneServer } from './server.js';

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-control-plane-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('control-plane server lifecycle', () => {
  it('creates a Fastify server from a caller-owned migrated database', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const app = await createControlPlaneServer(database);

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(healthResponseSchema.parse(response.json())).toEqual({
        status: 'ok',
        database: { status: 'reachable' }
      });

      await app.close();
      expect(await checkSqliteDatabaseReachability(database)).toBe(true);
      database.close();
    });
  });

  it('starts, listens, and closes Fastify before closing the database', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const handle = await startControlPlaneServer({ port: 0, databasePath });

      expect(handle.port).toBeGreaterThan(0);
      expect(handle.databasePath).toBe(databasePath);
      expect(handle).not.toHaveProperty('app');

      const response = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(response.status).toBe(200);

      await handle.close();
    });
  });
});
