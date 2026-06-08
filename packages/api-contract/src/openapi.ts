import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { errorResponseSchema } from './errors.js';
import { degradedHealthStatusCode, healthResponseSchema } from './health.js';
import {
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  probeResourceCollectionPath,
  probeResourceIdParamsSchema,
  probeResourceSchema
} from './probe-resource.js';
import { eventsStreamPath } from './sse.js';

extendZodWithOpenApi(z);

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components?: Record<string, unknown>;
}

function jsonResponse(schema: z.ZodTypeAny, description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema
      }
    }
  };
}

export function generateOpenApiDocument(): OpenApiDocument {
  const registry = new OpenAPIRegistry();

  const HealthResponse = registry.register('HealthResponse', healthResponseSchema);
  const ErrorResponse = registry.register('ErrorResponse', errorResponseSchema);
  const CreateProbeResourceRequest = registry.register(
    'CreateProbeResourceRequest',
    createProbeResourceRequestSchema
  );
  const ProbeResource = registry.register('ProbeResource', probeResourceSchema);
  const ProbeResourceIdParams = registry.register('ProbeResourceIdParams', probeResourceIdParamsSchema);

  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['operations'],
    responses: {
      200: jsonResponse(HealthResponse, 'The process is live and the database is reachable.'),
      [degradedHealthStatusCode]: jsonResponse(
        HealthResponse,
        'The process is live and the database is unreachable.'
      )
    }
  });

  registry.registerPath({
    method: 'post',
    path: probeResourceCollectionPath,
    tags: ['probe-resources'],
    request: {
      body: {
        content: {
          'application/json': {
            schema: CreateProbeResourceRequest
          }
        }
      }
    },
    responses: {
      [createProbeResourceSuccessStatusCode]: jsonResponse(ProbeResource, 'Created probe resource.'),
      400: jsonResponse(ErrorResponse, 'Validation error.')
    }
  });

  registry.registerPath({
    method: 'get',
    path: `${probeResourceCollectionPath}/{id}`,
    tags: ['probe-resources'],
    request: {
      params: ProbeResourceIdParams
    },
    responses: {
      200: jsonResponse(ProbeResource, 'Probe resource.'),
      404: jsonResponse(ErrorResponse, 'Probe resource not found.')
    }
  });

  registry.registerPath({
    method: 'get',
    path: eventsStreamPath,
    tags: ['events'],
    responses: {
      200: {
        description: 'SSE connection that stays open for future run events.',
        content: {
          'text/event-stream': {
            schema: { type: 'string' }
          }
        }
      }
    }
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Autocatalyst Control Plane API',
      version: '1.0.0'
    }
  }) as OpenApiDocument;
}
