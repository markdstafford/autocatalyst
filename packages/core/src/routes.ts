import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  degradedHealthStatusCode,
  errorResponseSchema,
  eventsStreamPath,
  healthResponseSchema,
  notFoundErrorCode,
  probeResourceCollectionPath,
  probeResourceIdParamsSchema,
  probeResourceSchema,
  type CreateProbeResourceRequest,
  type ErrorResponse,
  type ProbeResourceIdParams
} from '@autocatalyst/api-contract';

import { registerBearerAuthHook, type BearerAuthOptions } from './auth.js';
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
import type { ConfigurationRecordRepository } from './configuration-record.js';
import type { SecretStore } from './secret.js';

export interface ControlPlaneRouteDependencies {
  readonly health: HealthDependencyChecker;
  readonly auth: BearerAuthOptions;
  readonly policy: PolicyDecisionPoint;
  readonly probeResources: ProbeResourceRepository;
  readonly configurationRecords: ConfigurationRecordRepository;
  readonly secrets: SecretStore;
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
  });

  app.setErrorHandler(async (error, _request, reply) => {
    await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
  });
}
