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
});
