import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configurationRecordCollectionPath,
  createConfigurationRecordSuccessStatusCode,
  degradedHealthStatusCode,
  errorResponseSchema,
  healthResponseSchema
} from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  createExtensionRegistryCatalog,
  type ProviderCompositionResult
} from '@autocatalyst/core';

import { createControlPlaneServer, logProviderCompositionDiagnostics, startControlPlaneServer } from './server.js';

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

  it('invokes provider composition during startup with empty results for a fresh database', async () => {
    await withTempDatabasePath(async (databasePath) => {
      let compositionResult: ProviderCompositionResult | undefined;
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        onProviderComposition: async (result) => { compositionResult = result; }
      });

      expect(compositionResult).toEqual({ composed: [], warnings: [], unresolved: [] });

      await app.close();
    });
  });

  it('awaits provider composition callback before startup resolves', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const callbackEvents: string[] = [];
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        onProviderComposition: async () => {
          callbackEvents.push('callback-started');
          await Promise.resolve();
          callbackEvents.push('callback-finished');
        }
      });

      expect(callbackEvents).toEqual(['callback-started', 'callback-finished']);

      await app.close();
    });
  });

  it('continues startup when an existing provider profile is unresolved', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const first = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });
      const createdResponse = await first.inject({
        method: 'POST',
        url: configurationRecordCollectionPath,
        headers: { authorization: 'Bearer token' },
        payload: {
          kind: 'provider_profile',
          providerKind: 'model_runner',
          adapterId: 'fake-unresolved-model',
          settings: { profileName: 'default' }
        }
      });
      expect(createdResponse.statusCode).toBe(createConfigurationRecordSuccessStatusCode);
      await first.close();

      let compositionResult: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        extensionRegistry: createExtensionRegistryCatalog([
          { providerKind: 'model_runner', adapterId: 'fake-unresolved-model', displayName: 'Fake unresolved', capabilities: [] }
        ]),
        onProviderComposition: (result) => { compositionResult = result; }
      });

      expect(compositionResult?.composed).toEqual([]);
      expect(compositionResult?.warnings).toEqual([]);
      expect(compositionResult?.unresolved).toEqual([
        expect.objectContaining({
          providerKind: 'model_runner',
          adapterId: 'fake-unresolved-model',
          reason: 'adapter_not_found'
        })
      ]);

      await second.close();
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

describe('logProviderCompositionDiagnostics', () => {
  it('logs sanitized summary, composed, warning, and unresolved diagnostics', () => {
    const infoMessages: string[] = [];
    const warnMessages: string[] = [];
    logProviderCompositionDiagnostics(
      {
        composed: [
          {
            providerKind: 'model_runner',
            adapterId: 'fake-registered-model',
            configurationRecordId: 'cfg_composed',
            adapter: { secret: 'do-not-log-adapter-object' }
          }
        ],
        warnings: [
          {
            code: 'adapter_not_registered',
            configurationRecordId: 'cfg_warning',
            providerKind: 'model_runner',
            adapterId: 'fake-unregistered-model',
            message: 'contains only sanitized fields'
          }
        ],
        unresolved: [
          {
            configurationRecordId: 'cfg_unresolved',
            providerKind: 'model_runner',
            adapterId: 'fake-unresolved-model',
            reason: 'adapter_not_found',
            message: 'contains only sanitized fields'
          }
        ]
      },
      {
        info: (message) => { infoMessages.push(message); },
        warn: (message) => { warnMessages.push(message); }
      }
    );

    expect(infoMessages).toEqual([
      'Provider composition completed: composed=1 warnings=1 unresolved=1.',
      'Provider composed: configurationRecordId=cfg_composed providerKind=model_runner adapterId=fake-registered-model.'
    ]);
    expect(warnMessages).toEqual([
      'Provider composition warning: configurationRecordId=cfg_warning providerKind=model_runner adapterId=fake-unregistered-model code=adapter_not_registered.',
      'Provider unresolved: configurationRecordId=cfg_unresolved providerKind=model_runner adapterId=fake-unresolved-model reason=adapter_not_found.'
    ]);
    expect([...infoMessages, ...warnMessages].join('\n')).not.toContain('do-not-log-adapter-object');
  });
});
