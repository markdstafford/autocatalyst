import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { degradedHealthStatusCode, healthResponseSchema } from '@autocatalyst/api-contract';

import { createControlPlaneServer, startControlPlaneServer } from './server.js';

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-control-plane-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('createControlPlaneServer', () => {
  it('rejects empty bearer token', async () => {
    await withTempDatabasePath(async (databasePath) => {
      await expect(
        createControlPlaneServer({ databasePath, bearerToken: '', masterSecret: 'secret' })
      ).rejects.toThrow();
    });
  });

  it('rejects empty master secret', async () => {
    await withTempDatabasePath(async (databasePath) => {
      await expect(
        createControlPlaneServer({ databasePath, bearerToken: 'token', masterSecret: '' })
      ).rejects.toThrow();
    });
  });

  it('creates a Fastify server from options and responds to health', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(healthResponseSchema.parse(response.json())).toEqual({
        status: 'ok',
        database: { status: 'reachable' }
      });

      await app.close();
    });
  });

  it('uses injected health checker when provided', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        health: { isDatabaseReachable: async () => false }
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(degradedHealthStatusCode);

      await app.close();
    });
  });
});

describe('startControlPlaneServer', () => {
  it('starts, listens, and closes with correct handle shape', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const handle = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });

      expect(handle.port).toBeGreaterThan(0);
      expect(handle.databasePath).toBe(databasePath);
      expect(handle).not.toHaveProperty('app');

      const response = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(response.status).toBe(200);

      await handle.close();
    });
  });
});
