import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import {
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  degradedHealthStatusCode,
  errorResponseSchema,
  eventsStreamPath,
  healthResponseSchema,
  probeResourceCollectionPath,
  probeResourceIdParamsSchema,
  probeResourceSchema,
  type CreateProbeResourceRequest,
  type ErrorResponse,
  type ProbeResourceIdParams
} from '@autocatalyst/api-contract';

import { getHealth, type HealthDependencyChecker } from './health.js';
import {
  createProbeResource,
  getProbeResource,
  type ProbeResourceRepository
} from './probe-resource.js';
import type { BearerAuthOptions } from './auth.js';
import type { PolicyDecisionPoint } from './policy.js';
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

export async function registerControlPlaneRoutes(
  app: FastifyInstance,
  dependencies: ControlPlaneRouteDependencies
): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const health = healthResponseSchema.parse(await getHealth(dependencies.health));
    const statusCode = health.status === 'ok' ? 200 : degradedHealthStatusCode;
    await reply.status(statusCode).send(health);
  });

  app.post(probeResourceCollectionPath, async (request, reply) => {
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

  app.get(`${probeResourceCollectionPath}/:id`, async (request, reply) => {
    let params: ProbeResourceIdParams;
    try {
      params = parseParams(request);
    } catch (error) {
      await sendValidationError(reply, error);
      return;
    }

    const resource = await getProbeResource(dependencies.probeResources, params.id);
    if (resource === null) {
      await reply.status(404).send(errorResponse('not_found', 'Probe resource not found.'));
      return;
    }

    await reply.status(200).send(probeResourceSchema.parse(resource));
  });

  app.get(eventsStreamPath, async (request, reply) => {
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

  app.setErrorHandler(async (error, _request, reply) => {
    await reply.status(500).send(errorResponse('internal_error', 'An internal server error occurred.'));
  });
}
