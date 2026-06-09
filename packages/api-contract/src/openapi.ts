import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  configurationRecordCollectionPath,
  configurationRecordIdParamsSchema,
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createConfigurationRecordRequestSchema,
  createConfigurationRecordSuccessStatusCode,
  updateConfigurationRecordRequestSchema
} from './configuration-record.js';
import {
  conversationCollectionPath,
  createConversationSuccessStatusCode,
  createConversationWithFirstRunRequestSchema,
  createConversationWithFirstRunResponseSchema
} from './conversation-ingress.js';
import { errorResponseSchema } from './errors.js';
import { degradedHealthStatusCode, healthResponseSchema } from './health.js';
import { principalDiagnosticPath, principalDiagnosticResponseSchema } from './principal.js';
import {
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  probeResourceCollectionPath,
  probeResourceIdParamsSchema,
  probeResourceSchema
} from './probe-resource.js';
import {
  getRunSuccessStatusCode,
  runIdParamsSchema,
  runSchema
} from './run.js';
import {
  listRunStepsSuccessStatusCode,
  runStepListResponseSchema
} from './run-step.js';
import {
  createSecretRequestSchema,
  createSecretResponseSchema,
  createSecretSuccessStatusCode,
  secretCollectionPath
} from './secret.js';
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
  const PrincipalDiagnosticResponse = registry.register('PrincipalDiagnosticResponse', principalDiagnosticResponseSchema);
  const CreateConfigurationRecordRequest = registry.register('CreateConfigurationRecordRequest', createConfigurationRecordRequestSchema);
  const UpdateConfigurationRecordRequest = registry.register('UpdateConfigurationRecordRequest', updateConfigurationRecordRequestSchema);
  const ConfigurationRecord = registry.register('ConfigurationRecord', configurationRecordResponseSchema);
  const ConfigurationRecordListResponse = registry.register('ConfigurationRecordListResponse', configurationRecordListResponseSchema);
  const ConfigurationRecordIdParams = registry.register('ConfigurationRecordIdParams', configurationRecordIdParamsSchema);
  const CreateSecretRequest = registry.register('CreateSecretRequest', createSecretRequestSchema);
  const CreateSecretResponse = registry.register('CreateSecretResponse', createSecretResponseSchema);
  const CreateConversationWithFirstRunRequest = registry.register(
    'CreateConversationWithFirstRunRequest',
    createConversationWithFirstRunRequestSchema
  );
  const CreateConversationWithFirstRunResponse = registry.register(
    'CreateConversationWithFirstRunResponse',
    createConversationWithFirstRunResponseSchema
  );
  const Run = registry.register('Run', runSchema);
  const RunIdParams = registry.register('RunIdParams', runIdParamsSchema);
  const RunStepListResponse = registry.register('RunStepListResponse', runStepListResponseSchema);

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

  // GET /v1/principal
  registry.registerPath({
    method: 'get',
    path: principalDiagnosticPath,
    tags: ['principal'],
    responses: {
      200: jsonResponse(PrincipalDiagnosticResponse, 'Resolved principal.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.')
    }
  });

  // POST /v1/configuration-records
  registry.registerPath({
    method: 'post',
    path: configurationRecordCollectionPath,
    tags: ['configuration-records'],
    request: {
      body: { content: { 'application/json': { schema: CreateConfigurationRecordRequest } } }
    },
    responses: {
      [createConfigurationRecordSuccessStatusCode]: jsonResponse(ConfigurationRecord, 'Created configuration record.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      400: jsonResponse(ErrorResponse, 'Validation error.')
    }
  });

  // GET /v1/configuration-records
  registry.registerPath({
    method: 'get',
    path: configurationRecordCollectionPath,
    tags: ['configuration-records'],
    responses: {
      200: jsonResponse(ConfigurationRecordListResponse, 'List of configuration records.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.')
    }
  });

  // GET /v1/configuration-records/{id}
  registry.registerPath({
    method: 'get',
    path: `${configurationRecordCollectionPath}/{id}`,
    tags: ['configuration-records'],
    request: { params: ConfigurationRecordIdParams },
    responses: {
      200: jsonResponse(ConfigurationRecord, 'Configuration record.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      404: jsonResponse(ErrorResponse, 'Configuration record not found.')
    }
  });

  // PATCH /v1/configuration-records/{id}
  registry.registerPath({
    method: 'patch',
    path: `${configurationRecordCollectionPath}/{id}`,
    tags: ['configuration-records'],
    request: {
      params: ConfigurationRecordIdParams,
      body: { content: { 'application/json': { schema: UpdateConfigurationRecordRequest } } }
    },
    responses: {
      200: jsonResponse(ConfigurationRecord, 'Updated configuration record.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      400: jsonResponse(ErrorResponse, 'Validation error.'),
      404: jsonResponse(ErrorResponse, 'Configuration record not found.')
    }
  });

  // DELETE /v1/configuration-records/{id}
  registry.registerPath({
    method: 'delete',
    path: `${configurationRecordCollectionPath}/{id}`,
    tags: ['configuration-records'],
    request: { params: ConfigurationRecordIdParams },
    responses: {
      204: { description: 'Deleted configuration record.' },
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      404: jsonResponse(ErrorResponse, 'Configuration record not found.')
    }
  });

  // POST /v1/secrets
  registry.registerPath({
    method: 'post',
    path: secretCollectionPath,
    tags: ['secrets'],
    request: {
      body: { content: { 'application/json': { schema: CreateSecretRequest } } }
    },
    responses: {
      [createSecretSuccessStatusCode]: jsonResponse(CreateSecretResponse, 'Created secret handle.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      400: jsonResponse(ErrorResponse, 'Validation error or secret store locked.')
    }
  });

  // POST /v1/conversations
  registry.registerPath({
    method: 'post',
    path: conversationCollectionPath,
    tags: ['conversations'],
    request: {
      body: { content: { 'application/json': { schema: CreateConversationWithFirstRunRequest } } }
    },
    responses: {
      [createConversationSuccessStatusCode]: jsonResponse(CreateConversationWithFirstRunResponse, 'Created conversation with first run.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      400: jsonResponse(ErrorResponse, 'Validation error.'),
      409: jsonResponse(ErrorResponse, 'Conflict.')
    }
  });

  // GET /v1/runs/{id}
  registry.registerPath({
    method: 'get',
    path: '/v1/runs/{id}',
    tags: ['runs'],
    request: { params: RunIdParams },
    responses: {
      [getRunSuccessStatusCode]: jsonResponse(Run, 'Run.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      404: jsonResponse(ErrorResponse, 'Run not found.')
    }
  });

  // GET /v1/runs/{id}/steps
  registry.registerPath({
    method: 'get',
    path: '/v1/runs/{id}/steps',
    tags: ['runs'],
    request: { params: RunIdParams },
    responses: {
      [listRunStepsSuccessStatusCode]: jsonResponse(RunStepListResponse, 'List of run steps.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      404: jsonResponse(ErrorResponse, 'Run not found.')
    }
  });

  // GET /v1/runs/{id}/events (SSE)
  registry.registerPath({
    method: 'get',
    path: '/v1/runs/{id}/events',
    tags: ['runs'],
    request: { params: RunIdParams },
    responses: {
      200: {
        description: 'SSE stream of run state transition events.',
        content: {
          'text/event-stream': {
            schema: { type: 'string' }
          }
        }
      },
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      404: jsonResponse(ErrorResponse, 'Run not found.')
    }
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Autocatalyst Control Plane API',
      version: '1.0.0'
    }
  }) as unknown as OpenApiDocument;
}
