import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createProbeResourceSuccessStatusCode,
  createSecretResponseSchema,
  degradedHealthStatusCode,
  errorResponseSchema,
  healthResponseSchema,
  principalDiagnosticResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema
} from '@autocatalyst/api-contract';
import { hardcodedDevelopmentPrincipal } from '@autocatalyst/core';
import type { PolicyDecisionInput } from '@autocatalyst/core';

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

describe('principal and policy integration', () => {
  it('resolves the hardcoded principal and consults policy on authenticated requests', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const policyCalls: PolicyDecisionInput[] = [];
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret',
        policy: { authorize: async (input) => { policyCalls.push(input); return { allowed: true }; } }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v1/principal',
        headers: { authorization: 'Bearer integration-token' }
      });
      expect(response.statusCode).toBe(200);
      expect(principalDiagnosticResponseSchema.parse(response.json())).toEqual({
        principal: hardcodedDevelopmentPrincipal
      });
      expect(policyCalls).toHaveLength(1);
      expect(policyCalls[0].action).toBe('principal.diagnostic.read');
      expect(policyCalls[0].principal).toEqual(hardcodedDevelopmentPrincipal);

      await app.close();
    });
  });

  it('rejects unauthenticated requests to /v1/principal with 401', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret'
      });

      const missingAuth = await app.inject({ method: 'GET', url: '/v1/principal' });
      expect(missingAuth.statusCode).toBe(401);

      const wrongToken = await app.inject({
        method: 'GET',
        url: '/v1/principal',
        headers: { authorization: 'Bearer wrong-token' }
      });
      expect(wrongToken.statusCode).toBe(401);

      await app.close();
    });
  });
});

describe('configuration record CRUD integration', () => {
  it('creates, reads, lists, updates, and deletes configuration records', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret'
      });
      const authHeaders = { authorization: 'Bearer integration-token' };

      // Create
      const createResp = await app.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: authHeaders,
        payload: {
          kind: 'provider_profile',
          providerKind: 'model_runner',
          adapterId: 'openai',
          settings: { profileName: 'default' }
        }
      });
      expect(createResp.statusCode).toBe(201);
      const created = configurationRecordResponseSchema.parse(createResp.json());
      expect(created.id).toMatch(/^cfg_/u);

      // Read
      const readResp = await app.inject({
        method: 'GET',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders
      });
      expect(readResp.statusCode).toBe(200);
      expect(configurationRecordResponseSchema.parse(readResp.json())).toEqual(created);

      // List
      const listResp = await app.inject({ method: 'GET', url: '/v1/configuration-records', headers: authHeaders });
      expect(listResp.statusCode).toBe(200);
      expect(configurationRecordListResponseSchema.parse(listResp.json()).records).toHaveLength(1);

      // Update
      const patchResp = await app.inject({
        method: 'PATCH',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders,
        payload: { providerKind: 'updated_runner' }
      });
      expect(patchResp.statusCode).toBe(200);
      const updated = configurationRecordResponseSchema.parse(patchResp.json());
      expect(updated.providerKind).toBe('updated_runner');

      // Invalid create
      const badCreate = await app.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: authHeaders,
        payload: { kind: 'provider_profile', providerKind: 'x', adapterId: 'y', settings: { profileName: '' } }
      });
      expect(badCreate.statusCode).toBe(400);
      expect(errorResponseSchema.parse(badCreate.json()).error.code).toBe('validation_error');

      // Delete
      const deleteResp = await app.inject({
        method: 'DELETE',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders
      });
      expect(deleteResp.statusCode).toBe(204);

      // Read after delete
      const afterDelete = await app.inject({
        method: 'GET',
        url: `/v1/configuration-records/${created.id}`,
        headers: authHeaders
      });
      expect(afterDelete.statusCode).toBe(404);

      await app.close();
    });
  });
});

describe('secret handle separation integration', () => {
  it('stores a secret and references it from a config record without exposing the value', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'integration-token',
        masterSecret: 'integration-master-secret'
      });
      const authHeaders = { authorization: 'Bearer integration-token' };
      const secretValue = 'sk-integration-secret';

      // Create secret
      const secretResp = await app.inject({
        method: 'POST',
        url: '/v1/secrets',
        headers: authHeaders,
        payload: { value: secretValue }
      });
      expect(secretResp.statusCode).toBe(201);
      const { handle } = createSecretResponseSchema.parse(secretResp.json());
      expect(handle).toMatch(/^sec_[A-Za-z0-9_-]{32}$/u);
      expect(secretResp.body).not.toContain(secretValue);

      // Create config record referencing the handle
      const configResp = await app.inject({
        method: 'POST',
        url: '/v1/configuration-records',
        headers: authHeaders,
        payload: {
          kind: 'provider_profile',
          providerKind: 'model_runner',
          adapterId: 'openai',
          settings: { profileName: 'default', credentialSecretHandle: handle }
        }
      });
      expect(configResp.statusCode).toBe(201);
      const configRecord = configurationRecordResponseSchema.parse(configResp.json());

      // Read config record - should include handle but NOT secret value
      const readResp = await app.inject({
        method: 'GET',
        url: `/v1/configuration-records/${configRecord.id}`,
        headers: authHeaders
      });
      expect(readResp.statusCode).toBe(200);
      expect(readResp.body).toContain(handle);
      expect(readResp.body).not.toContain(secretValue);

      await app.close();

      // Verify secret value is NOT stored plaintext in the database
      const { createSqliteDatabase, asInternalSqliteDatabase } = await import('@autocatalyst/persistence');
      const db = createSqliteDatabase({ path: databasePath });
      const internal = asInternalSqliteDatabase(db);

      const configRows = internal.client
        .prepare('SELECT settings_json FROM configuration_records')
        .all() as Array<{ settings_json: string }>;
      for (const row of configRows) {
        expect(row.settings_json).not.toContain(secretValue);
      }

      const secretRows = internal.client
        .prepare('SELECT ciphertext FROM secrets WHERE handle = ?')
        .all(handle) as Array<{ ciphertext: string }>;
      expect(secretRows).toHaveLength(1);
      expect(secretRows[0].ciphertext).not.toContain(secretValue);

      db.close();
    });
  });
});
