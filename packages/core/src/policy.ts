import type { Principal } from '@autocatalyst/api-contract';

export type PolicyResourceDescriptor =
  | { readonly kind: 'probe_resource_collection'; readonly path: '/v1/probe-resources' }
  | { readonly kind: 'probe_resource'; readonly id: string; readonly path: '/v1/probe-resources/:id' }
  | { readonly kind: 'event_stream'; readonly path: '/v1/events' }
  | { readonly kind: 'principal_diagnostic'; readonly path: '' }
  | { readonly kind: 'configuration_record_collection'; readonly path: '/v1/configuration-records' }
  | { readonly kind: 'configuration_record'; readonly id: string; readonly path: '/v1/configuration-records/:id' }
  | { readonly kind: 'secret_collection'; readonly path: '/v1/secrets' }
  | { readonly kind: 'conversation_collection'; readonly path: '/v1/conversations' }
  | { readonly kind: 'run_collection'; readonly path: '/v1/runs' }
  | { readonly kind: 'run'; readonly id: string; readonly path: '/v1/runs/:id' }
  | { readonly kind: 'run_steps'; readonly id: string; readonly path: '/v1/runs/:id/steps' }
  | { readonly kind: 'run_events'; readonly id: string; readonly path: '/v1/runs/:id/events' }
  | { readonly kind: 'run_spec'; readonly id: string; readonly path: '/v1/runs/:id/spec' }
  | { readonly kind: 'run_feedback'; readonly id: string; readonly path: '/v1/runs/:id/feedback' }
  | { readonly kind: 'run_feedback_thread'; readonly id: string; readonly path: '/v1/runs/:id/feedback/:feedbackId/thread' }
  | { readonly kind: 'run_replies'; readonly id: string; readonly path: '/v1/runs/:id/replies' }
  | { readonly kind: 'pull_request_reconciliation'; readonly path: '/v1/pull-requests/reconcile' }
  | { readonly kind: 'run_pull_request'; readonly id: string; readonly path: '/v1/runs/:id/pull-request' }
  | { readonly kind: 'run_sessions'; readonly id: string; readonly path: '/v1/runs/:id/sessions' };

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
  | 'secret.create'
  | 'conversation.create'
  | 'run.list'
  | 'run.read'
  | 'run_steps.list'
  | 'run_events.stream'
  | 'run.tick'
  | 'run_spec.read'
  | 'run_feedback.create'
  | 'run_feedback.list'
  | 'run_feedback.thread.append'
  | 'run_replies.create'
  | 'pull_request.reconcile'
  | 'run_pull_request.read'
  | 'run_sessions.list';

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
