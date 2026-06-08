import type { Principal } from '@autocatalyst/api-contract';

export type PolicyResourceDescriptor =
  | { readonly kind: 'probe_resource_collection'; readonly path: '/v1/probe-resources' }
  | { readonly kind: 'probe_resource'; readonly id: string; readonly path: '/v1/probe-resources/:id' }
  | { readonly kind: 'event_stream'; readonly path: '/v1/events' }
  | { readonly kind: 'principal_diagnostic'; readonly path: '' }
  | { readonly kind: 'configuration_record_collection'; readonly path: '/v1/configuration-records' }
  | { readonly kind: 'configuration_record'; readonly id: string; readonly path: '/v1/configuration-records/:id' }
  | { readonly kind: 'secret_collection'; readonly path: '/v1/secrets' };

export type PolicyAction =
  | 'probe_resource.create'
  | 'probe_resource.read'
  | 'events.stream'
  | 'principal.diagnostic.read'
  | 'configuration_record.create'
  | 'configuration_record.list'
  | 'configuration_record.read'
  | 'configuration_record.update'
  | 'configuration_record.delete'
  | 'secret.create';

export interface PolicyDecisionInput {
  readonly principal: Principal;
  readonly action: PolicyAction;
  readonly resource: PolicyResourceDescriptor;
}

export interface PolicyDecision {
  readonly allowed: boolean;
}

export interface PolicyDecisionPoint {
  authorize(input: PolicyDecisionInput): Promise<PolicyDecision>;
}

export const permissivePolicyDecisionPoint: PolicyDecisionPoint = {
  async authorize() {
    return { allowed: true };
  }
};

export async function authorizeRequest(
  policy: PolicyDecisionPoint,
  input: PolicyDecisionInput
): Promise<PolicyDecision> {
  return policy.authorize(input);
}
