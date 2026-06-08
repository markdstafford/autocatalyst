import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponseSchema } from '@autocatalyst/api-contract';

import { registerBearerAuthHook } from './auth.js';
import { getPrincipalFromRequest, hardcodedDevelopmentPrincipal } from './principal.js';

describe('registerBearerAuthHook', () => {
  let app = Fastify({ logger: false });

  afterEach(async () => {
    await app.close();
    app = Fastify({ logger: false });
  });

  it('rejects missing, malformed, and invalid bearer tokens before handlers run', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    await registerBearerAuthHook(app, { bearerToken: 'expected-token' });
    app.get('/v1/protected', handler);

    for (const authorization of [undefined, 'Basic abc', 'Bearer wrong-token']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/protected',
        headers: authorization === undefined ? {} : { authorization }
      });
      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('unauthorized');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('attaches the default or resolved principal for valid tokens', async () => {
    await registerBearerAuthHook(app, {
      bearerToken: 'expected-token',
      resolvePrincipal: async () => Object.assign({}, hardcodedDevelopmentPrincipal, { id: 'principal_async' })
    });
    app.get('/v1/protected', async (request) => ({ principal: getPrincipalFromRequest(request) }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/protected',
      headers: { authorization: 'Bearer expected-token' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().principal.id).toBe('principal_async');
  });

  it('attaches the hardcoded principal when no resolvePrincipal is provided', async () => {
    await registerBearerAuthHook(app, { bearerToken: 'token' });
    app.get('/v1/ok', async (request) => ({ principal: getPrincipalFromRequest(request) }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ok',
      headers: { authorization: 'Bearer token' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().principal).toEqual(hardcodedDevelopmentPrincipal);
  });
});
