import { createPrActivityReader } from '@autocatalyst/core';
import { DrizzleAgentConversationRepository, DrizzleRepairRepository } from '@autocatalyst/persistence';
import { createPublicationGit, materializePublicationReviewSnapshot } from './publication-git.js';
import {
  admitsReviewedLiveConversation, createFreshConversationResolver, createReviewedAttemptPort, type PrepareFreshConversation
} from './reviewed-conversation.js';
import { reviewedLiveRunKey, ReviewedLiveConversations } from './reviewed-live-conversations.js';
import { createNativeHistoryLaunch, readNativeHistoryHost } from './native-history-launch.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';

import { sessionRoleSchema, TESTING_GUIDE_RESULT_FILE, TESTING_GUIDE_SCHEMA_ID } from '@autocatalyst/api-contract';
import type { ConfigurationRecord, Conversation, ExecutionContext, NonModelPrincipal, Principal, Project, ProviderProfileSettings, Run, Topic } from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  buildImplementationBuildContext,
  loadLatestFinalTestingPass,
  testingNotesForPass,
  buildPullRequestFinalizePrompt,
  publicationReviewSnapshotPrompt,
  redactReviewedEvidence,
  renderReviewedHandoff,
  renderCiDiagnostics,
  fullGitSha,
  type HandoffEvidence,
  type ReviewedAttemptPort,
  recordExecutionSession,
  type PublicationReviewSnapshot,
  buildSpecAuthorContext,
  buildReviewedSpecAuthorContext,
  isCumulativeImplementationSummary,
  type CumulativeImplementationSummary,
  composeAgentProviderAdapterRegistry,
  composeDirectProviderAdapterRegistry,
  composeConfiguredProviders,
  createCodeHostRegistry,
  createLayeredConvergenceEngine,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  createModelRoutingResolver,
  DefaultControlPlaneService,
  DefaultIssueReferenceIntakeResolver,
  DefaultOrchestrator,
  defaultRunWorkflowResolver,
  type RunWorkflowResolver,
  createExtensionRegistryCatalog,
  defaultExtensionRegistryCatalog,
  emptyProviderAdapterMap,
  ExecutionContextResolutionError,
  getStepConvergencePolicy,
  InMemoryRetainedRunEventStore,
  ModelRoutingConfigurationError,
  permissivePolicyDecisionPoint,
  reconcileStartupWorkspaces,
  registerControlPlaneRoutes,
  RunDispatchQueue,
  RunRecoveryWorkspaceError,
  type RunRecoveryDependencies,
  StaticIssueTrackerRegistry,
  type AutoDispatchOptions,
  type ResolveCodeHostCredential,
  type ConvergenceEngine,
  type ControlPlaneService,
  type DomainRepositories,
  type ExecutionModeResolution,
  type ExtensionRegistryCatalog,
  type ExtensionRegistryEntry,
  type FeedbackLifecycleDependencies,
  type HealthDependencyChecker,
  type ModelRoutingDistinctResolution,
  type ModelRoutingResolver,
  type ModelRoutingResolution,
  type PolicyDecisionPoint,
  type ProviderAdapterFactory,
  type ProviderAdapterMap,
  type ProviderCompositionResult,
  type PullRequestOpenWiringDependencies,
  type RetainedRunEventStoreOptions,
  type RunUnitOfWork,
  type RunWorkInput,
  type SpecAuthoringServiceDependencies,
  type SpecApprovalFinalizerDependencies,
  type SpecFreezeDependencies,
  type WorkspaceContextResolver,
  type WorkspaceFileSystemPort,
  type WorkspaceGitPort,
  type WorkspaceResolverInput,
  type RunRoleWorkInput
} from '@autocatalyst/core';
import { GitHubIssueTracker } from '@autocatalyst/github-issue-tracker-adapter';
import { createGitHubCodeHostAdapter, type ExecuteGhFunction, type SafeGitExecutor } from '@autocatalyst/github-code-host-adapter';
import { createCodeHostCredentialResolver } from './code-host-credential-resolver.js';
import { createReviewedExecutionDispatcher } from './reviewed-execution-dispatcher.js';
import { createRunWorkspaceGitPort } from './run-workspace-git-port.js';
import { createStaticClientNotFoundHandler, registerStaticClientRoutes } from './static-client.js';
import { loadTestingGuidePrompt } from './testing-guide-context-loader.js';
import { loadSpecAuthorPromptInput, SpecAuthoringContextLoadError } from './spec-authoring-context-loader.js';
import {
  createAgentConnection,
  createAgentRunnerFactory,
  createDirectCallFactory,
  cancellationTerminal,
  createExecutionEntryPoint,
  createExecutionMaterializer,
  createSpecAuthorResultContract,
  createReviewedSpecAuthorResultContract,
  createSpecReviewerResultContract,
  createStepResultContractRegistry,
  createTestingGuideResultContract,
  WorkspaceProvisioningError,
  registerPullRequestFinalizeResultContract,
  registerReviewerResultContract,
  registerImplementerDispositionsResultContract,
  registerSpecAuthorResultContract,
  type StepResultContractRegistry,
  REVIEWER_RESULT_SCHEMA_ID,
  IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
  SPEC_AUTHOR_SCHEMA_ID,
  PR_FINALIZE_SCHEMA_ID,
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
  type ProvisionWorkspaceRequest,
  type ProviderCredentialResolver,
  type ResolvedAgentCredentialReference,
  type ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import {
  claudeAgentAdapterId,
  claudeSubscriptionAdapterId,
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
  codexAgentAdapterId,
  codexBusinessAdapterId,
  codexProviderKind,
  createCodexAgentAdapter
} from '@autocatalyst/codex-agent-adapter';
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

import type { ControlPlaneAppConfig, PullRequestReconciliationTickerConfig } from './config.js';
import { createPullRequestReconciliationTicker } from './pr-reconciliation-ticker.js';
import {
  createScriptedClaudeAdapterFactory,
  createScriptedCodeHostExecuteGh,
  createScriptedIssueTrackerExecuteGh,
  ensureFakeProviderConfig,
  ensureFakeState,
  FAKE_TENANT,
  scriptedClaudeAdapterKey,
  type FakeStatePaths
} from './fake/index.js';

export interface RealRunnerDispatchOptions {
  readonly enabled: boolean;
  readonly defaultProviderProfileId?: string;
}

export interface WorkspaceRootOptions {
  readonly reposRoot: string;
  readonly workspacesRoot: string;
}

export interface ControlPlaneServerOptions {
  readonly workflowResolver?: RunWorkflowResolver;
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  /** Optional server-owned identity resolver; defaults to the development principal. */
  readonly resolvePrincipal?: () => Principal | Promise<Principal>;
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
  /**
   * Injectable GitHub issue tracker options for integration tests.
   * When provided, `executablePath` overrides the default `gh` binary path.
   * Do not pass token values here; credentials are always resolved through `SecretResolver`.
   */
  readonly githubIssueTracker?: {
    readonly executablePath?: string;
    readonly timeoutMs?: number;
    /**
     * Fully replaces the gh subprocess for issue-tracker reads. When set,
     * `executablePath` and `timeoutMs` are ignored. Used by fake mode and tests.
     */
    readonly executeGh?: ExecuteGhFunction;
  };
  /**
   * Injectable GitHub code-host options for integration tests.
   * When provided, `executablePath` overrides the default `gh` binary path used for
   * pull-request create/read/find/merge. Do not pass token values here; credentials are
   * always resolved through the secret store.
   * `executeGh` fully replaces the gh subprocess; when set, `executablePath` and `timeoutMs`
   * are ignored.
   */
  readonly codeHost?: {
    readonly executablePath?: string;
    readonly timeoutMs?: number;
    readonly executeGh?: ExecuteGhFunction;
  };
  /**
   * Injectable credential resolver for integration tests. When provided, replaces the
   * default secret-store lookup so tests can supply a credential without a live secret store.
   */
  readonly resolveCredential?: ResolveCodeHostCredential;
  /**
   * Optional background ticker that calls reconcilePullRequests on a fixed interval.
   * When provided and `enabled` is true, the ticker is started after the server is
   * composed and stopped automatically on `onClose`.
   */
  readonly pullRequestCiRepairLimit?: number;
  readonly pullRequestReconciliationTicker?: PullRequestReconciliationTickerConfig;
  /**
   * Absolute path to a validated built-client directory. When set, the server
   * serves `index.html`, hashed assets, and an SPA fallback from its own origin
   * via the in-repo static handler; when unset, no static route is registered and
   * the server keeps its API-only behavior. The path must already be validated
   * (existing directory containing `index.html`); `config.ts` does this at load.
   */
  readonly clientDirectory?: string;
  /**
   * When present, the server runs in deterministic fake mode: it provisions local
   * fixture state under `stateDir`, registers only the scripted Claude adapter,
   * installs scripted issue-tracker and code-host executors, and creates a fake
   * secret and provider profile so AI steps route to the scripted adapter.
   */
  readonly fakeMode?: {
    readonly enabled: true;
    readonly stateDir: string;
  };
  /**
   * Optional Fastify logger configuration. When not provided, defaults to `false`
   * (no logging), preserving the existing behavior. Tests can inject a custom
   * logger to capture log entries for assertions.
   */
  readonly logger?: FastifyServerOptions['logger'];
  /**
   * Optional pre-constructed Fastify-compatible logger instance. When provided,
   * replaces pino and allows tests to capture log entries directly. Mutually
   * exclusive with `logger`.
   */
  readonly loggerInstance?: FastifyBaseLogger;
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
    // an environment variable. Adapters owning an external account explicitly opt out
    // of API-secret requirements and validate that account before starting paid work.
    const credentialReference: ResolvedAgentCredentialReference = {
      required: adapter.credentialRequirement !== 'external',
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
      const routeInput = {
        tenant,
        runId: factoryInput.runId,
        step: factoryInput.step,
        role: roleParse.data
      };
      let resolution: ModelRoutingResolution;
      try {
        resolution = await options.resolver.resolveAgentRoute(routeInput);
      } catch (error) {
        // The execution factory resolves each session after convergence has resolved
        // the pair. Revalidate the complete required group rather than bypassing
        // the single-role guard or dropping the distinct-model requirement.
        if (!(error instanceof ModelRoutingConfigurationError) ||
            error.code !== 'role_distinct_unsatisfied' ||
            !error.safeDetails?.roles?.includes(roleParse.data)) {
          throw error;
        }
        const group = await options.resolver.resolveDistinctAgentRoutes({
          tenant,
          runId: factoryInput.runId,
          step: factoryInput.step,
          roles: error.safeDetails.roles
        });
        resolution = group.resolutionsByRole[roleParse.data]!;
      }
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

/**
 * Wraps a ModelRoutingResolver so convergence route resolution uses the configured
 * default provider profile when no active routing table exists for the tenant.
 * Only catches ModelRoutingConfigurationError with code === 'routing_table_missing';
 * all other routing errors propagate unchanged.
 *
 * For resolveDistinctAgentRoutes, a missing routing table is converted into
 * role_distinct_unsatisfied so the convergence engine's existing downgrade path
 * records routingInfo.distinct: false instead of failing outright.
 */
export function createDefaultProviderProfileFallbackRoutingResolver(input: {
  readonly resolver: ModelRoutingResolver;
  readonly fallback: (factoryInput: AgentRunnerFactoryInput) => Promise<AgentProfileResolution>;
}): ModelRoutingResolver {
  const fallbackResolution = async (args: {
    readonly tenant: string;
    readonly runId?: string;
    readonly step: string;
    readonly role: string;
  }): Promise<ModelRoutingResolution> => {
    const resolved = await input.fallback({
      runId: args.runId ?? 'default_provider_profile_fallback',
      tenant: args.tenant,
      step: args.step,
      role: args.role
    });

    return {
      profile: resolved.profile,
      credentialReference: resolved.credentialReference,
      routeId: `default_provider_profile_fallback:${args.step}:${args.role}`,
      profileId: resolved.profile.configurationRecordId ?? 'default_provider_profile_fallback',
      routingTableId: 'default_provider_profile_fallback'
    };
  };

  const isMissingRoutingTable = (err: unknown): err is ModelRoutingConfigurationError =>
    err instanceof ModelRoutingConfigurationError && err.code === 'routing_table_missing';

  return {
    async resolveAgentRoute(routeInput) {
      try {
        return await input.resolver.resolveAgentRoute(routeInput);
      } catch (err) {
        if (!isMissingRoutingTable(err)) throw err;
        return fallbackResolution({
          tenant: routeInput.tenant,
          ...(routeInput.runId !== undefined ? { runId: routeInput.runId } : {}),
          step: routeInput.step,
          role: routeInput.role
        });
      }
    },

    async resolveDirectRoute(routeInput) {
      return input.resolver.resolveDirectRoute(routeInput);
    },

    async resolveDistinctAgentRoutes(routeInput): Promise<ModelRoutingDistinctResolution> {
      try {
        return await input.resolver.resolveDistinctAgentRoutes(routeInput);
      } catch (err) {
        if (!isMissingRoutingTable(err)) throw err;
        throw new ModelRoutingConfigurationError(
          'role_distinct_unsatisfied',
          'Default provider profile fallback cannot satisfy distinct reviewed routing without an active routing table.',
          {
            tenant: routeInput.tenant,
            ...(routeInput.runId !== undefined ? { runId: routeInput.runId } : {}),
            step: routeInput.step,
            roles: routeInput.roles,
            distinctBy: routeInput.distinctBy ?? 'profile',
            routingTableId: 'default_provider_profile_fallback'
          }
        );
      }
    }
  };
}

export interface ControlPlaneStepResultContractRegistryOptions {
  readonly specAuthorIdentity?: string;
}

export function createControlPlaneStepResultContractRegistry(
  options: ControlPlaneStepResultContractRegistryOptions = {}
): StepResultContractRegistry {
  const registry = registerPullRequestFinalizeResultContract(
    registerImplementerDispositionsResultContract(
      registerReviewerResultContract(
        registerSpecAuthorResultContract(
          createStepResultContractRegistry(),
          options.specAuthorIdentity !== undefined
            ? { trustedSpeccedBy: options.specAuthorIdentity }
            : {}
        )
      )
    ),
    { resultFile: 'pr-finalize-result.json' }
  );
  registry.register(createTestingGuideResultContract());
  registry.register(createSpecReviewerResultContract());
  registry.register(createReviewedSpecAuthorResultContract(
    options.specAuthorIdentity !== undefined ? { trustedSpeccedBy: options.specAuthorIdentity } : {}
  ));
  return registry;
}

// Default registry used by tests and as fallback. Uses 'autocatalyst' as specced_by.
const defaultStepResultContractRegistry = createControlPlaneStepResultContractRegistry();

export interface ScratchResultValidationOptions {
  readonly clock?: () => string;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readSpecAuthorTrackedIssueNumber(context: ExecutionContext): number | undefined {
  const runInput = context.task.inputs['run'];
  if (typeof runInput !== 'object' || runInput === null || Array.isArray(runInput)) return undefined;
  return readPositiveInteger((runInput as Record<string, unknown>)['issueNumber']);
}

function readSpecAuthorTrustedSpeccedBy(context: ExecutionContext): string | undefined {
  const outputContract = context.task.inputs['outputContract'];
  if (typeof outputContract !== 'object' || outputContract === null || Array.isArray(outputContract)) return undefined;
  const frontmatter = (outputContract as Record<string, unknown>)['frontmatter'];
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) return undefined;
  const trustedSpeccedBy = (frontmatter as Record<string, unknown>)['trustedSpeccedBy'];
  return typeof trustedSpeccedBy === 'string' && trustedSpeccedBy.length > 0 ? trustedSpeccedBy : undefined;
}

function readImplementationBuildResultFile(context: ExecutionContext): string | undefined {
  const outputContract = context.task.inputs['outputContract'];
  if (typeof outputContract !== 'object' || outputContract === null || Array.isArray(outputContract)) return undefined;
  const resultFile = (outputContract as Record<string, unknown>)['resultFile'];
  return typeof resultFile === 'string' && resultFile.length > 0 ? resultFile : undefined;
}

export function resolveScratchResultValidationConfig(
  context: ExecutionContext,
  registry: StepResultContractRegistry = defaultStepResultContractRegistry,
  options: ScratchResultValidationOptions = {}
) {
  const step = context.run.currentStep;
  const workKind = context.run.workKind;
  const role = context.task.inputs['role'];

  if (step === 'spec.author' && (workKind === 'feature' || workKind === 'enhancement')) {
    const trustedSpeccedBy = readSpecAuthorTrustedSpeccedBy(context);
    const trackedIssueNumber = readSpecAuthorTrackedIssueNumber(context);
    const reviewed = context.task.inputs['specReview'];
    if (reviewed && typeof reviewed === 'object' && !Array.isArray(reviewed) && (role === 'reviewer' || role === 'implementer')) {
      const task = reviewed as { canonicalPath?: string; requiredFeedbackIds?: string[] };
      const contract = role === 'reviewer' ? createSpecReviewerResultContract() : createReviewedSpecAuthorResultContract({
        kind: workKind === 'feature' ? 'feature_spec' : 'enhancement_spec',
        ...(task.canonicalPath !== undefined ? { canonicalPath: task.canonicalPath } : {}),
        requiredFeedbackIds: task.requiredFeedbackIds ?? [],
        ...(trustedSpeccedBy !== undefined ? { trustedSpeccedBy } : {}),
        ...(trackedIssueNumber !== undefined ? { trackedIssueNumber } : {}),
        ...(options.clock !== undefined ? { clock: options.clock } : {})
      });
      return { mode: 'scratch_file' as const, contract, step, schemaId: contract.schemaId,
        resultFile: readImplementationBuildResultFile(context) ?? '' };
    }
    const contract = createSpecAuthorResultContract({
      ...(trustedSpeccedBy !== undefined ? { trustedSpeccedBy } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(trackedIssueNumber !== undefined ? { trackedIssueNumber } : {})
    });
    return {
      mode: 'scratch_file' as const,
      contract,
      step: 'spec.author',
      schemaId: SPEC_AUTHOR_SCHEMA_ID,
      resultFile: 'step-result.json'
    };
  }

  if (step === 'implementation.testing_guide') {
    return {
      mode: 'scratch_file' as const, contractRegistry: registry, step,
      schemaId: TESTING_GUIDE_SCHEMA_ID, resultFile: TESTING_GUIDE_RESULT_FILE
    };
  }

  if (step === 'pr.finalize') {
    return {
      mode: 'scratch_file' as const,
      contractRegistry: registry,
      step: 'pr.finalize',
      schemaId: PR_FINALIZE_SCHEMA_ID,
      resultFile: 'pr-finalize-result.json'
    };
  }

  if (step === 'implementation.build' && (role === 'reviewer' || role === 'implementer')) {
    // Each role/round validates its own immutable result file against its own
    // contract, so the implementer's dispositions and the reviewer's verdict are
    // never crossed. The concrete file name is set by the context builder's
    // output contract; fall back to the shared file only if it is absent.
    const resultFile = readImplementationBuildResultFile(context) ?? 'step-result.json';
    return {
      mode: 'scratch_file' as const,
      contractRegistry: registry,
      step: 'implementation.build',
      schemaId: role === 'reviewer' ? REVIEWER_RESULT_SCHEMA_ID : IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
      resultFile
    };
  }

  return {
    mode: 'scratch_file' as const,
    schema: z.unknown(),
    schemaId: 'any',
    resultFile: 'step-result.json'
  };
}

function attemptResultFile(file: string, attemptId: string): string {
  return file.replace(/\.json$/u, `-${attemptId}.json`);
}

export function createDelegatingExecutionEntryPoint(input: {
  readonly factory: AgentRunnerFactory;
  readonly materialize: (context: ExecutionContext) => Promise<MaterializedExecutionEnvironment>;
  readonly resolveRole?: (step: string) => string;
  readonly onWorkspaceRootResolved?: (runId: string, repoRoot: string, branchName: string, provisionedBaseRef?: string) => void | Promise<void>;
  readonly registry?: StepResultContractRegistry;
  readonly resolvePinnedRoute?: (context: ExecutionContext) => ModelRoutingResolution | undefined;
  readonly resolvePublicationReview?: (context: ExecutionContext) => PublicationReviewSnapshot | undefined;
  readonly prepareDefaultConversation?: NonNullable<ExecutionEntryPointInput['prepareConversation']>;
}): ExecutionEntryPoint {
  const { resolveRole } = input;
  /**
   * Wraps the materializer to ensure a scratch root is always available.
   * For workspace shapes that do not provision a scratch root (e.g. 'none' for
   * question runs), a temporary directory is created so the Claude adapter can
   * write step-result.json and scratch_file validation can read it back.
   * Also registers the repo root and branch name for two_roots workspaces so spec
   * authoring, approval finalization, and pr.open can resolve the workspace path
   * and branch without importing execution internals.
   */
  async function materializeWithScratch(
    context: ExecutionContext
  ): Promise<MaterializedExecutionEnvironment> {
    const env = await input.materialize(context);
    if (env.workspace.shape === 'two_roots') {
      await input.onWorkspaceRootResolved?.(context.run.id, env.workspace.repoRoot, env.workspace.branchName, env.workspace.provisionedBaseRef);
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
      if (entryInput.signal?.aborted) {
        yield cancellationTerminal(entryInput);
        return;
      }
      // Prefer the role injected into task inputs by the convergence dispatcher;
      // fall back to the resolveRole callback for non-convergence steps.
      const taskInputRole = entryInput.context.task?.inputs?.['role'];
      const resolvedRole = typeof taskInputRole === 'string'
        ? taskInputRole
        : resolveRole !== undefined ? resolveRole(entryInput.context.run.currentStep) : undefined;
      const pinnedRoute = input.resolvePinnedRoute?.(entryInput.context);
      const prepare = entryInput.prepareConversation ?? (entryInput.nativeConversation ? undefined : input.prepareDefaultConversation);
      let resolvedProfile: AgentProfileResolution['profile'] | undefined;
      const runnerFactoryInput: AgentRunnerFactoryInput = {
        runId: entryInput.context.run.id,
        step: entryInput.context.run.currentStep,
        tenant: entryInput.context.run.tenant,
        ...(pinnedRoute ? { pinnedProfile: pinnedRoute } : {}),
        ...(prepare ? { onResolvedProfile: profile => { resolvedProfile = profile; } } : {}),
        ...(resolvedRole !== undefined ? { role: resolvedRole } : {})
      };
      let runner;
      try {
        runner = await input.factory.createRunner(runnerFactoryInput);
      } catch (error) {
        if (!entryInput.signal?.aborted) throw error;
        yield cancellationTerminal(entryInput);
        return;
      }
      const perRunEntryPoint = createExecutionEntryPoint({
        runner,
        materialize: async context => {
          const env = await materializeWithScratch(context);
          if (!entryInput.attemptId || env.workspace.shape !== 'two_roots') return env;
          const ws = env.workspace;
          const review = input.resolvePublicationReview?.(context);
          if (review) {
            const snapshot = await materializePublicationReviewSnapshot({ repoRoot: ws.repoRoot, scratchRoot: ws.scratchRoot, review });
            return {
              ...env,
              workspace: { ...ws, repoRoot: snapshot.sourceRoot, workspaceRoots: [snapshot.reviewRoot] },
              toolPolicy: { ...env.toolPolicy, workspaceRoots: [snapshot.reviewRoot] },
              capabilities: { ...env.capabilities, paths: { repoRoot: snapshot.sourceRoot, scratchRoot: snapshot.reviewRoot } },
              context: { ...context, task: { ...context.task, prompt: [
                context.task.prompt, 'Inspect the candidate source under your current repository root.',
                'Read ../diff.txt for the pinned target-to-candidate diff and ../special-entries.txt for symlinks and submodules, which are not followed.',
                'This review copy has no Git metadata; do not read the original worktree or earlier review outputs.'
              ].join('\n') } }
            };
          }
          const config = resolveScratchResultValidationConfig(context, input.registry);
          const spec = context.task.inputs['approvedSpec'] as { relativePath?: string } | undefined;
          const git = async (...args: string[]) => (await execFileAsync('git', args, {
            cwd: ws.repoRoot, env: { PATH: process.env['PATH'], GIT_TERMINAL_PROMPT: '0' }, timeout: 5000
          })).stdout.trim();
          const localCommit = fullGitSha.safeParse(await git('rev-parse', '--verify', 'HEAD^{commit}').catch(() => ''));
          const prior = fullGitSha.safeParse(context.task.inputs['lastReviewedRevision']);
          const comparable = prior.success && localCommit.success && await git('cat-file', '-e', `${prior.data}^{commit}`).then(() => true).catch(() => false);
          const uniqueFile = config.resultFile && context.run.currentStep !== 'spec.author'
            ? attemptResultFile(config.resultFile, entryInput.attemptId) : undefined;
          const specRevision = localCommit.success && spec?.relativePath
            ? fullGitSha.safeParse(await git('rev-parse', '--verify', `${localCommit.data}:${spec.relativePath}`).catch(() => '')) : undefined;
          return { ...env, context: { ...context, task: {
            ...context.task,
            inputs: uniqueFile ? {
              ...context.task.inputs, resultFile: uniqueFile,
              ...(typeof context.task.inputs['outputContract'] === 'object' && context.task.inputs['outputContract'] !== null
                ? { outputContract: { ...context.task.inputs['outputContract'], resultFile: uniqueFile } } : {})
            } : context.task.inputs,
            prompt: [uniqueFile && config.resultFile ? context.task.prompt.replaceAll(config.resultFile, uniqueFile) : context.task.prompt,
              'Current turn (host verified):',
              `- Workspace: repository root and separate scratch root; source ref refs/heads/${ws.branchName}.`,
              `- Step: ${context.run.currentStep}; role: ${resolvedRole ?? 'implementer'}.`,
              `- Current local commit: ${localCommit.success ? localCommit.data : 'unavailable'}.`,
              ...(spec ? [`- Approved or frozen spec revision: ${specRevision?.success ? specRevision.data : 'unavailable'}.`] : []),
              ...(resolvedRole === 'reviewer' && context.run.currentStep === 'implementation.build' ? [
                comparable ? `- Compare affected changes from ${prior.data} to ${localCommit.data} and recheck the earlier findings.`
                  : '- No verified earlier revision is available for comparison. Review the full current scope.'
              ] : []),
              ...(uniqueFile ? [`- If writing a scratch result, use this turn's filename instead of any earlier name: ${uniqueFile}.`] : [])
            ].join('\n')
          } } };
        },
        resultValidation: (entryInput) => {
          const config = resolveScratchResultValidationConfig(entryInput.context, input.registry);
          if (entryInput.attemptId && config.resultFile && entryInput.context.run.currentStep !== 'spec.author') {
            return { ...config, resultFile: attemptResultFile(config.resultFile, entryInput.attemptId) };
          }
          if (!entryInput.transportRetry || !entryInput.context.task.inputs['specReview'] || !config.resultFile) return config;
          return { ...config, resultFile: config.resultFile.replace(/\.json$/u, `-transport-${entryInput.transportRetry}.json`) };
        }
      });
      yield* perRunEntryPoint.execute(prepare ? {
        ...entryInput, prepareConversation: environment => prepare(environment, resolvedProfile)
      } : entryInput);
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
    async readHeadFile({ workspaceRepoRoot, relativePath }) {
      assertWithinWorkspaceRootLexical(workspaceRepoRoot, relativePath);
      const { stdout: listing } = await execFileAsync('git', ['ls-tree', 'HEAD', '--', relativePath], { cwd: workspaceRepoRoot });
      if (listing.length === 0) return null;
      const { stdout } = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: workspaceRepoRoot });
      return stdout;
    },
    async commitFiles(input) {
      const cwd = input.workspaceRepoRoot;
      await execFileAsync('git', ['-C', cwd, 'add', '--', ...input.relativePaths]);
      if (input.expectedContents !== undefined) {
        const { stdout: staged } = await execFileAsync('git', ['show', `:${input.relativePaths[0]!}`], { cwd });
        if (staged !== input.expectedContents) throw new Error('Git staged different spec bytes than were reviewed.');
      }
      const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only', 'HEAD', '--', ...input.relativePaths], { cwd });
      if (!stdout) return {};
      await execFileAsync('git', [
        '-C', cwd,
        '-c', 'user.name=Autocatalyst',
        '-c', 'user.email=autocatalyst@local',
        'commit', '-m', input.message, '--only', '--', ...input.relativePaths
      ]);
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

  // Fake mode: provision deterministic local state before opening the database,
  // which lives under the state directory. Scripted gh executors are built here
  // so they can be injected into the issue-tracker and code-host seams below.
  let fakeStatePaths: FakeStatePaths | undefined;
  let scriptedIssueTrackerExecuteGh: ExecuteGhFunction | undefined;
  let scriptedCodeHostExecuteGh: ExecuteGhFunction | undefined;
  if (options.fakeMode !== undefined) {
    fakeStatePaths = await ensureFakeState(options.fakeMode.stateDir);
    scriptedIssueTrackerExecuteGh = createScriptedIssueTrackerExecuteGh(fakeStatePaths);
    scriptedCodeHostExecuteGh = createScriptedCodeHostExecuteGh(fakeStatePaths);
  }

  const database = createSqliteDatabase({ path: options.databasePath });
  await migrateSqliteDatabase(database);

  const secretStore = new SqliteSecretStore(database);
  await secretStore.unlock(options.masterSecret);

  const configurationRecords = new DrizzleConfigurationRecordRepository(database);

  // Fake dispatch is enabled whenever fake mode is on and no explicit unit of work
  // was injected. It owns dispatch and provider adapter selection.
  const fakeDispatchEnabled = options.fakeMode !== undefined && options.unitOfWork === undefined;
  const domainReposFakeRef: { current?: DomainRepositories } = {};
  let fakeProfileId: string | undefined;
  if (fakeDispatchEnabled) {
    fakeProfileId = await ensureFakeProviderConfig({ secretStore, configurationRecords, tenant: FAKE_TENANT });
  }

  // If real dispatch is enabled and no explicit unitOfWork was provided, register
  // the Claude adapter factory. Callers can still override by providing their own
  // factory with the same key in `providerAdapters`.
  const realDispatchEnabled =
    options.realRunnerDispatch?.enabled === true && options.unitOfWork === undefined;

  // Both real and fake dispatch build the execution unit of work; they differ only
  // in which provider adapters are registered and how profiles resolve.
  const buildDispatch = realDispatchEnabled || fakeDispatchEnabled;

  const baseAdapters = options.providerAdapters ?? emptyProviderAdapterMap;
  const reviewedLiveConversations = new ReviewedLiveConversations();
  const nativeHistory = createNativeHistoryLaunch(readNativeHistoryHost(process.env));
  const provisionWorkspace = async (request: ProvisionWorkspaceRequest) => {
    const key = reviewedLiveRunKey(request.project.tenant, request.runId);
    if (request.existingWorkspaceBehavior === 'replace') reviewedLiveConversations.retireRun(key, 'workspace_changed');
    try {
      const result = await nativeHistory.lifecycle.provisionWorkspace(request);
      if (result.shape !== 'two_roots' || result.outcome === 'materialized') {
        reviewedLiveConversations.retireRun(key, 'workspace_changed');
      }
      return result;
    } catch (error) {
      reviewedLiveConversations.retireRun(key, 'workspace_changed');
      throw error;
    }
  };
  let mergedAdapters: ProviderAdapterMap = baseAdapters;
  // Extension-registry entries mirroring the adapters that real dispatch registers.
  // Startup composition validates persisted provider profiles against the registry
  // catalog; without matching entries, every valid profile (Codex included) would
  // emit a spurious `adapter_not_registered` warning even though its factory is
  // present. We only populate these when real dispatch wires the factories, so the
  // registry claim and the registered factory stay in lockstep.
  const realDispatchRegistryEntries: ExtensionRegistryEntry[] = [];
  if (fakeDispatchEnabled && fakeStatePaths !== undefined) {
    // Fake mode registers ONLY the scripted Claude adapter under the real Claude
    // adapter key. It deliberately ignores any caller-provided `providerAdapters`
    // (`baseAdapters`) rather than carrying them into the fake registry: fake mode
    // owns provider adapter selection, so no real Claude/OpenAI/Codex/Anthropic
    // factory may be composed here. Seeding from `baseAdapters` would leave real
    // factories reachable by any persisted/API-created profile that references
    // their adapter key, which would allow real-provider routing after restart.
    const merged = new Map<string, ProviderAdapterFactory>();
    merged.set(
      scriptedClaudeAdapterKey,
      createScriptedClaudeAdapterFactory({
        paths: fakeStatePaths,
        isStillRunning: async (runId, step) => {
          const run = await domainReposFakeRef.current?.runs.findById(runId);
          // The session signal handles operator cancel. Poll for other stale steps.
          return run != null && (run.currentStep === 'canceled' || (!run.terminal && run.currentStep === step));
        },
        resolveIssueNumber: async (runId) => {
          const run = await domainReposFakeRef.current?.runs.findById(runId);
          return run?.trackedIssue?.number;
        }
      })
    );
    realDispatchRegistryEntries.push({
      providerKind: claudeProviderKind,
      adapterId: claudeAgentAdapterId,
      displayName: 'Claude Agent SDK (fake)',
      capabilities: ['agent_session']
    });
    mergedAdapters = merged;
  } else if (realDispatchEnabled) {
    const agentAdapterLogger = {
      info(event: string, fields: unknown) { app.log.info({ ...(fields as Record<string, unknown>), event }, 'Agent adapter diagnostic.'); },
      warn(event: string, fields: unknown) { app.log.warn({ ...(fields as Record<string, unknown>), event }, 'Agent adapter diagnostic.'); },
      error(event: string, fields: unknown) { app.log.error({ ...(fields as Record<string, unknown>), event }, 'Agent adapter diagnostic.'); }
    };
    const merged = new Map<string, ProviderAdapterFactory>(baseAdapters);
    const claudeKey = buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId);
    if (!merged.has(claudeKey)) {
      merged.set(claudeKey, () => createClaudeAgentAdapter({ logger: agentAdapterLogger }));
    }
    realDispatchRegistryEntries.push({
      providerKind: claudeProviderKind,
      adapterId: claudeAgentAdapterId,
      displayName: 'Claude Agent SDK',
      capabilities: ['agent_session']
    });
    // Subscription adapters are explicit identities; API profiles remain opt-in.
    for (const [providerKind, adapterId, makeAdapter] of [
      [claudeProviderKind, claudeSubscriptionAdapterId, () => createClaudeAgentAdapter({ authentication: 'subscription', logger: agentAdapterLogger })],
      [codexProviderKind, codexBusinessAdapterId, () => createCodexAgentAdapter({ authentication: 'business_sign_in', logger: agentAdapterLogger })]
    ] as const) {
      const key = buildProviderAdapterKey(providerKind, adapterId);
      if (!merged.has(key)) merged.set(key, ({ configurationRecord }) => {
        const settings = configurationRecord.settings as ProviderProfileSettings;
        if (settings.credentialSecretHandle !== undefined || Object.entries(settings.endpoint ?? {}).some(([name, value]) =>
          !['requestTimeoutMs', 'maxRetries'].includes(name) && !(name === 'proxyMode' && value === 'disabled')
        )) throw new ProviderConfigurationError('invalid_endpoint', 'Subscription profiles cannot reference API credentials or gateway alterations.');
        return makeAdapter();
      });
      realDispatchRegistryEntries.push({ providerKind, adapterId, displayName: adapterId, capabilities: ['agent_session'] });
    }
    const anthropicDirectKey = buildProviderAdapterKey(anthropicProviderKind, anthropicDirectAdapterId);
    if (!merged.has(anthropicDirectKey)) {
      merged.set(anthropicDirectKey, () => createAnthropicDirectAdapter({ logger: agentAdapterLogger }));
    }
    realDispatchRegistryEntries.push({
      providerKind: anthropicProviderKind,
      adapterId: anthropicDirectAdapterId,
      displayName: 'Anthropic (direct)',
      capabilities: ['direct_call']
    });
    const openaiDirectKey = buildProviderAdapterKey(openaiProviderKind, openaiDirectAdapterId);
    if (!merged.has(openaiDirectKey)) {
      merged.set(openaiDirectKey, () => createOpenAIDirectAdapter({ logger: agentAdapterLogger }));
    }
    realDispatchRegistryEntries.push({
      providerKind: openaiProviderKind,
      adapterId: openaiDirectAdapterId,
      displayName: 'OpenAI (direct)',
      capabilities: ['direct_call']
    });
    const openaiAgentKey = buildProviderAdapterKey(openaiProviderKind, openaiAgentAdapterId);
    if (!merged.has(openaiAgentKey)) {
      merged.set(openaiAgentKey, () => createOpenAIAgentAdapter({ logger: agentAdapterLogger }));
    }
    realDispatchRegistryEntries.push({
      providerKind: openaiProviderKind,
      adapterId: openaiAgentAdapterId,
      displayName: 'OpenAI Agents SDK',
      capabilities: ['agent_session']
    });
    const codexAgentKey = buildProviderAdapterKey(codexProviderKind, codexAgentAdapterId);
    if (!merged.has(codexAgentKey)) {
      merged.set(codexAgentKey, () => createCodexAgentAdapter({ logger: {
        info: (event, fields) => app.log.info({ event, ...(fields as Record<string, unknown>) }, 'Agent adapter diagnostic.'),
        warn: (event, fields) => app.log.warn({ event, ...(fields as Record<string, unknown>) }, 'Agent adapter diagnostic.'),
        error: (event, fields) => app.log.error({ event, ...(fields as Record<string, unknown>) }, 'Agent adapter diagnostic.')
      } }));
    }
    realDispatchRegistryEntries.push({
      providerKind: codexProviderKind,
      adapterId: codexAgentAdapterId,
      displayName: 'Codex (enterprise sign-in)',
      capabilities: ['agent_session']
    });
    mergedAdapters = merged;
  }

  // Prefer an explicitly injected registry (tests/custom callers). Otherwise, when
  // real dispatch is enabled, validate against the catalog mirroring the registered
  // factories so Codex and its siblings resolve cleanly in production. Fall back to
  // the empty default catalog only when no factories were wired.
  const startupExtensionRegistry: ExtensionRegistryCatalog =
    options.extensionRegistry ??
    (buildDispatch
      ? createExtensionRegistryCatalog(realDispatchRegistryEntries)
      : defaultExtensionRegistryCatalog);

  const startupCompositionTenant = 'tenant_dev';
  const providerCompositionResult = await composeConfiguredProviders({
    configurationRecords: await configurationRecords.list(startupCompositionTenant),
    registry: startupExtensionRegistry,
    providerAdapters: mergedAdapters
  });
  await options.onProviderComposition?.(providerCompositionResult);

  const app = options.loggerInstance !== undefined
    ? Fastify({ loggerInstance: options.loggerInstance })
    : Fastify({
        logger: options.logger ?? (realDispatchEnabled ? { level: 'info' } : false),
        // Default real-dispatch diagnostics must be visible without logging requests.
        disableRequestLogging: options.logger === undefined
      });

  const domainRepos = createDrizzleDomainRepositories(database);
  const agentConversations = new DrizzleAgentConversationRepository(database);
  const unrecordedLaunches = (() => {
    try { return agentConversations.unrecordedLaunches(); }
    catch {
      app.log.warn({ code: 'interrupted_session_read_failed' }, 'Interrupted reviewed dispatch evidence is unavailable.');
      return [];
    }
  })();
  for (const attempt of unrecordedLaunches) {
    if (!attempt.launch) continue;
    try {
      await recordExecutionSession({ sessions: domainRepos.sessions }, {
        ...attempt.launch, runId: attempt.runId, attemptId: attempt.id, round: attempt.round,
        step: attempt.step, role: attempt.role, phase: attempt.step.split('.')[0] ?? null,
        endedAt: null, outcome: 'failed', usageAvailable: false
      });
    } catch {
      app.log.warn({ code: 'interrupted_session_persistence_failed', runId: attempt.runId, step: attempt.step, role: attempt.role },
        'An interrupted reviewed dispatch could not be recorded.');
    }
  }
  // Expose domain repositories to the scripted adapter factory for issue-number
  // resolution at session time (the factory is constructed before this line).
  domainReposFakeRef.current = domainRepos;
  const conversationIngress = new DrizzleConversationIngressRepository(database);
  const eventBus = new InMemoryRetainedRunEventStore(options.runEventStoreOptions ?? {
    maxEventsPerScope: 256,
    maxExpiredIdsPerScope: 256,
    subscriberBufferSize: 64
  });
  const dispatchQueue = new RunDispatchQueue({
    maxConcurrent: options.runConcurrency ?? DEFAULT_RUN_CONCURRENCY
  });

  // Registry that maps runId → { repoRoot, branchName } for two_roots workspaces.
  // Populated during materialization so spec authoring, approval, and pr.open can
  // resolve the workspace path and branch without importing execution internals.
  const runWorkspaceRootRegistry = new Map<string, { repoRoot: string; branchName: string }>();

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

  // Workspace git port is created whenever workspaceRoots are configured. It is used
  // both by the convergence engine (when realDispatch is enabled) and by specFreezeDependencies.
  let runWorkspaceGit: ReturnType<typeof createRunWorkspaceGitPort> | undefined;
  if (options.workspaceRoots !== undefined) {
    runWorkspaceGit = createRunWorkspaceGitPort({
      workspacesRoot: options.workspaceRoots.workspacesRoot
    });
  }

  // Build the real dispatch unit of work if requested. `options.unitOfWork`
  // always takes precedence.
  let resolvedUnitOfWork: RunUnitOfWork | undefined = options.unitOfWork;
  // Convergence engine is composed only when we build the real dispatch unit of work.
  // It needs the routing resolver, the execution-aware unit of work (for runWithCheckpoint),
  // and a workspace git port — all of which are only available in the real-dispatch branch.
  // An explicitly injected convergenceEngine (e.g. from integration tests) takes priority.
  let convergenceEngine: ConvergenceEngine | undefined = options.convergenceEngine;
  if (convergenceEngine === undefined && resolvedUnitOfWork === undefined && buildDispatch) {
    const profileId = fakeDispatchEnabled ? fakeProfileId : options.realRunnerDispatch?.defaultProviderProfileId;
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

    const convergenceRoutingResolver = explicitProfileFallback !== undefined
      ? createDefaultProviderProfileFallbackRoutingResolver({
          resolver: routingResolver,
          fallback: explicitProfileFallback
        })
      : routingResolver;

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
      provisionWorkspace,
      capabilities: { shellAvailable: false, lspAvailable: false }
    });
    const isBuiltIn = (profile: AgentProfileResolution['profile'] | undefined) =>
      realDispatchEnabled && !fakeDispatchEnabled && profile !== undefined &&
      !baseAdapters.has(buildProviderAdapterKey(profile.providerKind, profile.adapterId));
    const resolveFresh = createFreshConversationResolver();
    const protectedFresh = nativeHistory.protectFresh(resolveFresh);
    const prepareFreshConversation: PrepareFreshConversation = (environment, profile) =>
      protectedFresh(environment, isBuiltIn(profile) ? profile : undefined);
    const protectDefault = nativeHistory.protectFresh(async () => ({ mode: 'fresh_only', verifiedNonPersistence: false }));
    const stepResultContractRegistry = createControlPlaneStepResultContractRegistry({
      ...(options.specAuthorIdentity !== undefined ? { specAuthorIdentity: options.specAuthorIdentity } : {})
    });
    const pinnedReviewedRoutes = new WeakMap<ExecutionContext, ModelRoutingResolution>();
    const reviewedAttempts = new WeakMap<ExecutionContext, ReviewedAttemptPort>();
    const publicationReviews = new WeakMap<ExecutionContext, PublicationReviewSnapshot>();
    const entryPoint = createDelegatingExecutionEntryPoint({
      resolvePinnedRoute: context => pinnedReviewedRoutes.get(context),
      resolvePublicationReview: context => publicationReviews.get(context),
      factory: runnerFactory,
      prepareDefaultConversation: async (environment, profile) => {
        if (!isBuiltIn(profile)) return undefined;
        const fresh = await protectDefault(environment, profile);
        return fresh.protectedHistoryRoots ? fresh : undefined;
      },
      materialize: (context) => materializer.materialize(context),
      resolveRole: (step) => step === 'pr.finalize' ? 'reviewer' : 'implementer',
      onWorkspaceRootResolved: async (runId, repoRoot, branchName, provisionedBaseRef) => {
        runWorkspaceRootRegistry.set(runId, { repoRoot, branchName });
        // Eagerly persist workspace metadata for all two_roots runs (including bug/chore
        // that skip spec.author and would otherwise have no persistent workspace record).
        await domainRepos.runWorkspaceMetadata.upsert({
          runId,
          workspaceHandle: branchName,
          workspaceRepoRoot: repoRoot,
          provisionedBaseRef: provisionedBaseRef ?? null,
          createdAt: new Date().toISOString()
        });
      },
      registry: stepResultContractRegistry
    });
    const safeSessionLogger = {
      warn(fields: Record<string, unknown>, message: string) {
        const { runId, step, role, errorName, errorCode } = fields;
        console.warn({ runId, step, role, errorName, ...(errorCode !== undefined ? { errorCode } : {}) }, message);
      },
      error(fields: Record<string, unknown>, message: string) {
        const { runId, step, role, errorName, errorCode } = fields;
        console.error({ runId, step, role, errorName, ...(errorCode !== undefined ? { errorCode } : {}) }, message);
      }
    };

    const executionUnitOfWork = createExecutionRunUnitOfWork({
      prepareFreshConversation,
      execute: entryPoint,
      sessions: domainRepos.sessions,
      reviewedAttempt: context => reviewedAttempts.get(context),
      logger: safeSessionLogger,
      resolveContext: async (workInput) => {
        const workspace = await resolveWorkspaceInputForRun({
          workInput,
          roots: options.workspaceRoots,
          repositories: domainRepos
        });

        // Load spec-authoring context for spec.author runs
        const roleInput = workInput as RunRoleWorkInput;
        let specAuthorContext: ReturnType<typeof buildSpecAuthorContext> | ReturnType<typeof buildReviewedSpecAuthorContext> | undefined;
        if (
          workInput.run.currentStep === 'spec.author' &&
          (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
        ) {
          try {
            const promptInput = await loadSpecAuthorPromptInput({
              runId: workInput.runId,
              tenantId: workInput.tenant,
              repositories: domainRepos,
              loadRevisionFeedback: roleInput.specReview === undefined
            });
            const authorInput = {
              ...promptInput,
              ...(options.specAuthorIdentity !== undefined ? { specAuthorIdentity: options.specAuthorIdentity } : {})
            };
            specAuthorContext = roleInput.specReview
              ? buildReviewedSpecAuthorContext(authorInput, roleInput.role, roleInput.round, roleInput.specReview)
              : buildSpecAuthorContext(authorInput);
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

        const isReadOnlySession = workInput.toolPolicyMode === 'read_only' ||
          workInput.run.currentStep === 'pr.finalize' || workInput.run.currentStep === 'implementation.testing_guide';
        let testingGuidePrompt: string | undefined;
        if (workInput.run.currentStep === 'implementation.testing_guide') {
          const project = workspace?.project;
          const git = project?.workspaceRootOverride
            ? createRunWorkspaceGitPort({ workspacesRoot: project.workspaceRootOverride })
            : runWorkspaceGit;
          testingGuidePrompt = await loadTestingGuidePrompt({
            work: workInput, repositories: domainRepos, ...(git ? { git } : {}), ...(project ? { project } : {})
          });
        }

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
              if (artifact?.tenant === workInput.tenant && artifact.runId === workInput.runId) {
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

          const finalTestingPass = roleInput.role === 'implementer'
            ? await loadLatestFinalTestingPass({ runId: workInput.runId, tenant: workInput.tenant },
              domainRepos.testingGuides, domainRepos.testResults)
            : null;
          implementationBuildContext = buildImplementationBuildContext({
            run: workInput.run,
            role: roleInput.role as 'implementer' | 'reviewer',
            round: roleInput.round,
            ...(approvedSpec !== undefined ? { approvedSpec } : {}),
            ...(finalTestingPass === null ? {} : { testingNotes: testingNotesForPass(finalTestingPass) }),
            ...(roleInput.reviewContext !== undefined ? { reviewContext: roleInput.reviewContext } : {})
          });
        }

        const priorRounds = roleInput.reviewContext?.previousRounds ?? [];
        const latestReview = priorRounds.at(-1);

        // Load pr.finalize prompt context
        let prFinalizePrompt: string | undefined;
        if (workInput.run.currentStep === 'pr.finalize') {
          try {
            const runSteps = await domainRepos.runSteps.listByRun(workInput.runId);
            let cumulativeSummary: CumulativeImplementationSummary | undefined;
            for (const step of [...runSteps].reverse()) {
              if (step.step === 'implementation.build' && step.checkpointResult !== null) {
                const checkpoint = step.checkpointResult as { cumulativeSummary?: unknown };
                const candidate = checkpoint?.cumulativeSummary;
                if (isCumulativeImplementationSummary(candidate)) {
                  cumulativeSummary = candidate;
                  break;
                }
              }
            }

            if (cumulativeSummary !== undefined || workInput.publicationReview) {
              const workspaceMeta = await domainRepos.runWorkspaceMetadata.findByRunId(workInput.runId);
              const branch = workspaceMeta?.workspaceHandle ?? workInput.run.id;
              const workspacePath = workInput.publicationReview ? 'pinned review copy' : workspaceMeta?.workspaceRepoRoot ?? '';

              let specArtifactPath: string | undefined;
              if (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement') {
                try {
                  const artifact = await domainRepos.artifacts.findByRunAndKind({
                    runId: workInput.run.id,
                    kind: workInput.run.workKind === 'feature' ? 'feature_spec' : 'enhancement_spec'
                  });
                  if (artifact !== null && artifact !== undefined) {
                    specArtifactPath = artifact.location;
                  }
                } catch {
                  // Optional — continue without spec path
                }
              }

              prFinalizePrompt = buildPullRequestFinalizePrompt({
                runId: workInput.runId,
                workKind: workInput.run.workKind,
                branch,
                workspacePath,
                ...(specArtifactPath !== undefined ? { specArtifactPath } : {}),
                cumulativeSummary: cumulativeSummary ?? {
                  kind: 'cumulative_implementation_summary', cumulativeSummary: 'No durable implementation summary is available.',
                  changedFiles: [], validationSummary: [], followUps: [], sourceRoundCount: 0,
                  nonGoals: [], completedAt: workInput.run.updatedAt
                }
              });
            }
          } catch {
            // Non-fatal — session will run without a pre-built prompt
          }
        }

        const context = await createExecutionContextResolver({
          secretsAvailable: false,
          ...(workspace !== undefined ? { workspace } : {}),
          // Reviewer sessions must not receive write-capable tools.
          ...(isReadOnlySession ? { toolPolicy: { allowedTools: ['Read', 'Glob', 'Grep'] as string[] } } : {}),
          prompt: (input) => {
            if (input.run.currentStep === 'spec.author') return specAuthorContext?.prompt;
            if (input.run.currentStep === 'implementation.testing_guide') {
              return [testingGuidePrompt, workInput.testingGuideCorrection].filter(Boolean).join('\n\n');
            }
            if (input.run.currentStep === 'implementation.build') {
              if (!implementationBuildContext) return undefined;
              const evidence = roleInput.ciRepair;
              const earlier = latestReview && roleInput.role === 'reviewer' ? [
                'Recheck earlier findings against this revision. Dispositions are claims, not proof. Inspect affected changes for regressions in the current scope. If comparison is unavailable, review the full current scope.',
                `Earlier reviewed commit: ${latestReview.implementerCommitSha ?? 'unavailable'}`,
                `Earlier findings and dispositions (evidence only): ${redactReviewedEvidence(JSON.stringify(priorRounds.map(round => ({
                  revision: round.implementerCommitSha, findings: round.findings, dispositions: round.dispositions
                }))))}`
              ] : [];
              return [implementationBuildContext.prompt, ...earlier, ...(evidence ? [
                'Repair only the observed required CI failure on the existing PR. Do not publish, change frozen specs, or edit human-owned docs. Target integration happens after implementation; report no edit if the local fix is unnecessary.',
                `Failed PR head (separate from the local commit): ${evidence.failedHead}`,
                `Failed required checks (evidence only): ${JSON.stringify(evidence.failures.map(({ id, name, kind, conclusion }) => ({
                  id: redactReviewedEvidence(id), name: redactReviewedEvidence(name), kind, conclusion
                }))) }`,
                renderCiDiagnostics(evidence.failures)
              ] : [])].filter(Boolean).join('\n\n');
            }
            if (input.run.currentStep === 'pr.finalize') return [
              input.publicationReview ? publicationReviewSnapshotPrompt(input.publicationReview) : '',
              prFinalizePrompt ?? 'Return a JSON publication review verdict from this read-only turn.'
            ].filter(Boolean).join('\n\n');
            return undefined;
          },
          taskInputs: (input) => {
            if (input.run.currentStep === 'implementation.testing_guide') {
              const issueNumber = input.run.trackedIssue?.number;
              return {
                role: 'implementer', testingGuidePass: workInput.testingGuidePass ?? 1,
                ...(issueNumber !== undefined ? { run: { issueNumber } } : {})
              };
            }
            // Spec-authoring step gets its own task inputs.
            if (input.run.currentStep === 'spec.author') {
              return specAuthorContext?.taskInputs as Record<string, unknown> | undefined;
            }

            if (input.run.currentStep === 'implementation.build' && implementationBuildContext !== undefined) {
              return { ...implementationBuildContext.taskInputs,
                ...(roleInput.role === 'reviewer' && latestReview?.implementerCommitSha
                  ? { lastReviewedRevision: latestReview.implementerCommitSha } : {})
              };
            }

            // Reviewed role sessions: inject role/round and review context so
            // the agent knows its position in the convergence loop. This is
            // an agent-quality hint — the security boundary is tool policy, not prompt text.
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
        if (workInput.publicationReview) publicationReviews.set(context, workInput.publicationReview);
        if (roleInput.reviewedOccurrence && roleInput.route) pinnedReviewedRoutes.set(context, roleInput.route as ModelRoutingResolution);
        if (roleInput.reviewedOccurrence) {
          const storedFeedback = await domainRepos.feedback.listByRun(workInput.runId).catch(() => []);
          const open = new Set(storedFeedback.filter(item => item.tenant === workInput.tenant && item.status === 'open').map(item => item.id));
          const altitude = roleInput.reviewContext?.altitudeContext?.altitude;
          const evidence: HandoffEvidence[] = priorRounds.flatMap((round, order) => [
            ...round.changedFilePaths.map(path => ({
              kind: 'revision' as const, id: path, current: round.altitude === altitude, order,
              text: `${path} (revision ${round.implementerCommitSha ?? 'unavailable'})`,
              ...(round.implementerCommitSha ? {} : { availability: 'unavailable' as const })
            })),
            ...round.findings.filter(finding => open.has(finding.feedbackId)).map(finding => ({
              kind: 'finding' as const, id: finding.feedbackId, current: round.altitude === altitude, order,
              text: `${finding.feedbackId}: ${finding.title}: ${finding.body}`
            })),
            ...round.dispositions.map(disposition => ({
              kind: 'disposition' as const, id: round.implementerCommitSha ?? `earlier-round-${order}`,
              feedbackId: disposition.feedbackId, current: round.altitude === altitude, order,
              text: JSON.stringify(disposition)
            }))
          ]);
          const specRevision = roleInput.specReview?.revision;
          if (specRevision) evidence.push({
            kind: 'revision', id: specRevision, current: true, order: 0,
            text: `Spec revision ${specRevision}; canonical path ${roleInput.specReview?.canonicalPath ?? 'unavailable'}`
          });
          const requiredFindingIds = new Set([
            ...(roleInput.reviewContext?.requiredDispositions ?? []).map(item => item.feedbackId),
            ...(roleInput.specReview?.feedback ?? []).map(item => item.feedbackId),
            ...(latestReview && roleInput.role === 'reviewer' ? priorRounds.flatMap(round => round.findings.map(finding => finding.feedbackId)) : [])
          ]);
          const requiredDispositions = new Set(latestReview && roleInput.role === 'reviewer' ?
            priorRounds.flatMap((round, order) => round.dispositions.map(disposition =>
              JSON.stringify([disposition.feedbackId, round.implementerCommitSha ?? `earlier-round-${order}`]))) : []);
          const project = workspace?.project;
          const workspaceRoot = project?.workspaceRootOverride ?? workspace?.roots?.workspacesRoot;
          const port = createReviewedAttemptPort({
            repository: agentConversations, roleInput, prepareFreshConversation,
            live: reviewedLiveConversations,
            recordReuse: ({ id, runId, step, role, round, occurrenceId }, evidence) => {
              app.log.info({ event: 'reviewed_conversation_reuse', runId, phase: step.split('.')[0], step, role, round,
                occurrenceId, attemptId: id, ...evidence }, 'Reviewed conversation decision.');
            },
            admitsLive: (profile, fresh) => isBuiltIn(profile) && admitsReviewedLiveConversation(profile, fresh),
            freshHandoff: renderReviewedHandoff({ evidence, requiredFindingIds, requiredDispositions }),
            ...(workspaceRoot ? { workspacesRoot: workspaceRoot } : {}),
            ...(workspaceRoot && project && workspace?.roots ? {
              admit: (environment, generation, profile) => isBuiltIn(profile) ? nativeHistory.admit({
                environment, generation, profile, tenant: roleInput.tenant, workspaceRoot,
                referencedScopes: () => agentConversations.referencedScopes(roleInput.tenant, roleInput.runId, generation)
              }) : Promise.resolve(undefined),
              async reconcileWorkspace(environment, generation) {
                if (environment.workspace.shape !== 'two_roots') return;
                const live = agentConversations.referencedScopes(roleInput.tenant, roleInput.runId, generation);
                await nativeHistory.lifecycle.reconcileConversationScopes({
                  runRoot: dirname(environment.workspace.repoRoot), runId: roleInput.runId, tenant: roleInput.tenant,
                  keep: (scope, owner) => owner.generation === generation && live.has(scope)
                });
              }
            } : {}),
            ...(project ? { repositoryIdentity: `${project.hostRepository.owner}/${project.hostRepository.name}`.toLowerCase() } : {}),
            ...(project && workspace?.roots ? {
              hostRepository: join(workspace.roots.reposRoot, project.hostRepository.owner, project.hostRepository.name)
            } : {})
          });
          if (port) reviewedAttempts.set(context, port);
        }
        return context;
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
    if (runWorkspaceGit !== undefined) {
      const reviewedExecutionDispatcher = createReviewedExecutionDispatcher({
        unitOfWork: executionUnitOfWork
      });
      convergenceEngine = createLayeredConvergenceEngine({
        dispatcher: reviewedExecutionDispatcher,
        git: runWorkspaceGit,
        feedback: domainRepos.feedback,
        runSteps: domainRepos.runSteps,
        readRun: async ({ tenant, runId }) => {
          const run = await domainRepos.runs.findById(runId);
          return run?.tenant === tenant ? run : null;
        },
        routing: convergenceRoutingResolver,
        getPolicy: getStepConvergencePolicy,
        logger: {
          warn(message: string, details?: unknown) {
            console.warn(message, details);
          },
          info(event, fields) {
            app.log.info({ ...fields, event }, event);
          },
          error(event, fields) {
            app.log.error({ ...fields, event }, event);
          }
        },
        workspaceContextRefresher: async (runId) => {
          const cached = runWorkspaceRootRegistry.get(runId);
          if (cached === undefined) return undefined;
          return { workspaceRepoRoot: cached.repoRoot, workspaceHandle: cached.branchName };
        }
      });
    }
  }

  const nodeFilesystem = createNodeWorkspaceFilesystem();
  const nodeGit = createNodeWorkspaceGit();

  // Spec freeze dependencies: require RunWorkspaceGitPort (available when workspaceRoots configured).
  const specFreezeDependencies: SpecFreezeDependencies | undefined =
    runWorkspaceGit !== undefined
      ? {
          artifacts: domainRepos.artifacts,
          filesystem: nodeFilesystem,
          git: runWorkspaceGit,
          clock: () => new Date().toISOString()
        }
      : undefined;

  // Code-host adapter and registry for pr.open and merge detection.
  const safeGitExecutorForCodeHost: SafeGitExecutor = {
    async pushBranch(input) {
      await execFileAsync('git', ['push', input.remote ?? 'origin', input.branch], {
        cwd: input.workspaceRepoRoot,
        ...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {})
      });
    }
  };

  // The adapter owns the shared gh helper internally, so the composition root never imports it
  // (keeping gh usage inside the adapter boundary). Tests override the binary path through
  // `codeHost.executablePath`, or inject a full fake via `codeHost.executeGh`.
  // Fake mode injects scripted gh executors; explicit options always win.
  const effectiveCodeHostExecuteGh = options.codeHost?.executeGh ?? scriptedCodeHostExecuteGh;
  const effectiveIssueTrackerExecuteGh = options.githubIssueTracker?.executeGh ?? scriptedIssueTrackerExecuteGh;

  const githubCodeHostAdapter = createGitHubCodeHostAdapter({
    git: safeGitExecutorForCodeHost,
    ...(effectiveCodeHostExecuteGh !== undefined
      ? { executeGh: effectiveCodeHostExecuteGh }
      : {
          ...(options.codeHost?.executablePath !== undefined ? { ghExecutablePath: options.codeHost.executablePath } : {}),
          ...(options.codeHost?.timeoutMs !== undefined ? { timeoutMs: options.codeHost.timeoutMs } : {})
        }
    )
  });

  const codeHostRegistry = createCodeHostRegistry([
    { provider: 'github', create: () => githubCodeHostAdapter }
  ]);

  const repairRepository = new DrizzleRepairRepository(database);
  const repairLimit = options.pullRequestCiRepairLimit ?? 2;
  if (!Number.isSafeInteger(repairLimit) || repairLimit < 0) throw new Error('Invalid pull request CI repair limit.');
  const pullRequestOpenDependencies: PullRequestOpenWiringDependencies = {
    conversations: domainRepos.conversations,
    topics: domainRepos.topics,
    projects: domainRepos.projects,
    pullRequests: domainRepos.pullRequests,
    codeHosts: codeHostRegistry,
    ...(runWorkspaceGit !== undefined ? { runWorkspaceGit } : {}),
    ...(options.workspaceRoots !== undefined ? { publicationGit: createPublicationGit(options.workspaceRoots.workspacesRoot) } : {}),
    ...(convergenceEngine !== undefined && resolvedUnitOfWork !== undefined && runWorkspaceGit !== undefined && !fakeDispatchEnabled
      ? { repair: { repository: repairRepository, limit: repairLimit } } : {}),
    ...(fakeStatePaths !== undefined ? { publicationRemoteOverride: fakeStatePaths.fixtureRemote } : {}),
    resolveCredential: options.resolveCredential ?? createCodeHostCredentialResolver(secretStore)
  };

  const feedbackLifecycleDependencies: FeedbackLifecycleDependencies = {
    feedback: domainRepos.feedback,
    ids: () => randomUUID(),
    clock: () => new Date().toISOString()
  };

  const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
    artifacts: domainRepos.artifacts,
    filesystem: nodeFilesystem,
    git: nodeGit,
    clock: () => new Date().toISOString(),
    feedbackLifecycle: feedbackLifecycleDependencies
  };

  const specApprovalFinalizerDependencies: SpecApprovalFinalizerDependencies = {
    artifacts: domainRepos.artifacts,
    filesystem: nodeFilesystem,
    git: nodeGit,
    clock: () => new Date().toISOString()
  };

  // Resolve workspace context: try in-memory registry first (populated during materialization),
  // then fall back to the persistent run_workspace_metadata store for post-restart recovery.
  // workspaceHandle is the git branch name, not the runId.
  const internalResolveWorkspaceContext: WorkspaceContextResolver = async ({ runId }) => {
    const cached = runWorkspaceRootRegistry.get(runId);
    if (cached !== undefined) {
      return { workspaceRepoRoot: cached.repoRoot, workspaceHandle: cached.branchName };
    }
    const persisted = await domainRepos.runWorkspaceMetadata.findByRunId(runId);
    if (persisted !== null) {
      return { workspaceRepoRoot: persisted.workspaceRepoRoot, workspaceHandle: persisted.workspaceHandle };
    }
    throw new Error(`Workspace root not available for run '${runId}'. The run may not have been dispatched yet.`);
  };

  const workflowResolver = options.workflowResolver ?? defaultRunWorkflowResolver;
  const orchestrator = new DefaultOrchestrator({
    workflowResolver,
    runs: domainRepos.runs,
    conversationIngress,
    events: {
      append(input) {
        if (input.event.type === 'run_state_transition' && input.event.run.terminal) {
          reviewedLiveConversations.retireRun(reviewedLiveRunKey(input.scope.tenant, input.scope.runId), 'run_terminal');
        }
        return eventBus.append(input);
      },
      replayAfter: input => eventBus.replayAfter(input),
      subscribe: input => eventBus.subscribe(input)
    },
    dispatchQueue,
    ...(resolvedUnitOfWork !== undefined ? { unitOfWork: resolvedUnitOfWork } : {}),
    feedbackLifecycleDependencies,
    specAuthoringDependencies,
    specApprovalFinalizerDependencies,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    resolveWorkspaceContext: options.resolveWorkspaceContext ?? internalResolveWorkspaceContext,
    runSteps: domainRepos.runSteps,
    testingGuides: domainRepos.testingGuides,
    testResults: domainRepos.testResults,
    ...(convergenceEngine !== undefined ? { convergenceEngine } : {}),
    ...(options.autoDispatch !== undefined ? { autoDispatch: options.autoDispatch } : {}),
    ...(specFreezeDependencies !== undefined ? { specFreezeDependencies } : {}),
    pullRequestOpenDependencies,
    logger: {
      info(message: string, details?: unknown) {
        app.log.info(details as Record<string, unknown>, message);
      },
      warn(message: string, details?: unknown) {
        console.warn(message, details);
      }
    }
  });
  const policy = options.policy ?? permissivePolicyDecisionPoint;
  const githubTracker = new GitHubIssueTracker({
    secretResolver: secretStore,
    ...(effectiveIssueTrackerExecuteGh !== undefined ? { executeGhFn: effectiveIssueTrackerExecuteGh } : {}),
    ...(options.githubIssueTracker?.executablePath !== undefined ? { executablePath: options.githubIssueTracker.executablePath } : {}),
    ...(options.githubIssueTracker?.timeoutMs !== undefined ? { timeoutMs: options.githubIssueTracker.timeoutMs } : {})
  });
  const trackerRegistry = new StaticIssueTrackerRegistry({ github: githubTracker });
  const issueReferenceIntakeResolver = new DefaultIssueReferenceIntakeResolver({ registry: trackerRegistry });

  // Recovery workspace seam: wires the control-plane service's recovery concerns to the
  // execution workspace provisioner and the run workspace git port. Only available when a
  // workspace-backed deployment is configured (repos/workspaces roots + git port).
  let recoveryDependencies: RunRecoveryDependencies | undefined;
  if (options.workspaceRoots !== undefined && runWorkspaceGit !== undefined) {
    const recoveryRoots = options.workspaceRoots;
    const recoveryGit = runWorkspaceGit;
    const twoRootRecoveryWorkKinds = new Set(['feature', 'enhancement', 'bug', 'chore']);
    const buildRecoveryProvisionRequest = async (run: Run): Promise<ProvisionWorkspaceRequest | null> => {
      if (!twoRootRecoveryWorkKinds.has(run.workKind)) return null;
      const topic = await domainRepos.topics.findById(run.topicId);
      if (topic === null || topic.tenant !== run.tenant) return null;
      const conversation = await domainRepos.conversations.findById(topic.conversationId);
      if (conversation === null || conversation.tenant !== run.tenant) return null;
      const project = await domainRepos.projects.findById(conversation.projectId);
      if (project === null || project.tenant !== run.tenant) return null;
      return {
        runId: run.id,
        runKind: run.workKind as ProvisionWorkspaceRequest['runKind'],
        topicSlug: deriveTopicSlug(topic.title),
        shortRunId: deriveShortRunId(run.id),
        project,
        roots: { reposRoot: recoveryRoots.reposRoot, workspacesRoot: recoveryRoots.workspacesRoot }
      };
    };
    recoveryDependencies = {
      detectCommittedCheckpoints: async ({ run }) => {
        // Compare the run branch head to the provisioned base ref via the git port. A missing
        // base ref, a missing run branch, or an identical head means no meaningful commit.
        const metadata = await domainRepos.runWorkspaceMetadata.findByRunId(run.id);
        const baseRef = metadata?.provisionedBaseRef ?? null;
        if (baseRef === null) return false;
        if (await orchestrator.workspaceHeld({ runId: run.id, tenant: run.tenant })) {
          throw new RunRecoveryWorkspaceError('materialization_failed', 'The workspace is held for authorized host inspection.');
        }
        const request = await buildRecoveryProvisionRequest(run);
        if (request === null) return false;
        let result;
        try {
          result = await provisionWorkspace({ ...request, materializationBase: { kind: 'run_branch' }, existingWorkspaceBehavior: 'keep' });
        } catch (error) {
          if (error instanceof WorkspaceProvisioningError && error.code === 'run_branch_missing') return false;
          throw error;
        }
        if (result.shape !== 'two_roots') return false;
        runWorkspaceRootRegistry.set(run.id, { repoRoot: result.repoRoot, branchName: result.branchName });
        const changed = await recoveryGit.getChangedFiles({
          workspaceRepoRoot: result.repoRoot,
          baseRef,
          headRef: result.branchName
        });
        return changed.length > 0;
      },
      materializeWorkspace: async ({ run, baseKind, existingWorkspaceBehavior }) => {
        if (await orchestrator.workspaceHeld({ runId: run.id, tenant: run.tenant })) {
          throw new RunRecoveryWorkspaceError('materialization_failed', 'The workspace is held for authorized host inspection.');
        }
        const request = await buildRecoveryProvisionRequest(run);
        if (request === null) return { provisioningOutcome: 'none' };
        if (existingWorkspaceBehavior === 'replace') agentConversations.invalidateWorkspace(run.tenant, run.id);
        let result;
        try {
          result = await provisionWorkspace({ ...request, materializationBase: { kind: baseKind }, existingWorkspaceBehavior });
        } catch (error) {
          if (error instanceof WorkspaceProvisioningError && error.code === 'run_branch_missing') {
            throw new RunRecoveryWorkspaceError('run_branch_missing', 'Run branch is missing.');
          }
          throw error;
        }
        if (result.shape !== 'two_roots') return { provisioningOutcome: 'none' };
        // Keep the in-memory registry and durable metadata in sync so the reopened run's
        // dispatch resolves the repo root and branch after recovery.
        runWorkspaceRootRegistry.set(run.id, { repoRoot: result.repoRoot, branchName: result.branchName });
        await domainRepos.runWorkspaceMetadata.upsert({
          runId: run.id,
          workspaceHandle: result.branchName,
          workspaceRepoRoot: result.repoRoot,
          provisionedBaseRef: result.provisionedBaseRef,
          createdAt: new Date().toISOString()
        });
        return { provisioningOutcome: result.outcome };
      }
    };
  }

  const controlPlane = new DefaultControlPlaneService({
    topics: domainRepos.topics,
    workflowResolver,
    orchestrator,
    runs: domainRepos.runs,
    runSteps: domainRepos.runSteps,
    events: eventBus,
    policy,
    artifacts: domainRepos.artifacts,
    testingGuides: domainRepos.testingGuides,
    testResults: domainRepos.testResults,
    feedback: domainRepos.feedback,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    workspaceFilesystem: nodeFilesystem,
    feedbackLifecycle: feedbackLifecycleDependencies,
    projects: domainRepos.projects,
    issueReferenceIntakeResolver,
    pullRequests: domainRepos.pullRequests,
    sessions: domainRepos.sessions,
    prActivity: createPrActivityReader({
      repairs: repairRepository, pullRequests: domainRepos.pullRequests,
      coverage: async tenant => {
        const ticker = options.pullRequestReconciliationTicker;
        if (ticker?.enabled !== true) return 'ticker_disabled';
        if (ticker.tenant !== tenant) return 'tenant_not_covered';
        const decision = await policy.authorize({
          action: 'pull_request.reconcile', resource: { kind: 'pull_request_reconciliation', path: '/v1/pull-requests/reconcile' },
          principal: { kind: 'system', id: 'principal_system_reconciliation', tenantId: tenant }
        });
        return decision.allowed ? 'enabled' : 'tenant_not_covered';
      }
    }),

    ...(recoveryDependencies !== undefined ? { recovery: recoveryDependencies } : {})
  });
  options.onControlPlaneReady?.(controlPlane);

  // Startup workspace reconciliation: recreate any missing on-disk workspaces for
  // non-terminal two-root runs from their durable run branch, and fail runs whose run
  // branch is missing — without dispatching, advancing, or recovering any run. Runs here
  // after persistence/configuration and the orchestrator are ready, and before the
  // service begins accepting traffic. A failure for one run is logged safely and never
  // prevents later runs from being reconciled or the service from starting.
  if (realDispatchEnabled && !fakeDispatchEnabled) await nativeHistory.recover();
  if (options.workspaceRoots !== undefined) {
    const reconcileRoots = options.workspaceRoots;
    const twoRootWorkKinds = new Set(['feature', 'enhancement', 'bug', 'chore']);
    const buildReconcileProvisionRequest = async (run: Run): Promise<ProvisionWorkspaceRequest | null> => {
      const repairs = await repairRepository.listByRun(run.id, run.tenant);
      if (repairs.some(row => row.workspaceHold || row.currentStepId !== null)) return null;
      if (!twoRootWorkKinds.has(run.workKind)) {
        return null;
      }
      // Only reconcile runs that were already provisioned at least once. Persisted workspace
      // metadata is the signal that a run branch exists to recover from; a run that has never
      // been dispatched has no branch yet and must be left for normal dispatch, not failed as
      // run_branch_missing.
      const workspaceMetadata = await domainRepos.runWorkspaceMetadata.findByRunId(run.id);
      if (workspaceMetadata === null) {
        return null;
      }
      const topic = await domainRepos.topics.findById(run.topicId);
      if (topic === null || topic.tenant !== run.tenant) {
        return null;
      }
      const conversation = await domainRepos.conversations.findById(topic.conversationId);
      if (conversation === null || conversation.tenant !== run.tenant) {
        return null;
      }
      const project = await domainRepos.projects.findById(conversation.projectId);
      if (project === null || project.tenant !== run.tenant) {
        return null;
      }
      return {
        runId: run.id,
        runKind: run.workKind as ProvisionWorkspaceRequest['runKind'],
        topicSlug: deriveTopicSlug(topic.title),
        shortRunId: deriveShortRunId(run.id),
        project,
        roots: { reposRoot: reconcileRoots.reposRoot, workspacesRoot: reconcileRoots.workspacesRoot }
      };
    };
    try {
      const summary = await reconcileStartupWorkspaces({
        listNonTerminalRuns: () =>
          domainRepos.runs.listNonTerminal !== undefined ? domainRepos.runs.listNonTerminal() : Promise.resolve([]),
        buildProvisionRequest: buildReconcileProvisionRequest,
        provisionWorkspace: async request => {
          const result = await provisionWorkspace(request);
          if (realDispatchEnabled && !fakeDispatchEnabled && result.shape === 'two_roots') {
            try {
              const ready = agentConversations.readyWorkspaceScopes({ tenant: request.project.tenant, runId: request.runId,
                root: result.repoRoot, branch: result.branchName });
              const reconciled = await nativeHistory.lifecycle.reconcileConversationScopes({
                runRoot: result.runRoot, runId: request.runId, tenant: request.project.tenant,
                // If the durable workspace binding is missing, do not infer that all scopes are overdue.
                keep: (scope, owner) => !ready || (owner.generation === ready.generation && ready.scopes.has(scope))
              });
              if (!reconciled) app.log.warn({ runId: request.runId, code: 'conversation_writer_unverified' },
                'Private conversation reclamation remains pending.');
            } catch {
              app.log.warn({ runId: request.runId, code: 'conversation_reconciliation_unavailable' },
                'Private conversation reconciliation is unavailable.');
            }
          }
          return result;
        },
        orchestrator,
        logger: {
          info: (fields, message) => app.log.info(fields, message),
          warn: (fields, message) => app.log.warn(fields, message),
          error: (fields, message) => app.log.error(fields, message)
        }
      });
      app.log.info({ ...summary }, 'Startup workspace reconciliation complete.');
    } catch (error) {
      // Defensive: reconcileStartupWorkspaces is designed not to throw per-run, but the
      // service must still start even if the walk itself fails unexpectedly.
      app.log.error({ errorName: (error as Error)?.name }, 'Startup workspace reconciliation threw; continuing startup.');
    }
  }

  // Retired claims remain fenced in SQLite while their provider reads are in
  // flight. Do not make ordinary server startup wait on a repair's remote PR.
  void orchestrator.restoreRepairs().catch(() => {
    app.log.warn({ event: 'repair_recovery_deferred' }, 'Could not restore CI repair dispatch.');
  });
  await registerControlPlaneRoutes(app, {
    health: options.health ?? {
      isDatabaseReachable: async () => checkSqliteDatabaseReachability(database)
    },
    auth: {
      bearerToken: options.bearerToken,
      ...(options.resolvePrincipal !== undefined ? { resolvePrincipal: options.resolvePrincipal } : {})
    },
    policy,
    probeResources: new DrizzleProbeResourceRepository(database),
    configurationRecords,
    providerCredentialRequired: (profile) => !providerCompositionResult.composed.some(binding =>
      binding.configurationRecordId === profile.id &&
      binding.providerKind === ('providerKind' in profile ? profile.providerKind : undefined) &&
      binding.adapterId === ('adapterId' in profile ? profile.adapterId : undefined) &&
      (binding.adapter as { credentialRequirement?: string }).credentialRequirement === 'external'
    ),
    secrets: secretStore,
    projects: domainRepos.projects,
    controlPlane
  });

  // Optional same-origin static client serving. Registered after core routes so
  // `/health` and `/v1` keep precedence; the not-found handler supplies SPA
  // fallback for extensionless HTML GETs and preserves Fastify's default 404
  // everywhere else. Kept out of packages/core/src/routes.ts by design.
  if (options.clientDirectory !== undefined) {
    registerStaticClientRoutes(app, { clientDirectory: options.clientDirectory });
    app.setNotFoundHandler(createStaticClientNotFoundHandler({ clientDirectory: options.clientDirectory }));
  }

  app.log.info({
    event: 'pr_ci_coverage', periodic: options.pullRequestReconciliationTicker?.enabled === true,
    repairLimit, admissionEnabled: repairLimit > 0 && pullRequestOpenDependencies.repair !== undefined,
    ...(options.pullRequestReconciliationTicker?.enabled === true ? {
      tenant: options.pullRequestReconciliationTicker.tenant, intervalMs: options.pullRequestReconciliationTicker.intervalMs
    } : {})
  }, options.pullRequestReconciliationTicker?.enabled === true
    ? 'Periodic PR reconciliation configured; policy authorizes the tenant on each pass.'
    : 'Periodic PR reconciliation is off; only authorized batches can observe CI for repair admission.');
  if (options.pullRequestReconciliationTicker?.enabled === true) {
    const tickerTenant = options.pullRequestReconciliationTicker.tenant;
    const systemPrincipal: NonModelPrincipal = {
      kind: 'system',
      id: 'principal_system_reconciliation',
      tenantId: tickerTenant
    };
    const ticker = createPullRequestReconciliationTicker({
      controlPlane: controlPlane,
      principal: systemPrincipal,
      tenant: tickerTenant,
      intervalMs: options.pullRequestReconciliationTicker.intervalMs,
      logger: { warn: (msg, details) => { app.log.warn({ ...(details !== null && typeof details === 'object' ? details as Record<string, unknown> : {}) }, msg); } }
    });
    ticker.start();
    app.addHook('onClose', async () => { ticker.stop(); });
  }

  app.addHook('onClose', async () => {
    reviewedLiveConversations.close();
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
    ...(config.onControlPlaneReady !== undefined ? { onControlPlaneReady: config.onControlPlaneReady } : {}),
    ...(config.pullRequestCiRepairLimit !== undefined ? { pullRequestCiRepairLimit: config.pullRequestCiRepairLimit } : {}),
    ...(config.pullRequestReconciliationTicker !== undefined ? { pullRequestReconciliationTicker: config.pullRequestReconciliationTicker } : {})
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
