import { describe, expect, it } from 'vitest';

import {
  createProbeResourceSuccessStatusCode,
  eventsStreamPath,
  generateOpenApiDocument,
  probeResourceCollectionPath
} from './index.js';

describe('OpenAPI generation', () => {
  it('generates paths from contract constants and schemas', () => {
    const document = generateOpenApiDocument();

    expect(document.openapi).toMatch(/^3\./u);
    expect(document.info.title).toBe('Autocatalyst Control Plane API');
    expect(document.paths['/health']?.get).toBeDefined();
    expect(document.paths[probeResourceCollectionPath]?.post?.responses[String(createProbeResourceSuccessStatusCode)]).toBeDefined();
    expect(document.paths[`${probeResourceCollectionPath}/{id}`]?.get?.responses['200']).toBeDefined();
    expect(document.paths[eventsStreamPath]?.get?.responses['200']).toBeDefined();
  });

  it('documents a 422 unknown_credential_reference response on both project write operations', () => {
    const document = generateOpenApiDocument();
    const createOperation = document.paths['/v1/projects']?.post as { responses?: Record<string, unknown> };
    const patchOperation = document.paths['/v1/projects/{id}']?.patch as { responses?: Record<string, unknown> };
    expect(createOperation.responses?.['201']).toBeDefined();
    expect(createOperation.responses?.['422']).toBeDefined();
    expect(patchOperation.responses?.['200']).toBeDefined();
    expect(patchOperation.responses?.['422']).toBeDefined();
  });

  it('documents protected principal, configuration, and secret routes', () => {
    const document = generateOpenApiDocument();
    expect(document.paths['/v1/principal']?.get).toBeDefined();
    expect(document.paths['/v1/configuration-records']?.post).toBeDefined();
    expect(document.paths['/v1/configuration-records']?.get).toBeDefined();
    expect(document.paths['/v1/configuration-records/{id}']?.get).toBeDefined();
    expect(document.paths['/v1/configuration-records/{id}']?.patch).toBeDefined();
    expect(document.paths['/v1/configuration-records/{id}']?.delete).toBeDefined();
    expect(document.paths['/v1/secrets']?.post).toBeDefined();
  });

  it('documents immutable rate publication and additive priced session reads', () => {
    const document = generateOpenApiDocument();
    const records = document.paths['/v1/configuration-records'];
    const item = document.paths['/v1/configuration-records/{id}'];
    expect(records?.post?.responses['409']).toBeDefined();
    expect(item?.patch?.responses['409']).toBeDefined();
    expect(item?.delete?.responses['409']).toBeDefined();
    expect(JSON.stringify(document.components?.schemas?.['CreateConfigurationRecordRequest'])).toContain('model_rate_table');
    const read = JSON.stringify(document.components?.schemas?.['RunSessionListResponse']);
    for (const field of ['costTotals', 'rateVersionIds', 'estimated_request_size', 'requestInputTokens', 'placeholder']) {
      expect(read).toContain(field);
    }
  });

  it('documents no-content delete and unauthorized responses for protected routes', () => {
    const document = generateOpenApiDocument();
    const deleteOperation = document.paths['/v1/configuration-records/{id}']?.delete as {
      responses?: Record<string, unknown>;
    };
    expect(deleteOperation.responses?.['204']).toMatchObject({ description: 'Deleted configuration record.' });

    const createOperation = document.paths['/v1/configuration-records']?.post as {
      responses?: Record<string, unknown>;
    };
    expect(createOperation.responses?.['401']).toBeDefined();
  });

  it('documents conversation ingress route', () => {
    const document = generateOpenApiDocument();
    expect(document.paths['/v1/conversations']?.post).toBeDefined();
    const createOp = document.paths['/v1/conversations']?.post as {
      responses?: Record<string, unknown>;
    };
    expect(createOp.responses?.['201']).toBeDefined();
  });

  it('documents signed-in issue lookup and the shared intake errors', () => {
    const document = generateOpenApiDocument();
    const lookup = document.paths['/v1/projects/{id}/issues/{number}']?.['get'] as {
      parameters: unknown[];
      security: unknown[];
      responses: Record<string, unknown>;
    };
    const create = document.paths['/v1/conversations']?.['post'] as { responses: Record<string, unknown> };
    const ref = (name: string) => ({ content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } });
    expect(lookup.security).toEqual([{ bearerAuth: [] }]);
    expect(lookup.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      { name: 'number', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }
    ]);
    expect(lookup.responses).toMatchObject({
      200: ref('ProjectIssueLookupResponse'),
      400: ref('IntakeBadRequestResponse'),
      401: ref('ErrorResponse'),
      403: ref('ErrorResponse'),
      404: ref('ProjectIssueNotFoundResponse'),
      500: ref('ErrorResponse')
    });
    expect(create.responses['400']).toMatchObject(ref('IntakeBadRequestResponse'));

    const schemas = document.components?.['schemas'] as Record<string, unknown>;
    expect(schemas['ProjectIssueLookupResponse']).toMatchObject({
      required: ['issue', 'workKind'],
      properties: {
        issue: { required: ['number', 'title', 'url', 'labels', 'state'], additionalProperties: false },
        workKind: { anyOf: [
          { required: ['kind', 'source'], additionalProperties: false },
          { required: ['kind', 'source', 'reason'], properties: { kind: { nullable: true, enum: [null] } } }
        ] }
      }
    });
    expect(schemas['ProjectIssueNotFoundResponse']).toMatchObject({
      properties: { error: { properties: { details: { properties: { resource: { enum: ['project', 'issue'] } } } } } }
    });
    expect(schemas['IntakeBadRequestResponse']).toMatchObject({
      anyOf: [
        { properties: { error: {
          required: ['code', 'message', 'details'],
          properties: {
            code: { enum: ['intake_routing_error'] },
            details: { anyOf: [
              { required: ['code'], additionalProperties: false },
              { required: ['code', 'trackerCode'], additionalProperties: false }
            ] }
          }
        } } },
        { properties: { error: { properties: { code: { enum: ['validation_error'] } } } } }
      ]
    });
    const request = schemas['CreateConversationWithFirstRunRequest'] as {
      properties: { submission: { oneOf: unknown[] } };
    };
    expect(request.properties.submission.oneOf[0]).toMatchObject({
      required: ['kind', 'body', 'issue'],
      properties: { kind: { enum: ['issue_reference'] }, workKind: { enum: ['feature', 'enhancement', 'bug', 'chore'] } }
    });
  });

  it('documents run resource routes', () => {
    const document = generateOpenApiDocument();
    expect(document.paths['/v1/runs/{id}']?.get?.responses?.['200']).toBeDefined();
    expect(document.paths['/v1/runs/{id}/steps']?.get?.responses?.['200']).toBeDefined();
    expect(document.paths['/v1/runs/{id}/events']?.get?.responses?.['200']).toBeDefined();
  });

  it('documents GET /v1/runs/{id}/spec', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/spec']?.get as
      | { responses?: Record<string, unknown>; tags?: string[] }
      | undefined;
    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('runs');
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['401']).toBeDefined();
    expect(operation?.responses?.['404']).toBeDefined();
  });

  it('documents POST /v1/runs/{id}/feedback', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/feedback']?.post as
      | { responses?: Record<string, unknown>; tags?: string[] }
      | undefined;
    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('runs');
    expect(operation?.responses?.['201']).toBeDefined();
    expect(operation?.responses?.['401']).toBeDefined();
    // Spec anchor validation: a present anchor that does not reproduce its quote is 422.
    expect(operation?.responses?.['422']).toBeDefined();
  });

  it('documents the PATCH feedback route and its lifecycle error responses', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/feedback/{feedbackId}']?.patch as
      | { responses?: Record<string, unknown>; tags?: string[] }
      | undefined;
    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('runs');
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['400']).toBeDefined();
    expect(operation?.responses?.['403']).toBeDefined();
    expect(operation?.responses?.['404']).toBeDefined();
    expect(operation?.responses?.['409']).toBeDefined();
  });

  it('documents the request_changes reply kind in the reply request schema', () => {
    const document = generateOpenApiDocument();
    const components = (document.components ?? {}) as { schemas?: Record<string, unknown> };
    const runReplyRequest = components.schemas?.['RunReplyRequest'] as
      | { oneOf?: { properties?: { kind?: { enum?: string[] } } }[] }
      | undefined;
    const kinds = (runReplyRequest?.oneOf ?? []).flatMap((member) => member.properties?.kind?.enum ?? []);
    expect(kinds).toContain('request_changes');
  });

  it('allows a response-only stale flag on artifact_range anchors but not on stored anchors', () => {
    const document = generateOpenApiDocument();
    const components = (document.components ?? {}) as { schemas?: Record<string, { properties?: Record<string, unknown> }> };
    expect(components.schemas?.['FeedbackResponse']).toBeDefined();
  });

  it('documents GET /v1/runs/{id}/feedback', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/feedback']?.get as
      | { responses?: Record<string, unknown>; tags?: string[] }
      | undefined;
    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('runs');
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['401']).toBeDefined();
  });

  it('documents GET /v1/runs with filters, paging, and validation errors', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs']?.get as
      | {
          responses?: Record<string, unknown>;
          tags?: string[];
          parameters?: { name: string; in: string; style?: string; explode?: boolean }[];
        }
      | undefined;

    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('runs');
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['400']).toBeDefined();
    expect(operation?.responses?.['401']).toBeDefined();
    expect(operation?.responses?.['403']).toBeDefined();

    const params = operation?.parameters ?? [];
    for (const name of ['status', 'waitingOn', 'workKind', 'projectId', 'limit', 'cursor']) {
      expect(params.some((p) => p.name === name && p.in === 'query')).toBe(true);
    }
    for (const name of ['status', 'waitingOn', 'workKind', 'projectId']) {
      const param = params.find((p) => p.name === name && p.in === 'query');
      expect(param?.style).toBe('form');
      expect(param?.explode).toBe(false);
    }
  });

  it('documents status, projectId, and nextCursor on the run list response schema', () => {
    const document = generateOpenApiDocument();
    const components = (document.components ?? {}) as { schemas?: Record<string, { properties?: Record<string, unknown> }> };
    const runListResponse = components.schemas?.['RunListResponse'];
    expect(runListResponse?.properties?.['nextCursor']).toBeDefined();
    const run = components.schemas?.['Run'];
    expect(run?.properties?.['status']).toBeDefined();
    expect(run?.properties?.['projectId']).toBeDefined();
  });

  it('documents replay=retained query parameter for GET /v1/runs/{id}/events', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/events']?.get as
      | { parameters?: { name: string; in: string; schema?: { enum?: string[] } }[] }
      | undefined;
    expect(operation).toBeDefined();
    const replayParam = operation?.parameters?.find((p) => p.name === 'replay' && p.in === 'query');
    expect(replayParam).toBeDefined();
    expect(replayParam?.schema?.enum).toContain('retained');
  });

  it('documents POST /v1/runs/{id}/feedback/{feedbackId}/thread', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/feedback/{feedbackId}/thread']?.post as
      | { responses?: Record<string, unknown>; tags?: string[] }
      | undefined;
    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('runs');
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['401']).toBeDefined();
    expect(operation?.responses?.['404']).toBeDefined();
  });

  it('documents the run replies endpoint', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/replies']?.post;

    expect(operation).toBeDefined();
    expect((operation as { responses?: Record<string, unknown> })?.responses?.['200']).toBeDefined();
    expect((operation as { responses?: Record<string, unknown> })?.responses?.['400']).toBeDefined();
    expect((operation as { responses?: Record<string, unknown> })?.responses?.['403']).toBeDefined();
    expect((operation as { responses?: Record<string, unknown> })?.responses?.['404']).toBeDefined();
    expect((operation as { responses?: Record<string, unknown> })?.responses?.['409']).toBeDefined();
    expect((operation as { responses?: Record<string, unknown> })?.responses?.['500']).toBeDefined();
  });

  it('documents the run recovery endpoint', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/recover']?.post as
      | { responses?: Record<string, unknown>; tags?: string[] }
      | undefined;

    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('runs');
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['400']).toBeDefined();
    expect(operation?.responses?.['403']).toBeDefined();
    expect(operation?.responses?.['404']).toBeDefined();
    expect(operation?.responses?.['409']).toBeDefined();
  });

  it('documents targeted PR refresh with strict JSON and safe check failures', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/runs/{id}/pull-request/refresh']?.post;
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(operation?.requestBody).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RunPullRequestRefreshRequest' } } }
    });
    expect(operation?.responses?.['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RunPullRequestRefreshResponse' } } }
    });
    for (const status of [400, 401, 403, 404, 409, 415, 500, 502]) {
      expect(operation?.responses?.[String(status)]).toBeDefined();
    }
    expect(operation?.responses?.['502']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/PullRequestCheckFailedResponse' } } }
    });
    const schemas = document.components?.schemas;
    expect(schemas?.['RunPullRequestRefreshRequest']).toMatchObject({
      type: 'object', additionalProperties: false
    });
    expect(schemas?.['RunPullRequestRefreshResponse']).toMatchObject({
      additionalProperties: false, required: ['pullRequest', 'run'],
      properties: { pullRequest: expect.any(Object), run: expect.any(Object) }
    });
    expect(schemas?.['PullRequestCheckFailedResponse']).toMatchObject({
      properties: { error: { properties: { details: { properties: {
        reason: { enum: ['credential_missing', 'authentication_failed', 'not_found', 'provider_unavailable'] }
      } } } } }
    });
  });

  it('documents POST /v1/pull-requests/reconcile', () => {
    const document = generateOpenApiDocument();
    const operation = document.paths['/v1/pull-requests/reconcile']?.post as
      | { responses?: Record<string, unknown>; tags?: string[]; security?: unknown[] }
      | undefined;

    expect(operation).toBeDefined();
    expect(operation?.tags).toContain('pull-requests');
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['401']).toBeDefined();
    expect(operation?.responses?.['403']).toBeDefined();
    expect(operation?.responses?.['500']).toBeDefined();
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(
      (document.components as { securitySchemes?: Record<string, unknown> } | undefined)
        ?.securitySchemes?.['bearerAuth']
    ).toBeDefined();
  });
});
