import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { type Principal, errorResponseSchema, unauthorizedErrorCode } from '@autocatalyst/api-contract';

import { attachPrincipalToRequest, hardcodedDevelopmentPrincipal } from './principal.js';

export interface BearerAuthOptions {
  readonly bearerToken: string;
  readonly resolvePrincipal?: () => Principal | Promise<Principal>;
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) {
    // Run constant-time comparison anyway to avoid timing leaks
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function unauthorizedResponse() {
  return errorResponseSchema.parse({
    error: { code: unauthorizedErrorCode, message: 'Unauthorized.' }
  });
}

export async function registerBearerAuthHook(app: FastifyInstance, options: BearerAuthOptions): Promise<void> {
  if (options.bearerToken.trim().length === 0) {
    throw new Error('Bearer token is required.');
  }

  app.addHook('preHandler', async (request, reply) => {
    const authorization = request.headers.authorization;
    const prefix = 'Bearer ';
    if (authorization === undefined || !authorization.startsWith(prefix)) {
      await reply.status(401).send(unauthorizedResponse());
      return;
    }

    const suppliedToken = authorization.slice(prefix.length);
    if (!tokensMatch(suppliedToken, options.bearerToken)) {
      await reply.status(401).send(unauthorizedResponse());
      return;
    }

    const principal = options.resolvePrincipal === undefined
      ? hardcodedDevelopmentPrincipal
      : await options.resolvePrincipal();
    attachPrincipalToRequest(request, principal);
  });
}
