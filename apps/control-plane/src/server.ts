import Fastify, { type FastifyInstance } from 'fastify';

import {
  permissivePolicyDecisionPoint,
  registerControlPlaneRoutes,
  type PolicyDecisionPoint
} from '@autocatalyst/core';
import {
  DrizzleConfigurationRecordRepository,
  DrizzleProbeResourceRepository,
  SqliteSecretStore,
  checkSqliteDatabaseReachability,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import type { ControlPlaneAppConfig } from './config.js';

export interface ControlPlaneServerOptions {
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly policy?: PolicyDecisionPoint;
  readonly health?: { isDatabaseReachable(): Promise<boolean> };
}

export interface ControlPlaneServerHandle {
  readonly port: number;
  readonly databasePath: string;
  close(): Promise<void>;
}

export async function createControlPlaneServer(
  options: ControlPlaneServerOptions
): Promise<FastifyInstance> {
  if (options.bearerToken.trim().length === 0) {
    throw new Error('Bearer token is required.');
  }
  if (options.masterSecret.trim().length === 0) {
    throw new Error('Master secret is required.');
  }

  const database = createSqliteDatabase({ path: options.databasePath });
  await migrateSqliteDatabase(database);

  const secretStore = new SqliteSecretStore(database);
  await secretStore.unlock(options.masterSecret);

  const app = Fastify({ logger: false });

  await registerControlPlaneRoutes(app, {
    health: options.health ?? {
      isDatabaseReachable: async () => checkSqliteDatabaseReachability(database)
    },
    auth: { bearerToken: options.bearerToken },
    policy: options.policy ?? permissivePolicyDecisionPoint,
    probeResources: new DrizzleProbeResourceRepository(database),
    configurationRecords: new DrizzleConfigurationRecordRepository(database),
    secrets: secretStore
  });

  app.addHook('onClose', async () => {
    database.close();
  });

  return app;
}

export async function startControlPlaneServer(
  config: ControlPlaneAppConfig
): Promise<ControlPlaneServerHandle> {
  const app = await createControlPlaneServer(config);

  await app.listen({ port: config.port, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  return {
    port,
    databasePath: config.databasePath,
    async close() {
      await app.close();
    }
  };
}
