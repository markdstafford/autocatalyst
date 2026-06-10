import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ConfigurationRecord, ExecutionContext, ProviderProfileSettings } from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  composeAgentProviderAdapterRegistry,
  composeDirectProviderAdapterRegistry,
  composeConfiguredProviders,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  DefaultControlPlaneService,
  DefaultOrchestrator,
  defaultExtensionRegistryCatalog,
  emptyProviderAdapterMap,
  InMemoryRetainedRunEventStore,
  permissivePolicyDecisionPoint,
  registerControlPlaneRoutes,
  RunDispatchQueue,
  type ControlPlaneService,
  type ExecutionModeResolution,
  type ExtensionRegistryCatalog,
  type HealthDependencyChecker,
  type PolicyDecisionPoint,
  type ProviderAdapterFactory,
  type ProviderAdapterMap,
  type ProviderCompositionResult,
  type RetainedRunEventStoreOptions,
  type RunUnitOfWork,
  type RunWorkInput
} from '@autocatalyst/core';
import {
  createAgentConnection,
  createAgentRunnerFactory,
  createDirectCallFactory,
  createExecutionEntryPoint,
  createExecutionMaterializer,
  ProviderConfigurationError,
  type AgentConnection,
  type AgentConnectionTelemetryContext,
  type AgentProfileResolution,
  type AgentProviderAdapterRegistry,
  type AgentRunnerFactory,
  type AgentRunnerFactoryInput,
  type ExecutionEntryPoint,
  type ExecutionEntryPointInput,
  type ExecutionBoundaryEvent,
  type MaterializedExecutionEnvironment,
  type ProviderCredentialResolver,
  type ResolvedAgentCredentialReference,
  type ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter
} from '@autocatalyst/claude-agent-adapter';
import {
  anthropicDirectAdapterId,
  anthropicProviderKind,
  createAnthropicDirectAdapter
} from '@autocatalyst/anthropic-direct-adapter';
import {
  createOpenAIDirectAdapter,
  openaiDirectAdapterId,
  openaiProviderKind
} from '@autocatalyst/openai-direct-adapter';
import {
  createOpenAIAgentAdapter,
  openaiAgentAdapterId
} from '@autocatalyst/openai-agent-adapter';
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

export interface RealRunnerDispatchOptions {
  readonly enabled: boolean;
  readonly defaultProviderProfileId?: string;
}

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
  readonly unitOfWork?: RunUnitOfWork;
  readonly onControlPlaneReady?: (service: ControlPlaneService) => void;
  readonly runEventStoreOptions?: RetainedRunEventStoreOptions;
  readonly realRunnerDispatch?: RealRunnerDispatchOptions;
  /**
   * Injectable resolver for execution mode selection. Defaults to always returning agent mode,
   * which preserves existing behavior. Integration tests and real workflows with direct steps
   * should inject a resolver that inspects workflow/step metadata to determine the mode.
   */
  readonly resolveExecutionMode?: (
    input: RunWorkInput,
    context: ExecutionContext
  ) => Promise<ExecutionModeResolution> | ExecutionModeResolution;
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

// ---------------------------------------------------------------------------
// Real runner dispatch wiring
// ---------------------------------------------------------------------------

const defaultModelIdentity = { provider: 'anthropic', model: 'claude-sonnet-4' } as const;

/**
 * Build a profile resolver that always returns the configured
 * `defaultProviderProfileId`. Throws `ProviderConfigurationError` when the
 * record is missing or its adapterId is not present in the registry.
 */
export function createExplicitProfileResolver(input: {
  readonly defaultProviderProfileId: string;
  readonly listRecords: () => Promise<readonly ConfigurationRecord[]>;
  readonly registry: AgentProviderAdapterRegistry;
  readonly selectProviderProfileId?: (factoryInput: AgentRunnerFactoryInput) => string | undefined;
}): (factoryInput: AgentRunnerFactoryInput) => Promise<AgentProfileResolution> {
  return async (factoryInput) => {
    const selectedProfileId = input.selectProviderProfileId?.(factoryInput) ?? input.defaultProviderProfileId;
    if (selectedProfileId.length === 0) {
      throw new ProviderConfigurationError('missing_profile', 'No explicit provider profile id was selected.', { runId: factoryInput.runId, step: factoryInput.step });
    }

    const records = await input.listRecords();
    const record = records.find(
      (candidate) =>
        candidate.id === selectedProfileId && candidate.kind === 'provider_profile'
    );
    if (record === undefined) {
      throw new ProviderConfigurationError(
        'missing_profile',
        `No provider_profile configuration record found with id "${selectedProfileId}".`,
        { runId: factoryInput.runId, step: factoryInput.step }
      );
    }

    const adapterKey = buildProviderAdapterKey(record.providerKind, record.adapterId);
    const adapter = input.registry.get(adapterKey);
    if (adapter === undefined) {
      throw new ProviderConfigurationError(
        'unsupported_adapter',
        `No adapter registered for providerKind "${record.providerKind}" and adapterId "${record.adapterId}".`,
        { providerKind: record.providerKind, adapterId: record.adapterId }
      );
    }

    const settings = record.settings as ProviderProfileSettings;
    const profile: ResolvedAgentRunnerProfile = {
      mode: 'agent',
      providerKind: record.providerKind,
      adapterId: record.adapterId,
      profileName: settings.profileName,
      configurationRecordId: record.id,
      model: settings.model ?? { ...defaultModelIdentity },
      inferenceSettings: settings.inferenceSettings ?? {},
      endpoint: settings.endpoint ?? {},
      connectionMechanism: adapter.supportedConnectionMechanism
    };

    // Derive authTarget from connectionMechanism. For fetch_transport adapters
    // (e.g. OpenAI Agents SDK), the credential is passed as an Authorization header.
    // For process_environment adapters (e.g. Claude Agent SDK), it is injected as
    // an environment variable. A credential is always required — absence is caught
    // by createAgentConnection as a missing_credential error before any session starts.
    const credentialReference: ResolvedAgentCredentialReference = {
      required: true,
      ...(settings.credentialSecretHandle !== undefined
        ? { secretHandle: settings.credentialSecretHandle }
        : {}),
      authTarget: adapter.supportedConnectionMechanism === 'fetch_transport' ? 'header' : 'process_environment'
    };

    return { profile, credentialReference };
  };
}

async function createConnectionFromAgentConnection(
  input: AgentProfileResolution & { readonly telemetryContext: AgentConnectionTelemetryContext },
  secretStore: SqliteSecretStore
): Promise<AgentConnection> {
  const credentialResolver: ProviderCredentialResolver = {
    async resolveCredential(handle: string): Promise<string | undefined> {
      try {
        return await secretStore.resolveSecret(handle);
      } catch {
        return undefined;
      }
    }
  };
  return createAgentConnection({
    profile: input.profile,
    credentialReference: input.credentialReference,
    credentialResolver,
    telemetryContext: input.telemetryContext
  });
}

function createDelegatingExecutionEntryPoint(input: {
  readonly factory: AgentRunnerFactory;
  readonly materialize: (context: ExecutionContext) => Promise<MaterializedExecutionEnvironment>;
}): ExecutionEntryPoint {
  /**
   * Wraps the materializer to ensure a scratch root is always available.
   * For workspace shapes that do not provision a scratch root (e.g. 'none' for
   * question runs), a temporary directory is created so the Claude adapter can
   * write step-result.json and scratch_file validation can read it back.
   */
  async function materializeWithScratch(
    context: ExecutionContext
  ): Promise<MaterializedExecutionEnvironment> {
    const env = await input.materialize(context);
    if (env.workspace.shape !== 'none') {
      return env;
    }
    const scratchRoot = await mkdtemp(join(tmpdir(), `ac-run-${context.run.id}-`));
    return {
      ...env,
      workspace: {
        shape: 'scratch_only',
        scratchRoot,
        workspaceRoots: [scratchRoot]
      },
      toolPolicy: {
        ...env.toolPolicy,
        workspaceRoots: [scratchRoot]
      },
      capabilities: {
        ...env.capabilities,
        paths: { ...env.capabilities.paths, scratchRoot }
      }
    };
  }

  return {
    async *execute(entryInput: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
      const runnerFactoryInput: AgentRunnerFactoryInput = {
        runId: entryInput.context.run.id,
        step: entryInput.context.run.currentStep
      };
      const runner = await input.factory.createRunner(runnerFactoryInput);
      const perRunEntryPoint = createExecutionEntryPoint({
        runner,
        materialize: materializeWithScratch,
        resultValidation: {
          mode: 'scratch_file',
          schema: z.unknown(),
          schemaId: 'any',
          resultFile: 'step-result.json'
        }
      });
      yield* perRunEntryPoint.execute(entryInput);
    }
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

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

  // If real dispatch is enabled and no explicit unitOfWork was provided, register
  // the Claude adapter factory. Callers can still override by providing their own
  // factory with the same key in `providerAdapters`.
  const realDispatchEnabled =
    options.realRunnerDispatch?.enabled === true && options.unitOfWork === undefined;

  const baseAdapters = options.providerAdapters ?? emptyProviderAdapterMap;
  let mergedAdapters: ProviderAdapterMap = baseAdapters;
  if (realDispatchEnabled) {
    const merged = new Map<string, ProviderAdapterFactory>(baseAdapters);
    const claudeKey = buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId);
    if (!merged.has(claudeKey)) {
      merged.set(claudeKey, () => createClaudeAgentAdapter());
    }
    const anthropicDirectKey = buildProviderAdapterKey(anthropicProviderKind, anthropicDirectAdapterId);
    if (!merged.has(anthropicDirectKey)) {
      merged.set(anthropicDirectKey, () => createAnthropicDirectAdapter());
    }
    const openaiDirectKey = buildProviderAdapterKey(openaiProviderKind, openaiDirectAdapterId);
    if (!merged.has(openaiDirectKey)) {
      merged.set(openaiDirectKey, () => createOpenAIDirectAdapter());
    }
    const openaiAgentKey = buildProviderAdapterKey(openaiProviderKind, openaiAgentAdapterId);
    if (!merged.has(openaiAgentKey)) {
      merged.set(openaiAgentKey, () => createOpenAIAgentAdapter());
    }
    mergedAdapters = merged;
  }

  const providerCompositionResult = await composeConfiguredProviders({
    configurationRecords: await configurationRecords.list(),
    registry: options.extensionRegistry ?? defaultExtensionRegistryCatalog,
    providerAdapters: mergedAdapters
  });
  await options.onProviderComposition?.(providerCompositionResult);

  const app = Fastify({ logger: false });

  const domainRepos = createDrizzleDomainRepositories(database);
  const conversationIngress = new DrizzleConversationIngressRepository(database);
  const eventBus = new InMemoryRetainedRunEventStore(options.runEventStoreOptions ?? {
    maxEventsPerScope: 256,
    maxExpiredIdsPerScope: 256,
    subscriberBufferSize: 64
  });
  const dispatchQueue = new RunDispatchQueue({
    maxConcurrent: options.runConcurrency ?? DEFAULT_RUN_CONCURRENCY
  });

  // Build the real dispatch unit of work if requested. `options.unitOfWork`
  // always takes precedence.
  let resolvedUnitOfWork: RunUnitOfWork | undefined = options.unitOfWork;
  if (resolvedUnitOfWork === undefined && realDispatchEnabled) {
    const profileId = options.realRunnerDispatch?.defaultProviderProfileId;
    if (profileId === undefined || profileId.length === 0) {
      throw new Error(
        'realRunnerDispatch.defaultProviderProfileId is required when realRunnerDispatch.enabled is true.'
      );
    }
    const adapterRegistry = composeAgentProviderAdapterRegistry({
      composed: providerCompositionResult.composed
    });
    const directRegistry = composeDirectProviderAdapterRegistry({
      composed: providerCompositionResult.composed
    });
    const resolveProfile = createExplicitProfileResolver({
      defaultProviderProfileId: profileId,
      listRecords: () => configurationRecords.list(),
      registry: adapterRegistry
    });
    const runnerFactory = createAgentRunnerFactory({
      adapters: adapterRegistry,
      resolveProfile,
      createConnection: (input) => createConnectionFromAgentConnection(input, secretStore)
    });
    const directCallFactory = createDirectCallFactory({
      adapters: directRegistry,
      resolveProfile: async (directInput) => {
        // For direct calls, we reuse the explicit profile resolver pattern
        const records = await configurationRecords.list();
        const record = records.find(
          (candidate) =>
            candidate.id === profileId && candidate.kind === 'provider_profile'
        );
        if (record === undefined) {
          throw new ProviderConfigurationError(
            'missing_profile',
            `No provider_profile configuration record found with id "${profileId}".`,
            { runId: directInput.runId, step: directInput.step }
          );
        }
        const settings = record.settings as ProviderProfileSettings;
        // Direct providers always use fetch_transport; authTarget is not applicable for direct profiles.
        return {
          profile: {
            mode: 'direct' as const,
            providerKind: record.providerKind,
            adapterId: record.adapterId,
            profileName: settings.profileName,
            configurationRecordId: record.id,
            model: settings.model ?? { ...defaultModelIdentity },
            inferenceSettings: settings.inferenceSettings ?? {},
            endpoint: settings.endpoint ?? {},
            connectionMechanism: 'fetch_transport' as const
          },
          credentialReference: {
            required: settings.credentialSecretHandle !== undefined,
            ...(settings.credentialSecretHandle !== undefined
              ? { secretHandle: settings.credentialSecretHandle }
              : {})
          }
        };
      },
      createConnection: (input) => createConnectionFromAgentConnection(input, secretStore)
    });
    const materializer = createExecutionMaterializer({
      capabilities: { shellAvailable: false, lspAvailable: false }
    });
    const entryPoint = createDelegatingExecutionEntryPoint({
      factory: runnerFactory,
      materialize: (context) => materializer.materialize(context)
    });
    const contextResolver = createExecutionContextResolver({ secretsAvailable: false });
    resolvedUnitOfWork = createExecutionRunUnitOfWork({
      execute: entryPoint,
      resolveContext: (workInput) => contextResolver.resolve(workInput),
      ...(options.resolveExecutionMode !== undefined && { resolveExecutionMode: options.resolveExecutionMode }),
      eventsStore: eventBus,
      direct: {
        call: (directWorkInput) => directCallFactory.call({
          runId: directWorkInput.runId,
          ...(directWorkInput.phase !== undefined && { phase: directWorkInput.phase }),
          step: directWorkInput.step,
          directCall: directWorkInput.directCall
        })
      }
    });
  }

  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress,
    events: eventBus,
    dispatchQueue,
    ...(resolvedUnitOfWork !== undefined ? { unitOfWork: resolvedUnitOfWork } : {})
  });
  const policy = options.policy ?? permissivePolicyDecisionPoint;
  const controlPlane = new DefaultControlPlaneService({
    orchestrator,
    runs: domainRepos.runs,
    runSteps: domainRepos.runSteps,
    events: eventBus,
    policy
  });
  options.onControlPlaneReady?.(controlPlane);

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

export type StartControlPlaneServerOptions = ControlPlaneAppConfig & {
  readonly unitOfWork?: RunUnitOfWork;
  readonly onControlPlaneReady?: (service: ControlPlaneService) => void;
};

export async function startControlPlaneServer(
  config: StartControlPlaneServerOptions
): Promise<ControlPlaneServerHandle> {
  const app = await createControlPlaneServer({
    ...config,
    onProviderComposition: (result) => {
      logProviderCompositionDiagnostics(result, console);
    },
    ...(config.unitOfWork !== undefined ? { unitOfWork: config.unitOfWork } : {}),
    ...(config.onControlPlaneReady !== undefined ? { onControlPlaneReady: config.onControlPlaneReady } : {})
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
