import type { FastifyRequest } from 'fastify';

import type { Principal } from '@autocatalyst/api-contract';

const principalSymbol = Symbol('autocatalyst.principal');

type PrincipalRequest = FastifyRequest & { [principalSymbol]?: Principal };

export const hardcodedDevelopmentPrincipal: Principal = {
  id: 'principal_dev_human',
  kind: 'human',
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

export function attachPrincipalToRequest(request: FastifyRequest, principal: Principal): void {
  (request as PrincipalRequest)[principalSymbol] = principal;
}

export function getPrincipalFromRequest(request: FastifyRequest): Principal | undefined {
  return (request as PrincipalRequest)[principalSymbol];
}

export function requirePrincipalFromRequest(request: FastifyRequest): Principal {
  const principal = getPrincipalFromRequest(request);
  if (principal === undefined) {
    throw new Error('Principal is required for protected route.');
  }
  return principal;
}
