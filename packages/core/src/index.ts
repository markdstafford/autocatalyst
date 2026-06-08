export { getHealth } from './health.js';
export type { HealthDependencyChecker } from './health.js';
export { createProbeResource, getProbeResource } from './probe-resource.js';
export type { ProbeResourceRepository } from './probe-resource.js';
export { registerControlPlaneRoutes } from './routes.js';
export type { ControlPlaneRouteDependencies } from './routes.js';

export { hardcodedDevelopmentPrincipal, attachPrincipalToRequest, getPrincipalFromRequest, requirePrincipalFromRequest } from './principal.js';

export { registerBearerAuthHook } from './auth.js';
export type { BearerAuthOptions } from './auth.js';

export { permissivePolicyDecisionPoint, authorizeRequest } from './policy.js';
export type { PolicyDecisionPoint, PolicyDecisionInput, PolicyDecision, PolicyAction, PolicyResourceDescriptor } from './policy.js';
