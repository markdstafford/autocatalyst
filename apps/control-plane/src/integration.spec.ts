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

import { createControlPlaneServer, startControlPlaneServer } from './server.js';

const BEARER_TOKEN = 'integration-token';
const MASTER_SECRET = 'integration-master-secret';

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
      const first = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      const baseUrl = `http://127.0.0.1:${first.port}`;

      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(healthResponseSchema.parse(await health.json())).toEqual({
        status: 'ok',
        database: { status: 'reachable' }
      });

      const create = await fetch(`${baseUrl}${probeResourceCollectionPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${BEARER_TOKEN}`
        },
        body: JSON.stringify({ value: 'restart durable' })
      });
      expect(create.status).toBe(createProbeResourceSuccessStatusCode);
      const created = probeResourceSchema.parse(await create.json());

      const read = await fetch(`${baseUrl}${probeResourceCollectionPath}/${created.id}`, {
        headers: { authorization: `Bearer ${BEARER_TOKEN}` }
      });
      expect(read.status).toBe(200);
      expect(probeResourceSchema.parse(await read.json())).toEqual(created);

      await first.close();

      const second = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      const restartedRead = await fetch(
        `http://127.0.0.1:${second.port}${probeResourceCollectionPath}/${created.id}`,
        { headers: { authorization: `Bearer ${BEARER_TOKEN}` } }
      );
      expect(restartedRead.status).toBe(200);
      expect(probeResourceSchema.parse(await restartedRead.json())).toEqual(created);
      await second.close();
    });
  });

  it('exposes a real SSE stream that remains open until the test closes it', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const handle = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      const controller = new AbortController();

      try {
        const response = await fetch(`http://127.0.0.1:${handle.port}/v1/events`, {
          signal: controller.signal,
          headers: { authorization: `Bearer ${BEARER_TOKEN}` }
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

  it('returns degraded health when injected health checker reports unreachable', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        health: { isDatabaseReachable: async () => false }
      });

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
