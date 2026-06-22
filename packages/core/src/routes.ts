import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import {
  activeRunConflictErrorCode,
  createRunReplySuccessStatusCode,
  runRepliesPath,
  runReplyRequestSchema,
  runReplyResponseSchema,
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
  forbiddenErrorCode,
  getRunPullRequestSuccessStatusCode,
  getRunSpecSuccessStatusCode,
  getRunSuccessStatusCode,
  listRunFeedbackSuccessStatusCode,
  listRunSessionsSuccessStatusCode,
  listRunsSuccessStatusCode,
  runListResponseSchema,
  healthResponseSchema,
  intakeRoutingErrorCode,
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
  runIdParamsSchema,
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
  updateConfigurationRecordRequestSchema,
  type AppendRunFeedbackThreadRequest,
  type ConfigurationRecord,
  type ConfigurationRecordIdParams,
  type CreateConfigurationRecordRequest,
  type CreateConversationWithFirstRunRequest,
  type CreateProbeResourceRequest,
  type CreateRunFeedbackRequest,
  type CreateSecretRequest,
  type ErrorResponse,
  type ProbeResourceIdParams,
  type ReconcilePullRequestsResponse,
  type RunIdParams,
  type RunPullRequestResponse,
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
  assertActiveRoutesReferenceDispatchableProfiles,
  assertProviderProfileUpdateDoesNotBreakActiveRoutes,
  createConfigurationRecord,
  deleteConfigurationRecord,
  getConfigurationRecord,
  listConfigurationRecords,
  updateConfigurationRecord,
  type ConfigurationRecordRepository
} from './configuration-record.js';
import { createSecret, SecretStoreLockedError, type SecretStore } from './secret.js';
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
  readonly secrets: SecretStore;
  readonly controlPlane: ControlPlaneService;
}

function routePattern(request: FastifyRequest): string {
  return (request.routeOptions as { url?: string } | undefined)?.url ?? (request as unknown as { routerPath?: string }).routerPath ?? request.url.split('?')[0] ?? 'unknown';
}

function safeStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined;
  return error.stack
    .replace(/\/Users\/[^\s)]+/gu, '[workspace-path]')
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
      await reply.status(400).send(errorResponse(intakeRoutingErrorCode, error.message, error.details));
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
    case 'unsupported_pause':
      await reply.status(409).send(errorResponse('unsupported_pause', error.message, error.details));
      return;
    case 'conflict':
      await reply.status(409).send(errorResponse('conflict', error.message, error.details));
      return;
    default:
      logServerFault(request, 500, error, error.code);
      await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
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
        body = createConfigurationRecordRequestSchema.parse({
          ...request.body as object,
          tenant: principal.tenantId
        });
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
          assertActiveRoutesReferenceDispatchableProfiles(existingRecords, candidate);
        } catch (error) {
          await reply.status(422).send(errorResponse(error instanceof Error ? error.message : 'validation_failed', 'Routing table references an incomplete or missing profile.'));
          return;
        }
      }
      const record = configurationRecordResponseSchema.parse(
        await createConfigurationRecord(dependencies.configurationRecords, body)
      );
      await reply.status(createConfigurationRecordSuccessStatusCode).send(record);
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
      if (body.kind === 'model_routing_table') {
        const existingRecords = await dependencies.configurationRecords.list(principal.tenantId);
        const existing = await dependencies.configurationRecords.findById(principal.tenantId, params.id);
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
          assertActiveRoutesReferenceDispatchableProfiles(otherRecords, candidate);
        } catch (error) {
          await reply.status(422).send(errorResponse(error instanceof Error ? error.message : 'validation_failed', 'Routing table references an incomplete or missing profile.'));
          return;
        }
      } else if (body.kind === 'provider_profile') {
        const existingRecords = await dependencies.configurationRecords.list(principal.tenantId);
        const existing = await dependencies.configurationRecords.findById(principal.tenantId, params.id);
        const existingSettings = existing?.kind === 'provider_profile' ? (existing.settings as Record<string, unknown>) : {};
        const mergedSettings = { ...existingSettings, ...(body.settings as Record<string, unknown>) };
        const otherRecords = existingRecords.filter((r) => r.id !== params.id);
        try {
          assertProviderProfileUpdateDoesNotBreakActiveRoutes(otherRecords, params.id, mergedSettings);
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
      const deleted = await deleteConfigurationRecord(dependencies.configurationRecords, principal.tenantId, params.id);
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

    // Story 8: List runs
    protectedApp.get(runCollectionPath, {
      preHandler: authorizePreHandler(dependencies.policy, 'run.list', () => ({
        kind: 'run_collection' as const,
        path: '/v1/runs' as const
      }))
    }, async (request, reply) => {
      const principal = requirePrincipalFromRequest(request);
      try {
        const result = await dependencies.controlPlane.listRuns({
          principal,
          tenant: principal.tenantId
        });
        await reply.status(listRunsSuccessStatusCode).send(
          runListResponseSchema.parse({ runs: result.runs })
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

    // Spec review: POST /v1/runs/:id/feedback
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

    // Spec review: POST /v1/runs/:id/feedback/:feedbackId/thread
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
        await reply.status(appendRunFeedbackThreadSuccessStatusCode).send(feedbackSchema.parse(feedback));
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
