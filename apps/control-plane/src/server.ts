import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { sessionRoleSchema } from '@autocatalyst/api-contract';
import type { ConfigurationRecord, Conversation, ExecutionContext, Project, ProviderProfileSettings, Topic } from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  buildImplementationBuildContext,
  buildSpecAuthorContext,
  composeAgentProviderAdapterRegistry,
  composeDirectProviderAdapterRegistry,
  composeConfiguredProviders,
  createLayeredConvergenceEngine,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  createModelRoutingResolver,
  DefaultControlPlaneService,
  DefaultOrchestrator,
  defaultExtensionRegistryCatalog,
  emptyProviderAdapterMap,
  ExecutionContextResolutionError,
  getStepConvergencePolicy,
  InMemoryRetainedRunEventStore,
  ModelRoutingConfigurationError,
  permissivePolicyDecisionPoint,
  registerControlPlaneRoutes,
  RunDispatchQueue,
  type AutoDispatchOptions,
  type ConvergenceEngine,
  type ControlPlaneService,
  type DomainRepositories,
  type ExecutionModeResolution,
  type ExtensionRegistryCatalog,
  type FeedbackLifecycleDependencies,
  type HealthDependencyChecker,
  type ModelRoutingResolver,
  type PolicyDecisionPoint,
  type ProviderAdapterFactory,
  type ProviderAdapterMap,
  type ProviderCompositionResult,
  type RetainedRunEventStoreOptions,
  type RunUnitOfWork,
  type RunWorkInput,
  type SpecAuthoringServiceDependencies,
  type SpecApprovalFinalizerDependencies,
  type WorkspaceContextResolver,
  type WorkspaceFileSystemPort,
  type WorkspaceGitPort,
  type WorkspaceResolverInput,
  type RunRoleWorkInput
} from '@autocatalyst/core';
import { createReviewedExecutionDispatcher } from './reviewed-execution-dispatcher.js';
import { createRunWorkspaceGitPort } from './run-workspace-git-port.js';
import { loadSpecAuthorPromptInput, SpecAuthoringContextLoadError } from './spec-authoring-context-loader.js';
import {
  createAgentConnection,
  createAgentRunnerFactory,
  createDirectCallFactory,
  createExecutionEntryPoint,
  createExecutionMaterializer,
  createStepResultContractRegistry,
  registerReviewerResultContract,
  registerSpecAuthorResultContract,
  type StepResultContractRegistry,
  REVIEWER_RESULT_SCHEMA_ID,
  SPEC_AUTHOR_SCHEMA_ID,
  ProviderConfigurationError,
  type AgentConnection,
  type AgentConnectionTelemetryContext,
  type AgentProfileResolution,
  type AgentProviderAdapterRegistry,
  type AgentRunnerFactory,
  type AgentRunnerFactoryInput,
  type DirectCallFactoryInput,
  type DirectProfileResolution,
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

export interface WorkspaceRootOptions {
  readonly reposRoot: string;
  readonly workspacesRoot: string;
}

export interface ControlPlaneServerOptions {
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly runConcurrency?: number;
  readonly workspaceRoots?: WorkspaceRootOptions;
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
  /**
   * Resolves the workspace repo root and handle for a run. Required for spec.author completion
   * and spec.human_review approval finalization in feature and enhancement workflows.
   * When not provided, spec authoring side effects and approval finalization are skipped.
   */
  readonly resolveWorkspaceContext?: WorkspaceContextResolver;
  /**
   * Auto-dispatch configuration for the orchestrator. Production defaults to enabled, so a created
   * run advances through its system and AI steps on its own. Integration tests that drive a run
   * deterministically through `tick` pass `{ enabled: false }` to keep manual control.
   */
  readonly autoDispatch?: AutoDispatchOptions;
  /**
   * Injectable convergence engine for integration tests. When provided, this engine is used for
   * implementation.build dispatch instead of the real layered convergence engine. Allows tests
   * to drive the full orchestrator dispatch path (including feedback disposition side effects)
   * without requiring live AI providers. Only effective when `unitOfWork` is also provided or when
   * `realRunnerDispatch` is not enabled.
   */
  readonly convergenceEngine?: ConvergenceEngine;
  /**
   * GitHub username or service identity to stamp as specced_by on spec.author results.
   * Derived from the authenticated PAT login when available. Falls back to 'autocatalyst'.
   */
  readonly specAuthorIdentity?: string;
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
      (candidate): candidate is Extract<ConfigurationRecord, { kind: 'provider_profile' }> =>
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

/**
 * Bridge between dispatch-layer factory inputs and the model-routing resolver.
 * Returned helpers extract `tenant`/`role` from factory inputs, defaulting tenant
 * to `fallbackTenant` when absent. ModelRoutingConfigurationError is left to
 * propagate so callers can preserve the typed routing error code (and optionally
 * fall back to an explicit profile when `routing_table_missing`).
 */
export function createRoutingProfileResolver(options: {
  readonly resolver: ModelRoutingResolver;
  readonly fallbackTenant?: string;
}): {
  resolveAgentProfile(factoryInput: AgentRunnerFactoryInput): Promise<AgentProfileResolution>;
  resolveDirectProfile(factoryInput: DirectCallFactoryInput): Promise<DirectProfileResolution>;
} {
  return {
    async resolveAgentProfile(factoryInput) {
      const tenant = factoryInput.tenant ?? options.fallbackTenant;
      if (tenant === undefined || tenant.length === 0) {
        throw new ProviderConfigurationError(
          'missing_profile',
          'No tenant available for routing.',
          { runId: factoryInput.runId, step: factoryInput.step }
        );
      }
      const roleParse = sessionRoleSchema.safeParse(factoryInput.role);
      if (!roleParse.success) {
        throw new ModelRoutingConfigurationError(
          'route_not_found',
          'No valid role available for agent routing.',
          { tenant, runId: factoryInput.runId, step: factoryInput.step, mode: 'agent' }
        );
      }
      const resolution = await options.resolver.resolveAgentRoute({
        tenant,
        runId: factoryInput.runId,
        step: factoryInput.step,
        role: roleParse.data
      });
      return { profile: resolution.profile, credentialReference: resolution.credentialReference };
    },
    async resolveDirectProfile(factoryInput) {
      const tenant = factoryInput.tenant ?? options.fallbackTenant;
      if (tenant === undefined || tenant.length === 0) {
        throw new ProviderConfigurationError(
          'missing_profile',
          'No tenant available for direct routing.',
          { runId: factoryInput.runId, step: factoryInput.step }
        );
      }
      const resolution = await options.resolver.resolveDirectRoute({
        tenant,
        runId: factoryInput.runId,
        step: factoryInput.step
      });
      return { profile: resolution.profile, credentialReference: resolution.credentialReference };
    }
  };
}

// Default registry used by tests and as fallback. Uses 'autocatalyst' as specced_by.
const defaultStepResultContractRegistry = registerReviewerResultContract(
  registerSpecAuthorResultContract(createStepResultContractRegistry())
);

export function resolveScratchResultValidationConfig(
  context: ExecutionContext,
  registry: StepResultContractRegistry = defaultStepResultContractRegistry
) {
  const step = context.run.currentStep;
  const workKind = context.run.workKind;
  const role = context.task.inputs['role'];

  if (step === 'spec.author' && (workKind === 'feature' || workKind === 'enhancement')) {
    return {
      mode: 'scratch_file' as const,
      contractRegistry: registry,
      step: 'spec.author',
      schemaId: SPEC_AUTHOR_SCHEMA_ID,
      resultFile: 'step-result.json'
    };
  }

  if (step === 'implementation.build' && role === 'reviewer') {
    return {
      mode: 'scratch_file' as const,
      contractRegistry: registry,
      step: 'implementation.build',
      schemaId: REVIEWER_RESULT_SCHEMA_ID,
      resultFile: 'step-result.json'
    };
  }

  return {
    mode: 'scratch_file' as const,
    schema: z.unknown(),
    schemaId: 'any',
    resultFile: 'step-result.json'
  };
}

export function createDelegatingExecutionEntryPoint(input: {
  readonly factory: AgentRunnerFactory;
  readonly materialize: (context: ExecutionContext) => Promise<MaterializedExecutionEnvironment>;
  readonly resolveRole?: (step: string) => string;
  readonly onWorkspaceRootResolved?: (runId: string, repoRoot: string) => void;
  readonly registry?: StepResultContractRegistry;
}): ExecutionEntryPoint {
  const { resolveRole } = input;
  /**
   * Wraps the materializer to ensure a scratch root is always available.
   * For workspace shapes that do not provision a scratch root (e.g. 'none' for
   * question runs), a temporary directory is created so the Claude adapter can
   * write step-result.json and scratch_file validation can read it back.
   * Also registers the repo root for two_roots workspaces so spec authoring can
   * resolve the workspace path without importing execution internals.
   */
  async function materializeWithScratch(
    context: ExecutionContext
  ): Promise<MaterializedExecutionEnvironment> {
    const env = await input.materialize(context);
    if (env.workspace.shape === 'two_roots') {
      input.onWorkspaceRootResolved?.(context.run.id, env.workspace.repoRoot);
      return env;
    }
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
      // Prefer the role injected into task inputs by the convergence dispatcher;
      // fall back to the resolveRole callback for non-convergence steps.
      const taskInputRole = entryInput.context.task?.inputs?.['role'];
      const resolvedRole = typeof taskInputRole === 'string'
        ? taskInputRole
        : resolveRole !== undefined ? resolveRole(entryInput.context.run.currentStep) : undefined;
      const runnerFactoryInput: AgentRunnerFactoryInput = {
        runId: entryInput.context.run.id,
        step: entryInput.context.run.currentStep,
        tenant: entryInput.context.run.tenant,
        ...(resolvedRole !== undefined ? { role: resolvedRole } : {})
      };
      const runner = await input.factory.createRunner(runnerFactoryInput);
      const perRunEntryPoint = createExecutionEntryPoint({
        runner,
        materialize: materializeWithScratch,
        resultValidation: (entryInput) => resolveScratchResultValidationConfig(entryInput.context, input.registry)
      });
      yield* perRunEntryPoint.execute(entryInput);
    }
  };
}

// ---------------------------------------------------------------------------
// Production workspace ports
// ---------------------------------------------------------------------------

function assertWithinWorkspaceRootLexical(workspaceRepoRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error('Workspace path must be relative.');
  }
  const fullPath = resolve(workspaceRepoRoot, relativePath);
  const rel = relative(workspaceRepoRoot, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Workspace path escapes the workspace root.');
  }
  return fullPath;
}

async function assertRealPathWithinWorkspaceRoot(
  realWorkspaceRoot: string,
  realFullPath: string
): Promise<void> {
  const rel = relative(realWorkspaceRoot, realFullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Resolved real path escapes the workspace root.');
  }
}

export function createNodeWorkspaceFilesystem(): WorkspaceFileSystemPort {
  return {
    async writeFile(input) {
      const fullPath = assertWithinWorkspaceRootLexical(input.workspaceRepoRoot, input.relativePath);
      const parentDir = dirname(fullPath);

      const realWorkspaceRoot = await realpath(input.workspaceRepoRoot);

      // Find the nearest existing ancestor of the target parent directory by walking
      // upward until lstat succeeds. We must do this BEFORE calling mkdir so that
      // an intermediate symlink (e.g. context-human -> /outside) cannot cause mkdir
      // to create directories outside the workspace before the containment check runs.
      let ancestor = parentDir;
      while (true) {
        try {
          await lstat(ancestor);
          break; // path exists — stop walking
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          const parent = dirname(ancestor);
          if (parent === ancestor) break; // reached filesystem root
          ancestor = parent;
        }
      }

      // Lstat every path component from workspaceRepoRoot to the nearest existing
      // ancestor, rejecting symlinks before any directory is created.
      const relFromRoot = relative(input.workspaceRepoRoot, ancestor);
      if (relFromRoot !== '' && !relFromRoot.startsWith('..') && !isAbsolute(relFromRoot)) {
        const segments = relFromRoot.split('/').filter(Boolean);
        let current = input.workspaceRepoRoot;
        for (const segment of segments) {
          current = join(current, segment);
          const componentStat = await lstat(current);
          if (componentStat.isSymbolicLink()) {
            throw new Error(
              `Symlink found in workspace path component before mkdir; refusing to create directories: ${relative(input.workspaceRepoRoot, current)}`
            );
          }
        }
      }

      // Resolve the canonical realpath of the verified existing ancestor and check
      // it is inside the real workspace root.
      const realAncestor = await realpath(ancestor);
      await assertRealPathWithinWorkspaceRoot(realWorkspaceRoot, realAncestor);

      // Derive the resolved parent directory by appending the remaining (not-yet-created)
      // path segments to the verified real ancestor and verify containment.
      const resolvedParentDir = resolve(realAncestor, relative(ancestor, parentDir));
      await assertRealPathWithinWorkspaceRoot(realWorkspaceRoot, resolvedParentDir);

      // Only now create the missing directories inside the verified real tree.
      await mkdir(resolvedParentDir, { recursive: true });

      // Reject target paths that are symlinks — writing through a symlink could
      // overwrite a file outside the workspace even though the lexical path looks safe.
      const resolvedFull = resolve(resolvedParentDir, basename(fullPath));
      try {
        const targetStat = await lstat(resolvedFull);
        if (targetStat.isSymbolicLink()) {
          throw new Error('Target path is a symlink; writing to symlinks is not permitted.');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
        // ENOENT: file does not yet exist — real ancestor containment check above is sufficient.
      }

      await writeFile(resolvedFull, input.contents, 'utf-8');
    },
    async readFile(input) {
      const fullPath = assertWithinWorkspaceRootLexical(input.workspaceRepoRoot, input.relativePath);

      // Resolve all symlinks in the full path and verify real containment.
      const realWorkspaceRoot = await realpath(input.workspaceRepoRoot);
      const realFull = await realpath(fullPath);
      await assertRealPathWithinWorkspaceRoot(realWorkspaceRoot, realFull);

      return readFile(fullPath, 'utf-8');
    }
  };
}

function createNodeWorkspaceGit(): WorkspaceGitPort {
  return {
    async commitFiles(input) {
      const cwd = input.workspaceRepoRoot;
      await execFileAsync('git', ['-C', cwd, 'add', '--', ...input.relativePaths]);
      try {
        await execFileAsync('git', [
          '-C', cwd,
          '-c', 'user.name=Autocatalyst',
          '-c', 'user.email=autocatalyst@local',
          'commit', '-m', input.message
        ]);
      } catch (err) {
        // Tolerate "nothing to commit" on retry — treat as success.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('nothing to commit') && !msg.includes('nothing added to commit')) {
          throw err;
        }
      }
      return {};
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

  const startupCompositionTenant = 'tenant_dev';
  const providerCompositionResult = await composeConfiguredProviders({
    configurationRecords: await configurationRecords.list(startupCompositionTenant),
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

  // Registry that maps runId → repoRoot for two_roots workspaces.
  // Populated during materialization so spec authoring and approval can resolve the
  // workspace path without importing execution internals.
  const runWorkspaceRootRegistry = new Map<string, string>();

  // ---------------------------------------------------------------------------
  // Workspace input helpers (used in resolveContext below)
  // ---------------------------------------------------------------------------

  const WORKSPACE_BACKED_WORK_KINDS = new Set(['feature', 'enhancement', 'bug', 'chore', 'file_issue']);

  function isWorkspaceBackedWorkKind(workKind: string): boolean {
    return WORKSPACE_BACKED_WORK_KINDS.has(workKind);
  }

  function deriveTopicSlug(title: string): string {
    const slug = title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 80);
    return slug.length > 0 ? slug : 'topic';
  }

  function deriveShortRunId(runId: string): string {
    const withoutPrefix = runId.startsWith('run_') ? runId.slice(4) : runId;
    const compact = withoutPrefix.replace(/[^a-zA-Z0-9]/gu, '');
    return compact.length > 0 ? compact.slice(0, 8) : runId.slice(0, 8);
  }

  function assertTenantMatch(input: {
    readonly entityName: 'topic' | 'conversation' | 'project';
    readonly entity: Topic | Conversation | Project;
    readonly expectedTenant: string;
    readonly runId: string;
  }): void {
    if (input.entity.tenant !== input.expectedTenant) {
      throw new ExecutionContextResolutionError(
        'resolver_unavailable',
        `Cannot resolve workspace context for run '${input.runId}'.`,
        { reason: `${input.entityName}_tenant_mismatch`, runId: input.runId }
      );
    }
  }

  async function resolveWorkspaceInputForRun(input: {
    readonly workInput: RunWorkInput;
    readonly roots: WorkspaceRootOptions | undefined;
    readonly repositories: DomainRepositories;
  }): Promise<WorkspaceResolverInput | undefined> {
    const { workInput, roots, repositories } = input;
    if (!isWorkspaceBackedWorkKind(workInput.run.workKind)) {
      return undefined;
    }
    if (roots === undefined) {
      throw new ExecutionContextResolutionError(
        'missing_workspace_settings',
        `Workspace-backed work kind '${workInput.run.workKind}' requires configured repos and workspaces roots.`
      );
    }

    const topic = await repositories.topics.findById(workInput.run.topicId);
    if (topic === null) {
      throw new ExecutionContextResolutionError(
        'resolver_unavailable',
        `Cannot resolve workspace context for run '${workInput.runId}'.`,
        { reason: 'topic_not_found', runId: workInput.runId }
      );
    }
    assertTenantMatch({ entityName: 'topic', entity: topic, expectedTenant: workInput.tenant, runId: workInput.runId });

    const conversation = await repositories.conversations.findById(topic.conversationId);
    if (conversation === null) {
      throw new ExecutionContextResolutionError(
        'resolver_unavailable',
        `Cannot resolve workspace context for run '${workInput.runId}'.`,
        { reason: 'conversation_not_found', runId: workInput.runId }
      );
    }
    assertTenantMatch({ entityName: 'conversation', entity: conversation, expectedTenant: workInput.tenant, runId: workInput.runId });

    const project = await repositories.projects.findById(conversation.projectId);
    if (project === null) {
      throw new ExecutionContextResolutionError(
        'resolver_unavailable',
        `Cannot resolve workspace context for run '${workInput.runId}'.`,
        { reason: 'project_not_found', runId: workInput.runId }
      );
    }
    assertTenantMatch({ entityName: 'project', entity: project, expectedTenant: workInput.tenant, runId: workInput.runId });

    return {
      project,
      roots,
      topicSlug: deriveTopicSlug(topic.title),
      shortRunId: deriveShortRunId(workInput.runId)
    };
  }

  // Build the real dispatch unit of work if requested. `options.unitOfWork`
  // always takes precedence.
  let resolvedUnitOfWork: RunUnitOfWork | undefined = options.unitOfWork;
  // Convergence engine is composed only when we build the real dispatch unit of work.
  // It needs the routing resolver, the execution-aware unit of work (for runWithCheckpoint),
  // and a workspace git port — all of which are only available in the real-dispatch branch.
  // An explicitly injected convergenceEngine (e.g. from integration tests) takes priority.
  let convergenceEngine: ConvergenceEngine | undefined = options.convergenceEngine;
  if (convergenceEngine === undefined && resolvedUnitOfWork === undefined && realDispatchEnabled) {
    const profileId = options.realRunnerDispatch?.defaultProviderProfileId;
    const adapterRegistry = composeAgentProviderAdapterRegistry({
      composed: providerCompositionResult.composed
    });
    const directRegistry = composeDirectProviderAdapterRegistry({
      composed: providerCompositionResult.composed
    });

    // Build the routing resolver and its dispatch-input bridge. Routing is the
    // default profile-resolution mode; an explicit `defaultProviderProfileId`
    // (when provided) acts as a fallback used only when no active routing table
    // exists for the tenant — preserving backward compatibility with callers
    // that have not yet configured routing.
    const routingResolver = createModelRoutingResolver({
      configuration: {
        listConfigurationRecords: (tenant) => configurationRecords.list(tenant),
        findConfigurationRecordById: (tenant, id) => configurationRecords.findById(tenant, id)
      },
      agentAdapters: adapterRegistry,
      directAdapters: directRegistry
    });
    const routingProfileHelper = createRoutingProfileResolver({
      resolver: routingResolver,
      fallbackTenant: startupCompositionTenant
    });

    const explicitProfileFallback = profileId !== undefined && profileId.length > 0
      ? createExplicitProfileResolver({
          defaultProviderProfileId: profileId,
          listRecords: () => configurationRecords.list(startupCompositionTenant),
          registry: adapterRegistry
        })
      : undefined;

    const resolveProfile = async (
      factoryInput: AgentRunnerFactoryInput
    ): Promise<AgentProfileResolution> => {
      try {
        return await routingProfileHelper.resolveAgentProfile(factoryInput);
      } catch (err) {
        if (
          err instanceof ModelRoutingConfigurationError &&
          err.code === 'routing_table_missing' &&
          explicitProfileFallback !== undefined
        ) {
          return explicitProfileFallback(factoryInput);
        }
        throw err;
      }
    };

    const runnerFactory = createAgentRunnerFactory({
      adapters: adapterRegistry,
      resolveProfile,
      createConnection: (input) => createConnectionFromAgentConnection(input, secretStore)
    });
    const directCallFactory = createDirectCallFactory({
      adapters: directRegistry,
      resolveProfile: async (directInput) => {
        try {
          return await routingProfileHelper.resolveDirectProfile(directInput);
        } catch (err) {
          if (
            err instanceof ModelRoutingConfigurationError &&
            err.code === 'routing_table_missing' &&
            profileId !== undefined &&
            profileId.length > 0
          ) {
            // Fall back to the explicit profile for direct calls when no
            // active routing table is configured.
            const fallbackTenant = directInput.tenant ?? startupCompositionTenant;
            const records = await configurationRecords.list(fallbackTenant);
            const record = records.find(
              (candidate): candidate is Extract<ConfigurationRecord, { kind: 'provider_profile' }> =>
                candidate.id === profileId && candidate.kind === 'provider_profile'
            );
            if (record === undefined) {
              throw new ProviderConfigurationError(
                'missing_profile',
                `No provider_profile configuration record found with id "${profileId}".`,
                { runId: directInput.runId, step: directInput.step }
              );
            }
            const adapterKey = buildProviderAdapterKey(record.providerKind, record.adapterId);
            if (!directRegistry.has(adapterKey)) {
              throw new ProviderConfigurationError(
                'missing_profile',
                `No direct adapter registered for providerKind "${record.providerKind}" and adapterId "${record.adapterId}".`,
                { providerKind: record.providerKind, adapterId: record.adapterId }
              );
            }
            const settings = record.settings as ProviderProfileSettings;
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
          }
          throw err;
        }
      },
      createConnection: (input) => createConnectionFromAgentConnection(input, secretStore)
    });
    const materializer = createExecutionMaterializer({
      capabilities: { shellAvailable: false, lspAvailable: false }
    });
    const stepResultContractRegistry = registerReviewerResultContract(
      registerSpecAuthorResultContract(
        createStepResultContractRegistry(),
        options.specAuthorIdentity !== undefined
          ? { trustedSpeccedBy: options.specAuthorIdentity }
          : {}
      )
    );
    const entryPoint = createDelegatingExecutionEntryPoint({
      factory: runnerFactory,
      materialize: (context) => materializer.materialize(context),
      // Default to 'implementer' for routing until per-step role catalog is wired in.
      resolveRole: (step) => {
        void step;
        return 'implementer';
      },
      onWorkspaceRootResolved: (runId, repoRoot) => {
        runWorkspaceRootRegistry.set(runId, repoRoot);
      },
      registry: stepResultContractRegistry
    });
    const executionUnitOfWork = createExecutionRunUnitOfWork({
      execute: entryPoint,
      resolveContext: async (workInput) => {
        const workspace = await resolveWorkspaceInputForRun({
          workInput,
          roots: options.workspaceRoots,
          repositories: domainRepos
        });

        // Load spec-authoring context for spec.author runs
        let specAuthorContext: ReturnType<typeof buildSpecAuthorContext> | undefined;
        if (
          workInput.run.currentStep === 'spec.author' &&
          (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
        ) {
          try {
            const promptInput = await loadSpecAuthorPromptInput({
              runId: workInput.runId,
              tenantId: workInput.tenant,
              repositories: domainRepos
            });
            specAuthorContext = buildSpecAuthorContext({
              ...promptInput,
              ...(options.specAuthorIdentity !== undefined ? { specAuthorIdentity: options.specAuthorIdentity } : {})
            });
          } catch (error) {
            if (error instanceof SpecAuthoringContextLoadError) {
              throw new ExecutionContextResolutionError(
                'resolver_unavailable',
                'Cannot resolve spec authoring context.',
                { reason: error.code, runId: workInput.runId, step: workInput.run.currentStep, workKind: workInput.run.workKind }
              );
            }
            throw error;
          }
        }

        const isReadOnlySession = (workInput as RunRoleWorkInput).toolPolicyMode === 'read_only';

        const roleInput = workInput as RunRoleWorkInput;
        const isImplementationBuildRoleSession =
          workInput.run.currentStep === 'implementation.build' &&
          roleInput.role !== undefined &&
          roleInput.round !== undefined;

        let implementationBuildContext: ReturnType<typeof buildImplementationBuildContext> | undefined;
        if (isImplementationBuildRoleSession) {
          let approvedSpec: {
            kind: 'feature_spec' | 'enhancement_spec';
            relativePath: string;
            cachedStatus?: string;
          } | undefined;

          if (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement') {
            try {
              const artifact = await domainRepos.artifacts.findByRunAndKind({
                runId: workInput.run.id,
                kind: workInput.run.workKind === 'feature' ? 'feature_spec' : 'enhancement_spec'
              });
              if (artifact !== null && artifact !== undefined) {
                approvedSpec = {
                  kind: workInput.run.workKind === 'feature' ? 'feature_spec' : 'enhancement_spec',
                  relativePath: artifact.location,
                  ...(artifact.cachedStatus !== undefined ? { cachedStatus: String(artifact.cachedStatus) } : {})
                };
              }
            } catch {
              // Approved spec is optional; continue without it if lookup fails.
            }
          }

          implementationBuildContext = buildImplementationBuildContext({
            run: workInput.run,
            role: roleInput.role as 'implementer' | 'reviewer',
            round: roleInput.round,
            ...(approvedSpec !== undefined ? { approvedSpec } : {}),
            ...(roleInput.reviewContext !== undefined ? { reviewContext: roleInput.reviewContext } : {})
          });
        }

        return createExecutionContextResolver({
          secretsAvailable: false,
          ...(workspace !== undefined ? { workspace } : {}),
          // Reviewer sessions must not receive write-capable tools.
          ...(isReadOnlySession ? { toolPolicy: { allowedTools: ['Read', 'Glob', 'Grep'] as string[] } } : {}),
          prompt: (input) => {
            if (input.run.currentStep === 'spec.author') return specAuthorContext?.prompt;
            if (input.run.currentStep === 'implementation.build') return implementationBuildContext?.prompt;
            return undefined;
          },
          taskInputs: (input) => {
            // Spec-authoring step gets its own task inputs.
            if (input.run.currentStep === 'spec.author') {
              return specAuthorContext?.taskInputs as Record<string, unknown> | undefined;
            }

            if (input.run.currentStep === 'implementation.build' && implementationBuildContext !== undefined) {
              return implementationBuildContext.taskInputs as unknown as Record<string, unknown>;
            }

            // Reviewed role sessions: inject role/round and review context so
            // the agent knows its position in the convergence loop. This is
            // an agent-quality hint — the security boundary is tool policy, not prompt text.
            const roleInput = input as RunRoleWorkInput;
            if (roleInput.role !== undefined && roleInput.round !== undefined) {
              const base: Record<string, unknown> = {
                role: roleInput.role,
                round: roleInput.round
              };

              if (roleInput.role === 'reviewer') {
                base['sessionMode'] = 'code_review';
                base['accessMode'] = 'read_only';
              }

              if (roleInput.role === 'implementer' && roleInput.reviewContext !== undefined) {
                const { reviewContext } = roleInput;
                if (reviewContext.previousFindings !== undefined && reviewContext.previousFindings.length > 0) {
                  base['previousFindings'] = reviewContext.previousFindings;
                }
                if (reviewContext.requiredDispositions !== undefined && reviewContext.requiredDispositions.length > 0) {
                  base['requiredDispositions'] = reviewContext.requiredDispositions;
                }
                if (reviewContext.previousRounds !== undefined && reviewContext.previousRounds.length > 0) {
                  base['previousRoundCount'] = reviewContext.previousRounds.length;
                }
              }

              // Forward altitude context for both implementer and reviewer sessions so
              // the agent knows which altitude it is executing at, what work is allowed,
              // and what checkpoints exist. This is an agent-quality hint only —
              // the security boundary is tool policy, not prompt text.
              const altCtx = roleInput.reviewContext?.altitudeContext;
              if (altCtx !== undefined) {
                base['altitude'] = altCtx.altitude;
                base['altitudeRound'] = altCtx.altitudeRound;
                base['allowedWork'] = altCtx.allowedWork;
                base['acceptedCheckpoints'] = altCtx.acceptedCheckpoints;
                base['findingCategories'] = altCtx.findingCategories;
              }

              return base;
            }

            return undefined;
          }
        }).resolve(workInput);
      },
      ...(options.resolveExecutionMode !== undefined && { resolveExecutionMode: options.resolveExecutionMode }),
      eventsStore: eventBus,
      direct: {
        call: (directWorkInput) => directCallFactory.call({
          runId: directWorkInput.runId,
          tenant: directWorkInput.tenant,
          ...(directWorkInput.phase !== undefined && { phase: directWorkInput.phase }),
          step: directWorkInput.step,
          directCall: directWorkInput.directCall
        })
      }
    });
    resolvedUnitOfWork = executionUnitOfWork;

    // Compose convergence-engine dependencies for reviewed producing steps.
    // The workspace git port verifies commits stay inside the configured workspaces root;
    // it is only available when workspaceRoots are configured by the caller.
    if (options.workspaceRoots !== undefined) {
      const runWorkspaceGit = createRunWorkspaceGitPort({
        workspacesRoot: options.workspaceRoots.workspacesRoot
      });
      const reviewedExecutionDispatcher = createReviewedExecutionDispatcher({
        unitOfWork: executionUnitOfWork
      });
      convergenceEngine = createLayeredConvergenceEngine({
        dispatcher: reviewedExecutionDispatcher,
        git: runWorkspaceGit,
        feedback: domainRepos.feedback,
        runSteps: domainRepos.runSteps,
        routing: routingResolver,
        getPolicy: getStepConvergencePolicy,
        logger: {
          warn(message: string, details?: unknown) {
            console.warn(message, details);
          }
        }
      });
    }
  }

  const nodeFilesystem = createNodeWorkspaceFilesystem();
  const nodeGit = createNodeWorkspaceGit();

  const feedbackLifecycleDependencies: FeedbackLifecycleDependencies = {
    feedback: domainRepos.feedback,
    ids: () => randomUUID(),
    clock: () => new Date().toISOString()
  };

  const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
    artifacts: domainRepos.artifacts,
    filesystem: nodeFilesystem,
    git: nodeGit,
    clock: () => new Date().toISOString()
  };

  const specApprovalFinalizerDependencies: SpecApprovalFinalizerDependencies = {
    artifacts: domainRepos.artifacts,
    filesystem: nodeFilesystem,
    git: nodeGit,
    clock: () => new Date().toISOString()
  };

  // Resolve workspace root: try in-memory registry first (populated during materialization),
  // then fall back to the persistent run_workspace_metadata store for post-restart recovery.
  const internalResolveWorkspaceContext: WorkspaceContextResolver = async ({ runId }) => {
    const repoRoot = runWorkspaceRootRegistry.get(runId);
    if (repoRoot !== undefined) {
      return { workspaceRepoRoot: repoRoot, workspaceHandle: runId };
    }
    const persisted = await domainRepos.runWorkspaceMetadata.findByRunId(runId);
    if (persisted !== null) {
      return { workspaceRepoRoot: persisted.workspaceRepoRoot, workspaceHandle: persisted.workspaceHandle };
    }
    throw new Error(`Workspace root not available for run '${runId}'. The run may not have been dispatched yet.`);
  };

  const orchestrator = new DefaultOrchestrator({
    runs: domainRepos.runs,
    conversationIngress,
    events: eventBus,
    dispatchQueue,
    ...(resolvedUnitOfWork !== undefined ? { unitOfWork: resolvedUnitOfWork } : {}),
    feedbackLifecycleDependencies,
    specAuthoringDependencies,
    specApprovalFinalizerDependencies,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    resolveWorkspaceContext: options.resolveWorkspaceContext ?? internalResolveWorkspaceContext,
    runSteps: domainRepos.runSteps,
    ...(convergenceEngine !== undefined ? { convergenceEngine } : {}),
    ...(options.autoDispatch !== undefined ? { autoDispatch: options.autoDispatch } : {}),
    logger: {
      warn(message: string, details?: unknown) {
        console.warn(message, details);
      }
    }
  });
  const policy = options.policy ?? permissivePolicyDecisionPoint;
  const controlPlane = new DefaultControlPlaneService({
    orchestrator,
    runs: domainRepos.runs,
    runSteps: domainRepos.runSteps,
    events: eventBus,
    policy,
    artifacts: domainRepos.artifacts,
    feedback: domainRepos.feedback,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    workspaceFilesystem: nodeFilesystem,
    feedbackLifecycle: feedbackLifecycleDependencies
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
  readonly autoDispatch?: AutoDispatchOptions;
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
