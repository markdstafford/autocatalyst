import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachPrincipalToRequest,
  getPrincipalFromRequest,
  hardcodedDevelopmentPrincipal,
  requirePrincipalFromRequest
} from './principal.js';

describe('principal request context', () => {
  let app = Fastify({ logger: false });

  afterEach(async () => {
    await app.close();
    app = Fastify({ logger: false });
  });

  it('defines a synthetic hardcoded development principal', () => {
    expect(hardcodedDevelopmentPrincipal).toEqual({
      id: 'principal_dev_human',
      kind: 'human',
      tenantId: 'tenant_dev',
      displayName: 'Development Principal'
    });
  });

  it('attaches, gets, and requires a principal from a request', async () => {
    app.get('/probe', async (request) => {
      expect(getPrincipalFromRequest(request)).toBeUndefined();
      attachPrincipalToRequest(request, hardcodedDevelopmentPrincipal);
      return { principal: requirePrincipalFromRequest(request) };
    });

    const response = await app.inject({ method: 'GET', url: '/probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ principal: hardcodedDevelopmentPrincipal });
  });

  it('throws when principal is required but missing', () => {
    expect(() => requirePrincipalFromRequest({} as never)).toThrow('Principal is required for protected route.');
  });
});
