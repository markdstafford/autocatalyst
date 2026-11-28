import {
  runTestingGuideResultsPath, runTestResultsPath, runTestResultsResponseSchema, saveTestingGuideResultsRequestSchema,
  testingGuideResultsSchema, type SaveTestingGuideResultsRequest
} from '@autocatalyst/api-contract';
import { runTestingGuidePath, testingGuideSchema } from '@autocatalyst/api-contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { emptyRunActionRequestSchema, setRunStepRequestSchema, renameRunRequestSchema, runActionResponseSchema,
  type RunActionResponse } from '@autocatalyst/api-contract';
import { runOperatorPolicy } from './policy.js';
import { requireNonModelPrincipal, type ServiceRunActionInput } from './control-plane-service.js';

import { z, ZodError } from 'zod';

import {
  activeRunConflictErrorCode,
  createRunReplySuccessStatusCode,
  runRepliesPath,
  runReplyRequestSchema,
  runReplyResponseSchema,
  getRunWorkflowSuccessStatusCode,
  runWorkflowPath,
  runWorkflowResponseSchema,
  recoverRunSuccessStatusCode,
  runRecoveryPath,
  runRecoveryRequestSchema,
  runRecoveryResponseSchema,
  configurationRecordCollectionPath,
  configurationRecordIdParamsSchema,
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  conversationCollectionPath,
  createConfigurationRecordRequestSchema,
  createConfigurationRecordSuccessStatusCode,
  createConversationSuccessStatusCode,
  createConversationWithFirstRunRequestSchema,
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  appendRunFeedbackThreadRequestSchema,
  appendRunFeedbackThreadSuccessStatusCode,
  createRunFeedbackRequestSchema,
  createRunFeedbackSuccessStatusCode,
  createSecretRequestSchema,
  createSecretResponseSchema,
  createSecretSuccessStatusCode,
  degradedHealthStatusCode,
  deleteConfigurationRecordSuccessStatusCode,
  errorResponseSchema,
  eventsStreamPath,
  feedbackSchema,
  feedbackResponseSchema,
  forbiddenErrorCode,
  getRunPullRequestSuccessStatusCode,
  getRunSpecSuccessStatusCode,
  getRunSuccessStatusCode,
  listRunFeedbackSuccessStatusCode,
  listRunSessionsSuccessStatusCode,
  listRunsSuccessStatusCode,
  listRunsQuerySchema,
  decodeRunListCursor,
  encodeRunListCursor,
  runListResponseSchema,
  healthResponseSchema,
  intakeRoutingErrorCode,
  intakeRoutingErrorResponseSchema,
  listRunStepsSuccessStatusCode,
  notFoundErrorCode,
  principalDiagnosticPath,
  principalDiagnosticResponseSchema,
  probeResourceCollectionPath,
  probeResourceIdParamsSchema,
  probeResourceSchema,
  pullRequestReconciliationPath,
  pullRequestReconciliationResponseSchema,
  reconcilePullRequestsSuccessStatusCode,
  runCollectionPath,
  clientRunEventSchema,
  formatRunEventFrameName,
  runEventsMediaType,
  runEventsPath,
  runEventsSuccessStatusCode,
  runFeedbackListResponseSchema,
  runFeedbackPath,
  runFeedbackThreadPath,
  runFeedbackThreadParamsSchema,
  updateRunFeedbackPath,
  updateRunFeedbackParamsSchema,
  updateRunFeedbackRequestSchema,
  updateRunFeedbackSuccessStatusCode,
  runIdParamsSchema,
  pullRequestCheckFailedErrorCode,
  pullRequestCheckFailedMessage,
  pullRequestCheckFailedResponseSchema,
  refreshRunPullRequestSuccessStatusCode,
  runPullRequestRefreshPath,
  runPullRequestRefreshRequestSchema,
  runPullRequestRefreshResponseSchema,
  runPullRequestPath,
  runPullRequestResponseSchema,
  runSessionListResponseSchema,
  runSessionsPath,
  runSpecPath,
  runSpecResponseSchema,
  runStepListResponseSchema,
  runStepsPath,
  secretCollectionPath,
  secretStoreLockedErrorCode,
  conflictErrorCode,
  unknownCredentialReferenceErrorCode,
  createProjectRequestSchema,
  createProjectSuccessStatusCode,
  getProjectSuccessStatusCode,
  lookupProjectIssueSuccessStatusCode,
  listProjectsSuccessStatusCode,
  projectCollectionPath,
  projectIdParamsSchema,
  projectIssueLookupResponseSchema,
  projectIssueNotFoundResponseSchema,
  projectIssueParamsSchema,
  projectIssuePath,
  projectListResponseSchema,
  projectResponseSchema,
  updateProjectRequestSchema,
  updateProjectSuccessStatusCode,
  updateConfigurationRecordRequestSchema,
  type AppendRunFeedbackThreadRequest,
  type ConfigurationRecord,
  type ConfigurationRecordIdParams,
  type CreateConfigurationRecordRequest,
  type CreateConversationWithFirstRunRequest,
  type CreateProbeResourceRequest,
  type CreateProjectRequest,
  type CreateRunFeedbackRequest,
  type UpdateRunFeedbackRequest,
  type CreateSecretRequest,
  type ProjectIdParams,
  type UpdateProjectRequest,
  type ErrorResponse,
  type ProbeResourceIdParams,
  type ReconcilePullRequestsResponse,
  type RunListCursor,
  type RunIdParams,
  type RunPullRequestResponse,
  type RunRecoveryRequest,
  type RunReplyRequest,
  type RunSessionListResponse,
  type UpdateConfigurationRecordRequest
} from '@autocatalyst/api-contract';

import { registerBearerAuthHook, type BearerAuthOptions } from './auth.js';
import {
  ControlPlaneServiceError,
  type ControlPlaneService
} from './control-plane-service.js';
import { getHealth, type HealthDependencyChecker } from './health.js';
import {
  authorizeRequest,
  type PolicyAction,
  type PolicyDecisionPoint,
  type PolicyResourceDescriptor
} from './policy.js';
import { requirePrincipalFromRequest } from './principal.js';
import {
  createProbeResource,
  getProbeResource,
  type ProbeResourceRepository
} from './probe-resource.js';
import {
  ModelRateConflictError,
  assertActiveRoutesReferenceDispatchableProfiles,
  assertProviderProfileUpdateDoesNotBreakActiveRoutes,
  createConfigurationRecord,
  deleteConfigurationRecord,
  getConfigurationRecord,
  listConfigurationRecords,
  updateConfigurationRecord,
  type ConfigurationRecordRepository
} from './configuration-record.js';
import { createSecret, SecretStoreLockedError, type SecretStore, type SecretExistenceChecker } from './secret.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  ProjectServiceError
} from './project.js';
import type { ListRunsByTenantFilters, ProjectRepository } from './domain-repositories.js';
import type { RunEventSubscription } from './run-events.js';

export const runPullRequestReadPolicyAction = 'run_pull_request.read' as const;
export const runPullRequestPolicyResourceKind = 'run_pull_request' as const;
export const runSessionsListPolicyAction = 'run_sessions.list' as const;
export const runSessionsPolicyResourceKind = 'run_sessions' as const;

export interface SafeServerErrorLogFields {
  readonly event: 'route_failure';
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly errorName: string;
  readonly errorCode?: string;
  readonly stack?: string;
}

export interface ControlPlaneRouteDependencies {
  readonly health: HealthDependencyChecker;
  readonly auth: BearerAuthOptions;
  readonly policy: PolicyDecisionPoint;
  readonly probeResources: ProbeResourceRepository;
  readonly configurationRecords: ConfigurationRecordRepository;
  readonly providerCredentialRequired?: (profile: ConfigurationRecord) => boolean;
  readonly secrets: SecretStore & SecretExistenceChecker;
  readonly projects: ProjectRepository;
  readonly controlPlane: ControlPlaneService;
}

function routePattern(request: FastifyRequest): string {
  return (request.routeOptions as { url?: string } | undefined)?.url ?? (request as unknown as { routerPath?: string }).routerPath ?? request.url.split('?')[0] ?? 'unknown';
}

function safeStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined;
  return error.stack
    // Strip the first line (error name + message) — errorName is already in the structured log
    // fields and the raw message may contain provider/subprocess/workspace details.
    .replace(/^[^\n]*\n?/, '')
    // Redact absolute filesystem paths. Covers /Users, /workspace, /tmp, /home, /var and other
    // common roots while avoiding URL path segments like /v1/runs/... which start with digits.
    .replace(/\/(Users|workspace|tmp|home|var|opt|root|proc|app|srv|mnt|usr|etc|run|dev|sys)\/[^\s)"']+/gu, '[filesystem-path]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, 'Bearer [redacted]')
    .replace(/SECRET_SENTINEL/gu, '[redacted]');
}

function buildSafeServerErrorLogFields(request: FastifyRequest, statusCode: number, error: unknown, code?: string): SafeServerErrorLogFields {
  const stack = safeStack(error);
  return {
    event: 'route_failure',
    requestId: request.id,
    method: request.method,
    route: routePattern(request),
    statusCode,
    errorName: error instanceof Error ? error.name : 'UnknownError',
    ...(code !== undefined ? { errorCode: code } : {}),
    ...(stack !== undefined ? { stack } : {})
  };
}

function logServerFault(request: FastifyRequest, statusCode: number, error: unknown, code?: string): void {
  request.log.error(buildSafeServerErrorLogFields(request, statusCode, error, code), 'Autocatalyst route produced a 5xx response.');
}

async function handleControlPlaneServiceError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: ControlPlaneServiceError
): Promise<void> {
  switch (error.code) {
    case 'not_found':
      await reply.status(404).send(errorResponse(notFoundErrorCode, error.message));
      return;
    case 'forbidden':
    case 'unauthorized':
      await reply.status(403).send(errorResponse(forbiddenErrorCode, error.message));
      return;
    case 'intake_routing_error':
      await reply.status(400).send(intakeRoutingErrorResponseSchema.parse({
        error: { code: intakeRoutingErrorCode, message: error.message, details: error.details }
      }));
      return;
    case 'active_run_conflict':
      await reply.status(409).send(errorResponse(activeRunConflictErrorCode, error.message, error.details));
      return;
    case 'persistence_failed':
      logServerFault(request, 500, error, error.code);
      await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
      return;
    case 'invalid_transition':
      await reply.status(400).send(errorResponse('invalid_transition', error.message, error.details));
      return;
    case 'unknown_test_items':
    case 'invalid_feedback_anchor':
      await reply.status(422).send(errorResponse(error.code, error.message, error.details));
      return;
    case 'unsupported_pause':
      await reply.status(409).send(errorResponse('unsupported_pause', error.message, error.details));
      return;
    case pullRequestCheckFailedErrorCode: {
      const response = pullRequestCheckFailedResponseSchema.parse({
        error: { code: pullRequestCheckFailedErrorCode, message: pullRequestCheckFailedMessage, details: error.details }
      });
      logServerFault(request, 502, undefined, pullRequestCheckFailedErrorCode);
      await reply.status(502).send(response);
      return;
    }
    case 'conflict':
      await reply.status(409).send(errorResponse('conflict', error.message, error.details));
      return;
    default:
      logServerFault(request, 500, error, error.code);
      await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
  }
}

async function handleProjectServiceError(
  reply: FastifyReply,
  error: ProjectServiceError
): Promise<void> {
  switch (error.code) {
    case 'forbidden':
      await reply.status(403).send(errorResponse(forbiddenErrorCode, error.message));
      return;
    case 'conflict':
      await reply.status(409).send(errorResponse(conflictErrorCode, error.message));
      return;
    case 'not_found':
      await reply.status(404).send(errorResponse(notFoundErrorCode, error.message));
      return;
    case 'unknown_credential_reference':
      await reply.status(422).send(errorResponse(unknownCredentialReferenceErrorCode, error.message, error.details));
      return;
  }
}

function errorResponse(code: string, message: string, details?: unknown): ErrorResponse {
  const response: ErrorResponse =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return errorResponseSchema.parse(response);
}

function parseBody(request: FastifyRequest): CreateProbeResourceRequest {
  return createProbeResourceRequestSchema.parse(request.body);
}

function parseParams(request: FastifyRequest): ProbeResourceIdParams {
  return probeResourceIdParamsSchema.parse(request.params);
}

async function sendValidationError(reply: FastifyReply, error: unknown): Promise<void> {
  const details = error instanceof ZodError ? { issues: error.issues } : undefined;
  await reply.status(400).send(errorResponse('validation_error', 'Request validation failed.', details));
}

function authorizePreHandler(
  policy: PolicyDecisionPoint,
  action: PolicyAction,
  resourceFn: (request: FastifyRequest) => PolicyResourceDescriptor
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requirePrincipalFromRequest(request);
    const decision = await authorizeRequest(policy, {
      principal,
      action,
      resource: resourceFn(request)
    });
    if (!decision.allowed) {
      await reply.status(403).send(errorResponse('forbidden', 'Forbidden.'));
    }
  };
}

export async function registerControlPlaneRoutes(
  app: FastifyInstance,
  dependencies: ControlPlaneRouteDependencies
): Promise<void> {
  // Register error handler before plugin registration so child plugin route contexts
  // inherit it at route-registration time (Fastify captures context.errorHandler
  // during plugin setup; handlers registered after register() are too late).
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ZodError) {
      await sendValidationError(reply, error);
      return;
    }
    try {
      logServerFault(request, 500, error);
    } catch {
      // swallow logging errors so the response is always sent
    }
    await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
  });

  // PUBLIC: Health check (no auth)
  app.get('/health', async (_request, reply) => {
    const health = healthResponseSchema.parse(await getHealth(dependencies.health));
    const statusCode = health.status === 'ok' ? 200 : degradedHealthStatusCode;
    await reply.status(statusCode).send(health);
  });

  // Authenticate refresh before parsing its required JSON body; leave other routes unchanged.
  await app.register(async (protectedApp) => {
    await registerBearerAuthHook(protectedApp, dependencies.auth, 'onRequest');

    protectedApp.post(runPullRequestRefreshPath, {
      onRequest: async (request, reply) => {
        const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType !== undefined && mediaType !== 'application/json') {
          await reply.status(415).send(errorResponse('unsupported_media_type', 'Expected an application/json body.'));
        }
      },
      preHandler: authorizePreHandler(dependencies.policy, 'run_pull_request.refresh', (request) => ({
        kind: 'run_pull_request_refresh',
        id: (request.params as RunIdParams).id,
        path: runPullRequestRefreshPath
      })),
      errorHandler: async (error, request, reply) => {
        if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
          await reply.status(415).send(errorResponse('unsupported_media_type', 'Expected an application/json body.'));
          return;
        }
        if (error instanceof ZodError || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
            error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
            error.code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') {
          await sendValidationError(reply, undefined);
          return;
        }
        // Do not pass arbitrary provider, wiring, or parser exceptions to request logs.
        logServerFault(request, 500, undefined, 'internal_error');
        await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
      }
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      if (principal.kind === 'model') {
        await reply.status(403).send(errorResponse(forbiddenErrorCode, 'Forbidden.'));
        return;
      }
      const { id } = runIdParamsSchema.parse(request.params);
      runPullRequestRefreshRequestSchema.parse(request.body);
      let result;
      try {
        result = await dependencies.controlPlane.refreshRunPullRequest({ principal, runId: id });
      } catch (error) {
        if (error instanceof ControlPlaneServiceError && error.code !== 'persistence_failed') {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        // Wrap even a Zod error raised by local wiring; it is not invalid caller input.
        throw new Error('Failed to refresh run pull request.');
      }
      const parsed = runPullRequestRefreshResponseSchema.safeParse(result);
      if (!parsed.success) throw new Error('Invalid refresh response.');
      await reply.status(refreshRunPullRequestSuccessStatusCode).send(parsed.data);
    });
  });

  // PROTECTED: All /v1 routes
  await app.register(async (protectedApp) => {
    await registerBearerAuthHook(protectedApp, dependencies.auth);

    protectedApp.post(probeResourceCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'probe_resource.create', () => ({
        kind: 'probe_resource_collection',
        path: '/v1/probe-resources'
      }))
    }, async (request, reply) => {
      let body: CreateProbeResourceRequest;
      try {
        body = parseBody(request);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const resource = probeResourceSchema.parse(
        await createProbeResource(dependencies.probeResources, body)
      );
      await reply.status(createProbeResourceSuccessStatusCode).send(resource);
    });

    protectedApp.get(`${probeResourceCollectionPath}/:id`, {
      preHandler: authorizePreHandler(dependencies.policy, 'probe_resource.read', (request) => ({
        kind: 'probe_resource',
        id: probeResourceIdParamsSchema.parse(request.params).id,
        path: '/v1/probe-resources/:id'
      }))
    }, async (request, reply) => {
      let params: ProbeResourceIdParams;
      try {
        params = parseParams(request);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const resource = await getProbeResource(dependencies.probeResources, params.id);
      if (resource === null) {
        await reply.status(404).send(errorResponse(notFoundErrorCode, 'Probe resource not found.'));
        return;
      }
      await reply.status(200).send(probeResourceSchema.parse(resource));
    });

    protectedApp.get(eventsStreamPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'events.stream', () => ({
        kind: 'event_stream',
        path: '/v1/events'
      }))
    }, async (request, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });
      reply.raw.write(': connected\n\n');
      await new Promise<void>((resolve) => {
        request.raw.on('close', resolve);
      });
      reply.raw.end();
      return reply;
    });

    // Task 11: Principal diagnostic
    protectedApp.get(principalDiagnosticPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'principal.diagnostic.read', () => ({
        kind: 'principal_diagnostic' as const,
        path: '' as const
      }))
    }, async (request, reply) => {
      await reply.status(200).send(principalDiagnosticResponseSchema.parse({
        principal: requirePrincipalFromRequest(request)
      }));
    });

    // Task 12: Configuration record CRUD
    protectedApp.post(configurationRecordCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'configuration_record.create', () => ({
        kind: 'configuration_record_collection' as const,
        path: '/v1/configuration-records' as const
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      let body: CreateConfigurationRecordRequest;
      try {
        const submitted = request.body as { kind?: unknown; tenant?: unknown } | null;
        body = createConfigurationRecordRequestSchema.parse(
          submitted?.kind === 'model_rate_table' ? request.body : { ...submitted, tenant: principal.tenantId }
        );
        if (body.tenant !== principal.tenantId) {
          await reply.status(400).send(errorResponse('validation_error', 'Tenant does not match request scope.'));
          return;
        }
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      if (body.kind === 'model_routing_table') {
        const existingRecords = await dependencies.configurationRecords.list(principal.tenantId);
        const candidate = {
          id: 'new',
          tenant: principal.tenantId,
          kind: body.kind,
          settings: body.settings,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as ConfigurationRecord;
        try {
          assertActiveRoutesReferenceDispatchableProfiles(existingRecords, candidate, dependencies.providerCredentialRequired);
        } catch (error) {
          await reply.status(422).send(errorResponse(error instanceof Error ? error.message : 'validation_failed', 'Routing table references an incomplete or missing profile.'));
          return;
        }
      }
      try {
        const record = configurationRecordResponseSchema.parse(
          await createConfigurationRecord(dependencies.configurationRecords, body)
        );
        await reply.status(createConfigurationRecordSuccessStatusCode).send(record);
      } catch (error) {
        if (!(error instanceof ModelRateConflictError)) throw error;
        await reply.status(409).send(errorResponse('conflict', error.message));
      }
    });

    protectedApp.get(configurationRecordCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'configuration_record.list', () => ({
        kind: 'configuration_record_collection' as const,
        path: '/v1/configuration-records' as const
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      await reply.status(200).send(configurationRecordListResponseSchema.parse({
        records: await listConfigurationRecords(dependencies.configurationRecords, principal.tenantId)
      }));
    });

    protectedApp.get(`${configurationRecordCollectionPath}/:id`, {
      preHandler: authorizePreHandler(dependencies.policy, 'configuration_record.read', (request) => ({
        kind: 'configuration_record' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/configuration-records/:id' as const
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      let params: ConfigurationRecordIdParams;
      try {
        params = configurationRecordIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const record = await getConfigurationRecord(dependencies.configurationRecords, principal.tenantId, params.id);
      if (record === null) {
        await reply.status(404).send(errorResponse(notFoundErrorCode, 'Configuration record not found.'));
        return;
      }
      await reply.status(200).send(configurationRecordResponseSchema.parse(record));
    });

    protectedApp.patch(`${configurationRecordCollectionPath}/:id`, {
      preHandler: authorizePreHandler(dependencies.policy, 'configuration_record.update', (request) => ({
        kind: 'configuration_record' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/configuration-records/:id' as const
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      let params: ConfigurationRecordIdParams;
      let body: UpdateConfigurationRecordRequest;
      try {
        params = configurationRecordIdParamsSchema.parse(request.params);
        body = updateConfigurationRecordRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const existing = await dependencies.configurationRecords.findById(principal.tenantId, params.id);
      if (existing === null) {
        await reply.status(404).send(errorResponse(notFoundErrorCode, 'Configuration record not found.'));
        return;
      }
      if (existing.kind === 'model_rate_table') {
        await reply.status(409).send(errorResponse('conflict', new ModelRateConflictError().message));
        return;
      }
      if (body.kind === 'model_routing_table') {
        const existingRecords = await dependencies.configurationRecords.list(principal.tenantId);
        const mergedSettings = existing !== null
          ? { ...(existing.settings as object), ...(body.settings as object) }
          : body.settings;
        const candidate = {
          id: params.id,
          tenant: principal.tenantId,
          kind: body.kind,
          settings: mergedSettings,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as ConfigurationRecord;
        const otherRecords = existingRecords.filter((r) => r.id !== params.id);
        try {
          assertActiveRoutesReferenceDispatchableProfiles(otherRecords, candidate, dependencies.providerCredentialRequired);
        } catch (error) {
          await reply.status(422).send(errorResponse(error instanceof Error ? error.message : 'validation_failed', 'Routing table references an incomplete or missing profile.'));
          return;
        }
      } else if (body.kind === 'provider_profile') {
        const existingRecords = await dependencies.configurationRecords.list(principal.tenantId);
        const existingSettings = existing?.kind === 'provider_profile' ? (existing.settings as Record<string, unknown>) : {};
        const mergedSettings = { ...existingSettings, ...(body.settings as Record<string, unknown>) };
        const otherRecords = existingRecords.filter((r) => r.id !== params.id);
        try {
          const mergedProfile = existing?.kind === 'provider_profile'
            ? { ...existing, ...body, settings: mergedSettings } as ConfigurationRecord : existing;
          assertProviderProfileUpdateDoesNotBreakActiveRoutes(otherRecords, params.id, mergedSettings,
            mergedProfile === null ? true : dependencies.providerCredentialRequired?.(mergedProfile) ?? true);
        } catch (error) {
          await reply.status(422).send(errorResponse(error instanceof Error ? error.message : 'validation_failed', 'Clearing dispatch-required fields while an active routing table references this profile is not allowed.'));
          return;
        }
      }
      const updated = await updateConfigurationRecord(dependencies.configurationRecords, principal.tenantId, params.id, body);
      if (updated === null) {
        await reply.status(404).send(errorResponse(notFoundErrorCode, 'Configuration record not found.'));
        return;
      }
      await reply.status(200).send(configurationRecordResponseSchema.parse(updated));
    });

    protectedApp.delete(`${configurationRecordCollectionPath}/:id`, {
      preHandler: authorizePreHandler(dependencies.policy, 'configuration_record.delete', (request) => ({
        kind: 'configuration_record' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/configuration-records/:id' as const
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      let params: ConfigurationRecordIdParams;
      try {
        params = configurationRecordIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      let deleted: boolean;
      try {
        const existing = await dependencies.configurationRecords.findById(principal.tenantId, params.id);
        if (existing?.kind === 'model_rate_table') throw new ModelRateConflictError();
        deleted = await deleteConfigurationRecord(dependencies.configurationRecords, principal.tenantId, params.id);
      } catch (error) {
        if (!(error instanceof ModelRateConflictError)) throw error;
        await reply.status(409).send(errorResponse('conflict', error.message));
        return;
      }
      if (!deleted) {
        await reply.status(404).send(errorResponse(notFoundErrorCode, 'Configuration record not found.'));
        return;
      }
      await reply.status(deleteConfigurationRecordSuccessStatusCode).send();
    });

    // Task 13: Create secret
    protectedApp.post(secretCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'secret.create', () => ({
        kind: 'secret_collection' as const,
        path: '/v1/secrets' as const
      }))
    }, async (request, reply) => {
      let body: CreateSecretRequest;
      try {
        body = createSecretRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      try {
        const result = createSecretResponseSchema.parse(
          await createSecret(dependencies.secrets, body)
        );
        await reply.status(createSecretSuccessStatusCode).send(result);
      } catch (error) {
        if (error instanceof SecretStoreLockedError) {
          await reply.status(400).send(errorResponse(secretStoreLockedErrorCode, 'Secret store is locked.'));
          return;
        }
        throw error;
      }
    });

    // Project management API: POST /v1/projects
    protectedApp.post(projectCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'project.create', () => ({
        kind: 'project_collection' as const,
        path: '/v1/projects' as const
      }))
    }, async (request, reply) => {
      let body: CreateProjectRequest;
      try {
        body = createProjectRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const project = await createProject(dependencies.projects, dependencies.secrets, { principal, request: body });
        await reply.status(createProjectSuccessStatusCode).send(projectResponseSchema.parse(project));
      } catch (error) {
        if (error instanceof ProjectServiceError) {
          await handleProjectServiceError(reply, error);
          return;
        }
        throw error;
      }
    });

    // Project management API: GET /v1/projects
    protectedApp.get(projectCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'project.list', () => ({
        kind: 'project_collection' as const,
        path: '/v1/projects' as const
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      const projects = await listProjects(dependencies.projects, { principal });
      await reply.status(listProjectsSuccessStatusCode).send(projectListResponseSchema.parse({ projects }));
    });

    // Project management API: GET /v1/projects/:id
    protectedApp.get(`${projectCollectionPath}/:id`, {
      preHandler: authorizePreHandler(dependencies.policy, 'project.read', (request) => ({
        kind: 'project' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/projects/:id' as const
      }))
    }, async (request, reply) => {
      let params: ProjectIdParams;
      try {
        params = projectIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      const project = await getProject(dependencies.projects, { principal, id: params.id });
      if (project === null) {
        await reply.status(404).send(errorResponse(notFoundErrorCode, 'Project not found.'));
        return;
      }
      await reply.status(getProjectSuccessStatusCode).send(projectResponseSchema.parse(project));
    });

    protectedApp.get(projectIssuePath, {
      preHandler: authorizePreHandler(dependencies.policy, 'project_issue.read', (request) => {
        const { id, number } = request.params as { id: string; number: string };
        return { kind: 'project_issue', id, issueNumber: number, path: projectIssuePath };
      }),
      errorHandler: async (_error, request, reply) => {
        logServerFault(request, 500, undefined, 'internal_error');
        await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
      }
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      if (principal.kind === 'model') {
        await reply.status(403).send(errorResponse(forbiddenErrorCode, 'Forbidden.'));
        return;
      }
      const params = projectIssueParamsSchema.safeParse(request.params);
      if (!params.success) {
        await sendValidationError(reply, params.error);
        return;
      }
      try {
        const result = await dependencies.controlPlane.lookupProjectIssue({
          principal,
          projectId: params.data.id,
          issueNumber: params.data.number
        });
        await reply.status(lookupProjectIssueSuccessStatusCode).send(projectIssueLookupResponseSchema.parse(result));
      } catch (error) {
        if (!(error instanceof ControlPlaneServiceError)) throw error;
        if (error.code === 'not_found') {
          await reply.status(404).send(projectIssueNotFoundResponseSchema.parse({
            error: { code: notFoundErrorCode, message: error.message, details: error.details }
          }));
        } else {
          await handleControlPlaneServiceError(request, reply, error);
        }
      }
    });

    // Project management API: PATCH /v1/projects/:id
    protectedApp.patch(`${projectCollectionPath}/:id`, {
      preHandler: authorizePreHandler(dependencies.policy, 'project.update', (request) => ({
        kind: 'project' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/projects/:id' as const
      }))
    }, async (request, reply) => {
      let params: ProjectIdParams;
      let body: UpdateProjectRequest;
      try {
        params = projectIdParamsSchema.parse(request.params);
        body = updateProjectRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const project = await updateProject(dependencies.projects, dependencies.secrets, { principal, id: params.id, request: body });
        if (project === null) {
          await reply.status(404).send(errorResponse(notFoundErrorCode, 'Project not found.'));
          return;
        }
        await reply.status(updateProjectSuccessStatusCode).send(projectResponseSchema.parse(project));
      } catch (error) {
        if (error instanceof ProjectServiceError) {
          await handleProjectServiceError(reply, error);
          return;
        }
        throw error;
      }
    });

    // Story 7: Conversation ingress
    protectedApp.post(conversationCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'conversation.create', () => ({
        kind: 'conversation_collection' as const,
        path: '/v1/conversations' as const
      }))
    }, async (request, reply) => {
      let body: CreateConversationWithFirstRunRequest;
      try {
        body = createConversationWithFirstRunRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.createConversationWithFirstRun({
          principal,
          tenant: principal.tenantId,
          request: body
        });
        await reply.status(createConversationSuccessStatusCode).send(result);
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Story 8: List runs (filter + cursor paging)
    protectedApp.get(runCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run.list', () => ({
        kind: 'run_collection' as const,
        path: '/v1/runs' as const
      }))
    }, async (request, reply) => {
      // Strict query parsing: unknown fields, repeated keys (arrays), empty comma items, invalid
      // enum values, and bad limits all surface as 400 here.
      let query: z.infer<typeof listRunsQuerySchema>;
      try {
        query = listRunsQuerySchema.parse(request.query);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }

      // Opaque cursor → ordered-position. Malformed cursors are validation errors, not 500s.
      let cursor: RunListCursor | undefined;
      if (query.cursor !== undefined) {
        try {
          cursor = decodeRunListCursor(query.cursor);
        } catch (error) {
          await sendValidationError(reply, error);
          return;
        }
      }

      const filters: ListRunsByTenantFilters = {
        ...(query.archived !== undefined ? { archived: query.archived } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.waitingOn !== undefined ? { waitingOn: query.waitingOn } : {}),
        ...(query.workKind !== undefined ? { workKind: query.workKind } : {}),
        ...(query.projectId !== undefined ? { projectId: query.projectId } : {})
      };
      const hasFilters = Object.keys(filters).length > 0;

      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.listRuns({
          principal,
          // Tenant always comes from the authenticated principal, never from query input.
          tenant: principal.tenantId,
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(hasFilters ? { filters } : {})
        });
        await reply.status(listRunsSuccessStatusCode).send(
          runListResponseSchema.parse({
            runs: result.runs,
            ...(result.nextCursor !== undefined ? { nextCursor: encodeRunListCursor(result.nextCursor) } : {})
          })
        );
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Spec review: GET /v1/runs/:id/spec
    protectedApp.get(runSpecPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_spec.read', (request) => ({
        kind: 'run_spec' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/spec' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.getRunSpec({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
        await reply.status(getRunSpecSuccessStatusCode).send(runSpecResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // GET /v1/runs/:id/testing-guide
    protectedApp.get(runTestingGuidePath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_testing_guide.read', (request) => ({
        kind: 'run_testing_guide' as const,
        id: (request.params as { id: string }).id,
        path: runTestingGuidePath
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.getRunTestingGuide({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
        await reply.status(200).send(testingGuideSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    for (const operation of [
      { method: 'GET', action: 'run_testing_guide_results.read', resource: { kind: 'run_testing_guide_results', path: runTestingGuideResultsPath } },
      { method: 'PUT', action: 'run_testing_guide_results.write', resource: { kind: 'run_testing_guide_results', path: runTestingGuideResultsPath } },
      { method: 'GET', action: 'run_test_results.list', resource: { kind: 'run_test_results', path: runTestResultsPath } }
    ] as const) {
      protectedApp.route({
        method: operation.method,
        url: operation.resource.path,
        preHandler: authorizePreHandler(dependencies.policy, operation.action, (request) => ({
          ...operation.resource, id: (request.params as { id: string }).id
        })),
        handler: async (request, reply) => {
          let params: RunIdParams;
          let body: SaveTestingGuideResultsRequest | undefined;
          try {
            params = runIdParamsSchema.parse(request.params);
            if (operation.method === 'PUT') body = saveTestingGuideResultsRequestSchema.parse(request.body);
          } catch (error) {
            await sendValidationError(reply, error);
            return;
          }
          const principal = requirePrincipalFromRequest(request);
          const scope = { principal, tenant: principal.tenantId, runId: params.id };
          try {
            if (operation.resource.path === runTestResultsPath) {
              const result = await dependencies.controlPlane.listRunTestResults(scope);
              await reply.status(200).send(runTestResultsResponseSchema.parse(result));
            } else {
              const result = body === undefined
                ? await dependencies.controlPlane.getTestingGuideResults(scope)
                : await dependencies.controlPlane.saveTestingGuideResults({ ...scope, request: body });
              await reply.status(200).send(testingGuideResultsSchema.parse(result));
            }
          } catch (error) {
            if (!(error instanceof ControlPlaneServiceError)) throw error;
            await handleControlPlaneServiceError(request, reply, error);
          }
        }
      });
    }

    // Review feedback: POST /v1/runs/:id/feedback
    protectedApp.post(runFeedbackPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_feedback.create', (request) => ({
        kind: 'run_feedback' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/feedback' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      let body: CreateRunFeedbackRequest;
      try {
        params = runIdParamsSchema.parse(request.params);
        body = createRunFeedbackRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const feedback = await dependencies.controlPlane.createRunFeedback({
          principal,
          tenant: principal.tenantId,
          runId: params.id,
          request: body
        });
        await reply.status(createRunFeedbackSuccessStatusCode).send(feedbackSchema.parse(feedback));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Spec review: GET /v1/runs/:id/feedback
    protectedApp.get(runFeedbackPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_feedback.list', (request) => ({
        kind: 'run_feedback' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/feedback' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.listRunFeedback({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
        await reply.status(listRunFeedbackSuccessStatusCode).send(runFeedbackListResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Review feedback: POST /v1/runs/:id/feedback/:feedbackId/thread
    protectedApp.post(runFeedbackThreadPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_feedback.thread.append', (request) => ({
        kind: 'run_feedback_thread' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/feedback/:feedbackId/thread' as const
      }))
    }, async (request, reply) => {
      let params: z.infer<typeof runFeedbackThreadParamsSchema>;
      let body: AppendRunFeedbackThreadRequest;
      try {
        params = runFeedbackThreadParamsSchema.parse(request.params);
        body = appendRunFeedbackThreadRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const feedback = await dependencies.controlPlane.appendRunFeedbackThreadReply({
          principal,
          tenant: principal.tenantId,
          runId: params.id,
          feedbackId: params.feedbackId,
          body: body.body
        });
        await reply.status(appendRunFeedbackThreadSuccessStatusCode).send(feedbackResponseSchema.parse(feedback));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Spec review: PATCH /v1/runs/:id/feedback/:feedbackId (resolve / reopen)
    protectedApp.patch(updateRunFeedbackPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_feedback.update', (request) => ({
        kind: 'run_feedback_item' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/feedback/:feedbackId' as const
      }))
    }, async (request, reply) => {
      let params: z.infer<typeof updateRunFeedbackParamsSchema>;
      let body: UpdateRunFeedbackRequest;
      try {
        params = updateRunFeedbackParamsSchema.parse(request.params);
        body = updateRunFeedbackRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const feedback = await dependencies.controlPlane.updateRunFeedback({
          principal,
          tenant: principal.tenantId,
          runId: params.id,
          feedbackId: params.feedbackId,
          request: body
        });
        await reply.status(updateRunFeedbackSuccessStatusCode).send(feedbackResponseSchema.parse(feedback));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Resume paused run: POST /v1/runs/:id/replies
    protectedApp.post(runRepliesPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_replies.create', (request) => ({
        kind: 'run_replies' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/replies' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      let body: RunReplyRequest;
      try {
        params = runIdParamsSchema.parse(request.params);
        body = runReplyRequestSchema.parse(request.body);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.replyToRun({
          principal,
          tenant: principal.tenantId,
          runId: params.id,
          request: body
        });
        await reply.status(createRunReplySuccessStatusCode).send(runReplyResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    function registerRunAction<Body>(
      name: keyof typeof runOperatorPolicy,
      method: 'POST' | 'PATCH',
      schema: z.ZodType<Body>,
      optional: boolean,
      perform: (input: ServiceRunActionInput, body: Body) => Promise<RunActionResponse>
    ) {
      const { action, ...descriptor } = runOperatorPolicy[name];
      protectedApp.route({
        method, url: descriptor.path,
        preHandler: authorizePreHandler(dependencies.policy, action, (request) => ({
          ...descriptor, id: (request.params as { id: string }).id
        })),
        async handler(request, reply) {
          try {
            const principal = requireNonModelPrincipal(requirePrincipalFromRequest(request),
              'Model principals cannot perform run operator actions.');
            let params: RunIdParams;
            let body: Body;
            try {
              params = runIdParamsSchema.parse(request.params);
              body = schema.parse(optional && request.body === undefined ? {} : request.body);
            } catch (error) {
              await sendValidationError(reply, error);
              return;
            }
            const result = await perform({ principal, runId: params.id }, body);
            await reply.status(200).send(runActionResponseSchema.parse(result));
          } catch (error) {
            if (!(error instanceof ControlPlaneServiceError)) throw error;
            await handleControlPlaneServiceError(request, reply, error);
          }
        }
      });
    }

    registerRunAction('cancelRun', 'POST', emptyRunActionRequestSchema, true, (input) => dependencies.controlPlane.cancelRun(input));
    registerRunAction('archiveRun', 'POST', emptyRunActionRequestSchema, true, (input) => dependencies.controlPlane.archiveRun(input));
    registerRunAction('unarchiveRun', 'POST', emptyRunActionRequestSchema, true, (input) => dependencies.controlPlane.unarchiveRun(input));
    registerRunAction('setRunStep', 'POST', setRunStepRequestSchema, false, (input, request) => dependencies.controlPlane.setRunStep({ ...input, request }));
    registerRunAction('renameRun', 'PATCH', renameRunRequestSchema, false, (input, request) => dependencies.controlPlane.renameRun({ ...input, request }));

    // Recover a failed run: POST /v1/runs/:id/recover
    protectedApp.post(runRecoveryPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_recovery.create', (request) => ({
        kind: 'run_recovery' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/recover' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      let body: RunRecoveryRequest;
      try {
        params = runIdParamsSchema.parse(request.params);
        // A missing or empty body is treated as `{}` (apply the recovery policy).
        body = runRecoveryRequestSchema.parse(request.body ?? {});
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.recoverRun({
          principal,
          tenant: principal.tenantId,
          runId: params.id,
          request: body
        });
        await reply.status(recoverRunSuccessStatusCode).send(runRecoveryResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // PR reconciliation: POST /v1/pull-requests/reconcile
    protectedApp.post(pullRequestReconciliationPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'pull_request.reconcile', () => ({
        kind: 'pull_request_reconciliation' as const,
        path: pullRequestReconciliationPath
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      if (principal.kind === 'model') {
        await reply.status(403).send(errorResponse(forbiddenErrorCode, 'Forbidden.'));
        return;
      }
      try {
        const result: ReconcilePullRequestsResponse = await dependencies.controlPlane.reconcilePullRequests({ principal, tenant: principal.tenantId });
        await reply.status(reconcilePullRequestsSuccessStatusCode).send(pullRequestReconciliationResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Run observability: GET /v1/runs/:id/pull-request
    protectedApp.get(runPullRequestPath, {
      preHandler: authorizePreHandler(dependencies.policy, runPullRequestReadPolicyAction, (request) => ({
        kind: runPullRequestPolicyResourceKind,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/pull-request' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result: RunPullRequestResponse = await dependencies.controlPlane.getRunPullRequest({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
        await reply.status(getRunPullRequestSuccessStatusCode).send(runPullRequestResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Run observability: GET /v1/runs/:id/sessions
    protectedApp.get(runSessionsPath, {
      preHandler: authorizePreHandler(dependencies.policy, runSessionsListPolicyAction, (request) => ({
        kind: runSessionsPolicyResourceKind,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/sessions' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result: RunSessionListResponse = await dependencies.controlPlane.listRunSessions({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
        await reply.status(listRunSessionsSuccessStatusCode).send(runSessionListResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Story 7: Get run
    protectedApp.get(`${runCollectionPath}/:id`, {
      preHandler: authorizePreHandler(dependencies.policy, 'run.read', (request) => ({
        kind: 'run' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.getRun({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
        await reply.status(getRunSuccessStatusCode).send(result.run);
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    protectedApp.get(runWorkflowPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_workflow.read', (request) => ({
        kind: 'run_workflow',
        id: (request.params as RunIdParams).id,
        path: runWorkflowPath
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }

      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.getRunWorkflow({ principal, runId: params.id });
        const parsed = runWorkflowResponseSchema.safeParse(result);
        if (!parsed.success) {
          throw new ControlPlaneServiceError('persistence_failed', 'Invalid run workflow response.');
        }
        await reply.status(getRunWorkflowSuccessStatusCode).send(parsed.data);
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    // Story 7: List run steps
    protectedApp.get(runStepsPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_steps.list', (request) => ({
        kind: 'run_steps' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/steps' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.listRunSteps({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
        await reply.status(listRunStepsSuccessStatusCode).send(
          runStepListResponseSchema.parse({ steps: result.steps })
        );
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }
    });

    const runEventsQuerySchema = z.object({
      replay: z.enum(['retained']).optional()
    }).strict();

    // Story 7: Stream run events (SSE)
    protectedApp.get(runEventsPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run_events.stream', (request) => ({
        kind: 'run_events' as const,
        id: (request.params as { id: string }).id,
        path: '/v1/runs/:id/events' as const
      }))
    }, async (request, reply) => {
      let params: RunIdParams;
      try {
        params = runIdParamsSchema.parse(request.params);
      } catch (error) {
        await sendValidationError(reply, error);
        return;
      }
      const principal = requirePrincipalFromRequest(request);
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastEventId = typeof lastEventIdHeader === 'string' ? lastEventIdHeader : undefined;

      let runEventsQuery: z.infer<typeof runEventsQuerySchema>;
      try {
        runEventsQuery = runEventsQuerySchema.parse(request.query);
      } catch {
        await reply.status(400).send({ error: { code: 'invalid_query', message: 'Invalid query parameters.' } });
        return;
      }

      // Subscribe FIRST to avoid losing events emitted while replay is computed.
      let subscription: RunEventSubscription;
      try {
        subscription = await dependencies.controlPlane.subscribeRunEvents({
          principal,
          tenant: principal.tenantId,
          runId: params.id
        });
      } catch (error) {
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }

      // Then compute replay.
      let replay;
      try {
        replay = await dependencies.controlPlane.replayRunEvents({
          principal,
          tenant: principal.tenantId,
          runId: params.id,
          ...(lastEventId !== undefined ? { lastEventId } : {}),
          ...(runEventsQuery.replay === 'retained' ? { replay: 'retained' as const } : {})
        });
      } catch (error) {
        subscription.close();
        if (error instanceof ControlPlaneServiceError) {
          await handleControlPlaneServiceError(request, reply, error);
          return;
        }
        throw error;
      }

      if (replay.status === 'unknown_event_id' || replay.status === 'expired_event_id') {
        // Close subscription and return 409 BEFORE any SSE bytes.
        subscription.close();
        const code = replay.status === 'unknown_event_id'
          ? 'run_event_replay_cursor_unknown'
          : 'run_event_replay_cursor_expired';
        await reply.status(409).send({
          error: {
            code,
            message: `Run event replay cursor '${replay.lastEventId}' is not available.`,
            lastEventId: replay.lastEventId
          }
        });
        return;
      }

      reply.raw.writeHead(runEventsSuccessStatusCode, {
        'content-type': `${runEventsMediaType}; charset=utf-8`,
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });
      reply.raw.write(': connected\n\n');

      request.raw.on('close', () => {
        subscription.close();
      });

      const writeFrame = (event: unknown) => {
        const validated = clientRunEventSchema.parse(event);
        reply.raw.write(`event: ${formatRunEventFrameName(validated)}\n`);
        reply.raw.write(`id: ${validated.id}\n`);
        reply.raw.write(`data: ${JSON.stringify(validated)}\n\n`);
      };

      try {
        // Replay ids that may also appear in the live buffer (events appended in the
        // subscribe→replayAfter window). Pre-existing events are only in replay, not
        // in the live buffer, so a linear scan waiting for the last replay id would
        // skip all subsequent live events if it never appears.
        const replayedIds = new Set(replay.events.map(e => e.id));
        for (const event of replay.events) {
          writeFrame(event);
        }
        for await (const event of subscription.events) {
          if (replayedIds.has(event.id)) {
            continue; // already delivered in replay
          }
          writeFrame(event);
        }
      } finally {
        subscription.close();
        reply.raw.end();
      }

      return reply;
    });
  });
}
