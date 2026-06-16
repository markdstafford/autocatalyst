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
  listRunsSuccessStatusCode,
  runCollectionPath,
  runIdParamsSchema,
  runListResponseSchema,
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
import {
  runSpecPath,
  runSpecResponseSchema,
  getRunSpecSuccessStatusCode
} from './run-spec.js';
import {
  runFeedbackPath,
  createRunFeedbackRequestSchema,
  runFeedbackListResponseSchema,
  createRunFeedbackSuccessStatusCode,
  listRunFeedbackSuccessStatusCode,
  feedbackSchema,
  runFeedbackThreadPath,
  appendRunFeedbackThreadRequestSchema,
  appendRunFeedbackThreadSuccessStatusCode,
  runFeedbackThreadParamsSchema
} from './feedback.js';
import {
  createRunReplySuccessStatusCode,
  runRepliesPath,
  runReplyRequestSchema,
  runReplyResponseSchema
} from './run-replies.js';

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
  const RunListResponse = registry.register('RunListResponse', runListResponseSchema);
  const RunIdParams = registry.register('RunIdParams', runIdParamsSchema);
  const RunStepListResponse = registry.register('RunStepListResponse', runStepListResponseSchema);
  const RunSpecResponse = registry.register('RunSpecResponse', runSpecResponseSchema);
  const CreateRunFeedbackRequest = registry.register('CreateRunFeedbackRequest', createRunFeedbackRequestSchema);
  const RunFeedbackListResponse = registry.register('RunFeedbackListResponse', runFeedbackListResponseSchema);
  const Feedback = registry.register('Feedback', feedbackSchema);
  const AppendRunFeedbackThreadRequest = registry.register('AppendRunFeedbackThreadRequest', appendRunFeedbackThreadRequestSchema);
  const RunFeedbackThreadParams = registry.register('RunFeedbackThreadParams', runFeedbackThreadParamsSchema);
  const RunReplyRequest = registry.register('RunReplyRequest', runReplyRequestSchema);
  const RunReplyResponse = registry.register('RunReplyResponse', runReplyResponseSchema);
  const RunReplyParams = registry.register('RunReplyParams', z.object({ id: z.string().min(1) }).strict());

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

  // GET /v1/runs
  registry.registerPath({
    method: 'get',
    path: runCollectionPath,
    tags: ['runs'],
    responses: {
      [listRunsSuccessStatusCode]: jsonResponse(RunListResponse, 'List of runs for the authenticated tenant.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      403: jsonResponse(ErrorResponse, 'Forbidden.')
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
    request: {
      params: RunIdParams,
      query: z.object({
        replay: z.enum(['retained']).optional().openapi({
          description: 'When set to "retained", replay all retained events for the run from the beginning before streaming live events. Omit to receive live events only (default).'
        })
      })
    },
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

  // GET /v1/runs/{id}/spec
  registry.registerPath({
    method: 'get',
    path: runSpecPath.replace(':id', '{id}') as '/v1/runs/{id}/spec',
    tags: ['runs'],
    request: { params: RunIdParams },
    responses: {
      [getRunSpecSuccessStatusCode]: jsonResponse(RunSpecResponse, 'Current spec for the run.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      404: jsonResponse(ErrorResponse, 'Run or spec not found.'),
      500: jsonResponse(ErrorResponse, 'Internal server error.')
    }
  });

  // POST /v1/runs/{id}/feedback
  registry.registerPath({
    method: 'post',
    path: runFeedbackPath.replace(':id', '{id}') as '/v1/runs/{id}/feedback',
    tags: ['runs'],
    request: {
      params: RunIdParams,
      body: { content: { 'application/json': { schema: CreateRunFeedbackRequest } } }
    },
    responses: {
      [createRunFeedbackSuccessStatusCode]: jsonResponse(Feedback, 'Created feedback item.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      400: jsonResponse(ErrorResponse, 'Validation error.'),
      404: jsonResponse(ErrorResponse, 'Run not found.')
    }
  });

  // GET /v1/runs/{id}/feedback
  registry.registerPath({
    method: 'get',
    path: runFeedbackPath.replace(':id', '{id}') as '/v1/runs/{id}/feedback',
    tags: ['runs'],
    request: { params: RunIdParams },
    responses: {
      [listRunFeedbackSuccessStatusCode]: jsonResponse(RunFeedbackListResponse, 'Feedback items for the run.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      404: jsonResponse(ErrorResponse, 'Run not found.')
    }
  });

  // POST /v1/runs/{id}/feedback/{feedbackId}/thread
  registry.registerPath({
    method: 'post',
    path: runFeedbackThreadPath.replace(':id', '{id}').replace(':feedbackId', '{feedbackId}') as '/v1/runs/{id}/feedback/{feedbackId}/thread',
    tags: ['runs'],
    request: {
      params: RunFeedbackThreadParams,
      body: { content: { 'application/json': { schema: AppendRunFeedbackThreadRequest } } }
    },
    responses: {
      [appendRunFeedbackThreadSuccessStatusCode]: jsonResponse(Feedback, 'Updated feedback item with appended thread reply.'),
      401: jsonResponse(ErrorResponse, 'Unauthorized.'),
      400: jsonResponse(ErrorResponse, 'Validation error.'),
      404: jsonResponse(ErrorResponse, 'Run or feedback item not found.')
    }
  });

  // POST /v1/runs/{id}/replies
  registry.registerPath({
    method: 'post',
    path: runRepliesPath.replace(':id', '{id}') as '/v1/runs/{id}/replies',
    tags: ['runs'],
    summary: 'Reply to a paused run',
    description: 'Accepts a structured human reply for supported human-waiting run steps.',
    request: {
      params: RunReplyParams,
      body: {
        content: {
          'application/json': {
            schema: RunReplyRequest
          }
        }
      }
    },
    responses: {
      [createRunReplySuccessStatusCode]: jsonResponse(RunReplyResponse, 'Reply accepted and run transition committed.'),
      400: jsonResponse(ErrorResponse, 'Malformed request or invalid reply for the supported pause.'),
      403: jsonResponse(ErrorResponse, 'Unauthorized principal or model principal.'),
      404: jsonResponse(ErrorResponse, 'Run not found.'),
      409: jsonResponse(ErrorResponse, 'Run is terminal, not waiting on a human, blocked by feedback, changed step, or unsupported pause.'),
      500: jsonResponse(ErrorResponse, 'Unexpected internal failure.')
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
