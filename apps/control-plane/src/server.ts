import Fastify, { type FastifyInstance } from 'fastify';

import { registerControlPlaneRoutes } from '@autocatalyst/core';
import {
  DrizzleProbeResourceRepository,
  checkSqliteDatabaseReachability,
  createSqliteDatabase,
  migrateSqliteDatabase,
  type SqliteDatabase
} from '@autocatalyst/persistence';

import type { ControlPlaneAppConfig } from './config.js';

export interface ControlPlaneServerHandle {
  readonly port: number;
  readonly databasePath: string;
  close(): Promise<void>;
}

export async function createControlPlaneServer(database: SqliteDatabase): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await registerControlPlaneRoutes(app, {
    health: {
      isDatabaseReachable: async () => checkSqliteDatabaseReachability(database)
    },
    probeResources: new DrizzleProbeResourceRepository(database)
  });

  return app;
}

export async function startControlPlaneServer(
  config: ControlPlaneAppConfig
): Promise<ControlPlaneServerHandle> {
  const database = createSqliteDatabase({ path: config.databasePath });
  await migrateSqliteDatabase(database);
  const app = await createControlPlaneServer(database);

  await app.listen({ port: config.port, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  return {
    port,
    databasePath: config.databasePath,
    async close() {
      await app.close();
      database.close();
    }
  };
}
