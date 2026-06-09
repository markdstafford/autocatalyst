import Fastify, { type FastifyInstance } from 'fastify';

import {
  composeConfiguredProviders,
  DefaultControlPlaneService,
  DefaultOrchestrator,
  defaultExtensionRegistryCatalog,
  emptyProviderAdapterMap,
  InMemoryRunEventBus,
  permissivePolicyDecisionPoint,
  registerControlPlaneRoutes,
  RunDispatchQueue,
  type ExtensionRegistryCatalog,
  type HealthDependencyChecker,
  type PolicyDecisionPoint,
  type ProviderAdapterMap,
  type ProviderCompositionResult
} from '@autocatalyst/core';
import {
  DrizzleConfigurationRecordRepository,
  DrizzleConversationIngressRepository,
  DrizzleProbeResourceRepository,
  SqliteSecretStore,
  checkSqliteDatabaseReachability,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import type { ControlPlaneAppConfig } from './config.js';

export interface ControlPlaneServerOptions {
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly runConcurrency?: number;
  readonly policy?: PolicyDecisionPoint;
  readonly health?: HealthDependencyChecker;
  readonly extensionRegistry?: ExtensionRegistryCatalog;
  readonly providerAdapters?: ProviderAdapterMap;
  readonly onProviderComposition?: (result: ProviderCompositionResult) => void | Promise<void>;
}

const DEFAULT_RUN_CONCURRENCY = 2;

export interface ControlPlaneServerHandle {
  readonly port: number;
  readonly databasePath: string;
  close(): Promise<void>;
}

export interface ProviderCompositionDiagnosticLogger {
  info(message: string): void;
  warn(message: string): void;
}

export function logProviderCompositionDiagnostics(
  result: ProviderCompositionResult,
  logger: ProviderCompositionDiagnosticLogger = console
): void {
  logger.info(
    `Provider composition completed: composed=${result.composed.length} warnings=${result.warnings.length} unresolved=${result.unresolved.length}.`
  );

  for (const binding of result.composed) {
    logger.info(
      `Provider composed: configurationRecordId=${binding.configurationRecordId} providerKind=${binding.providerKind} adapterId=${binding.adapterId}.`
    );
  }

  for (const warning of result.warnings) {
    logger.warn(
      `Provider composition warning: configurationRecordId=${warning.configurationRecordId} providerKind=${warning.providerKind} adapterId=${warning.adapterId} code=${warning.code}.`
    );
  }

  for (const unresolved of result.unresolved) {
    logger.warn(
      `Provider unresolved: configurationRecordId=${unresolved.configurationRecordId} providerKind=${unresolved.providerKind} adapterId=${unresolved.adapterId} reason=${unresolved.reason}.`
    );
  }
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

  const configurationRecords = new DrizzleConfigurationRecordRepository(database);
  const providerCompositionResult = await composeConfiguredProviders({
    configurationRecords: await configurationRecords.list(),
    registry: options.extensionRegistry ?? defaultExtensionRegistryCatalog,
    providerAdapters: options.providerAdapters ?? emptyProviderAdapterMap
  });
  await options.onProviderComposition?.(providerCompositionResult);

  const app = Fastify({ logger: false });

  const domainRepos = createDrizzleDomainRepositories(database);
  const conversationIngress = new DrizzleConversationIngressRepository(database);
  const eventBus = new InMemoryRunEventBus();
  const dispatchQueue = new RunDispatchQueue({
    maxConcurrent: options.runConcurrency ?? DEFAULT_RUN_CONCURRENCY
  });
  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress,
    events: eventBus,
    dispatchQueue
  });
  const policy = options.policy ?? permissivePolicyDecisionPoint;
  const controlPlane = new DefaultControlPlaneService({
    orchestrator,
    runs: domainRepos.runs,
    runSteps: domainRepos.runSteps,
    events: eventBus,
    policy
  });

  await registerControlPlaneRoutes(app, {
    health: options.health ?? {
      isDatabaseReachable: async () => checkSqliteDatabaseReachability(database)
    },
    auth: { bearerToken: options.bearerToken },
    policy,
    probeResources: new DrizzleProbeResourceRepository(database),
    configurationRecords,
    secrets: secretStore,
    controlPlane
  });

  app.addHook('onClose', async () => {
    database.close();
  });

  return app;
}

export async function startControlPlaneServer(
  config: ControlPlaneAppConfig
): Promise<ControlPlaneServerHandle> {
  const app = await createControlPlaneServer({
    ...config,
    onProviderComposition: (result) => {
      logProviderCompositionDiagnostics(result, console);
    }
  });

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
