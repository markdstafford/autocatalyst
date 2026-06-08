import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createProbeResourceSuccessStatusCode,
  degradedHealthStatusCode,
  healthResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema
} from '@autocatalyst/api-contract';
import { createSqliteDatabase, migrateSqliteDatabase } from '@autocatalyst/persistence';

import { createControlPlaneServer, startControlPlaneServer } from './server.js';

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-integration-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('control-plane integration', () => {
  it('checks health, creates and reads a probe resource, and survives restart', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const first = await startControlPlaneServer({ port: 0, databasePath });
      const baseUrl = `http://127.0.0.1:${first.port}`;

      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(healthResponseSchema.parse(await health.json())).toEqual({
        status: 'ok',
        database: { status: 'reachable' }
      });

      const create = await fetch(`${baseUrl}${probeResourceCollectionPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'restart durable' })
      });
      expect(create.status).toBe(createProbeResourceSuccessStatusCode);
      const created = probeResourceSchema.parse(await create.json());

      const read = await fetch(`${baseUrl}${probeResourceCollectionPath}/${created.id}`);
      expect(read.status).toBe(200);
      expect(probeResourceSchema.parse(await read.json())).toEqual(created);

      await first.close();

      const second = await startControlPlaneServer({ port: 0, databasePath });
      const restartedRead = await fetch(
        `http://127.0.0.1:${second.port}${probeResourceCollectionPath}/${created.id}`
      );
      expect(restartedRead.status).toBe(200);
      expect(probeResourceSchema.parse(await restartedRead.json())).toEqual(created);
      await second.close();
    });
  });

  it('exposes a real SSE stream that remains open until the test closes it', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const handle = await startControlPlaneServer({ port: 0, databasePath });
      const controller = new AbortController();

      try {
        const response = await fetch(`http://127.0.0.1:${handle.port}/v1/events`, {
          signal: controller.signal
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);
        expect(response.headers.get('cache-control')).toContain('no-cache');
        expect(response.body).not.toBeNull();
        controller.abort();
      } finally {
        await handle.close();
      }
    });
  });

  it('returns degraded health when the caller-owned database has been closed', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const app = await createControlPlaneServer(database);
      database.close();

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(degradedHealthStatusCode);
      expect(healthResponseSchema.parse(response.json())).toEqual({
        status: 'degraded',
        database: { status: 'unreachable' }
      });

      await app.close();
    });
  });
});
