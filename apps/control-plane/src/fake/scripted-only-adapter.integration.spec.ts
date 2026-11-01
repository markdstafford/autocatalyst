import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderProfileSettings } from '@autocatalyst/api-contract';
import { buildProviderAdapterKey, type ProviderCompositionResult } from '@autocatalyst/core';
import { claudeAgentAdapterId, claudeProviderKind } from '@autocatalyst/claude-agent-adapter';
import { openaiAgentAdapterId, openaiProviderKind } from '@autocatalyst/openai-agent-adapter';
import {
  DrizzleConfigurationRecordRepository,
  createSqliteDatabase
} from '@autocatalyst/persistence';

import { readControlPlaneAppConfig } from '../config.js';
import { createControlPlaneServer, type ControlPlaneServerOptions } from '../server.js';
import { FAKE_TENANT } from './constants.js';
import { resolveFakeStatePaths } from './paths.js';

const servers: FastifyInstance[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function startFake(
  stateDir: string,
  extra: Partial<ControlPlaneServerOptions> = {}
): Promise<FastifyInstance> {
  const config = readControlPlaneAppConfig(['--fake-mode', '--fake-state-dir', stateDir], {});
  const app = await createControlPlaneServer({ ...config, ...extra });
  servers.push(app);
  return app;
}

/**
 * Fake mode owns provider adapter selection: it must register ONLY the scripted
 * Claude adapter, and must NOT carry caller-provided real provider factories into
 * the fake registry. Otherwise a persisted/API-created profile referencing a real
 * adapter key could route to a real provider after restart — the exact hazard the
 * reviewer flagged.
 */
describe('fake mode registers only the scripted adapter', () => {
  it('ignores caller-provided real provider adapters even when a persisted profile references them', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-fake-scripted-only-'));

    // First boot: bootstrap the fake state, database, and fake Claude profile.
    const first = await startFake(stateDir);
    await first.close();
    servers.pop();

    // Simulate a provider profile created through the API during a prior fake run
    // that points at a REAL OpenAI agent adapter.
    const paths = resolveFakeStatePaths(stateDir);
    const database = createSqliteDatabase({ path: paths.databasePath });
    try {
      const records = new DrizzleConfigurationRecordRepository(database);
      const settings: ProviderProfileSettings = {
        profileName: 'leftover-real-openai',
        credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
        model: { provider: 'openai', model: 'gpt-5' },
        inferenceSettings: {},
        endpoint: {}
      };
      await records.create({
        tenant: FAKE_TENANT,
        kind: 'provider_profile',
        providerKind: openaiProviderKind,
        adapterId: openaiAgentAdapterId,
        settings
      });
    } finally {
      database.close();
    }

    // Restart fake mode, passing a caller-provided REAL OpenAI adapter factory.
    // Fake mode must refuse to compose it. The poison factory records whether it
    // was ever invoked by startup provider composition.
    let poisonInvoked = false;
    const openaiAgentKey = buildProviderAdapterKey(openaiProviderKind, openaiAgentAdapterId);
    let composition: ProviderCompositionResult | undefined;

    await startFake(stateDir, {
      providerAdapters: new Map([
        [
          openaiAgentKey,
          () => {
            poisonInvoked = true;
            throw new Error('real OpenAI adapter must never be composed in fake mode');
          }
        ]
      ]),
      onProviderComposition: (result) => {
        composition = result;
      }
    });

    expect(composition).toBeDefined();
    const result = composition as ProviderCompositionResult;

    // The caller-provided real OpenAI factory is never invoked.
    expect(poisonInvoked).toBe(false);

    // Only the scripted Claude adapter is composed; no real OpenAI binding exists.
    const composedKeys = result.composed.map((b) => buildProviderAdapterKey(b.providerKind, b.adapterId));
    expect(composedKeys).toContain(buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId));
    expect(composedKeys).not.toContain(openaiAgentKey);

    // The leftover real-provider profile is unresolved because its adapter factory
    // was ignored (not carried into the fake registry), not because it failed.
    const openaiUnresolved = result.unresolved.find(
      (u) => u.providerKind === openaiProviderKind && u.adapterId === openaiAgentAdapterId
    );
    expect(openaiUnresolved).toBeDefined();
    expect(openaiUnresolved?.reason).toBe('adapter_not_found');
  }, 60_000);
});
