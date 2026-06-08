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
});
