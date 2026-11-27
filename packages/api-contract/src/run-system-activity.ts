import { z } from 'zod';

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const label = z.string().min(1).max(250).regex(/^[^\p{C}]+$/u);
const path = label.refine(value => !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const metadata = { key: z.string().min(1).max(550), timestamp: z.string().datetime() };
export const prCiCoverageSchema = z.enum(['enabled', 'ticker_disabled', 'tenant_not_covered']);

export const requiredCheckEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('check_run'), id: label, name: label, conclusion: z.enum(['failure', 'timed_out', 'action_required']) }).strict(),
  z.object({ kind: z.literal('legacy_status'), id: label, name: label, conclusion: z.enum(['failure', 'error']) }).strict()
]);

const ci = {
  headSha: sha, checks: z.array(requiredCheckEvidenceSchema).max(20),
  limit: z.number().int().nonnegative(), ordinal: z.number().int().positive().optional(),
  admittedCount: z.number().int().nonnegative().optional(),
  prUrl: z.string().regex(/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/[1-9]\d*$/iu).optional()
};
const integration = {
  base: label, repository: label.optional(), branch: label.optional(),
  sourceSha: sha.nullish(), targetSha: sha.nullish(), reviewedSha: sha.nullish(), publishSha: sha.nullish(), observedTargetSha: sha.nullish(),
  paths: z.array(path).max(100).optional(), cleanup: z.enum(['restored', 'inspection_required']).optional(),
  refreshCount: z.number().int().min(0).max(2), sourcePushed: z.boolean().optional(),
  safeReason: z.enum(['binding_unavailable', 'target_unavailable', 'workspace_not_ready', 'attestation_missing', 'target_changed', 'candidate_changed', 'push_unverified']).optional()
};

export const integrationActivityCode = z.enum([
  'pr_target_integrated', 'pr_integration_conflict', 'pr_target_verification_failed', 'pr_integration_workspace_unavailable',
  'pr_publication_refreshed', 'pr_publication_refresh_exhausted', 'pr_publication_candidate_changed', 'pr_publication_push_unverified'
]);
export const ciOutcomeActivityCode = z.enum([
  'repair_pushed', 'repair_failure_cleared', 'repair_remote_changed', 'repair_remote_unverified', 'repair_workspace_not_ready',
  'repair_implementation_failed', 'repair_human_docs_changed', 'repair_final_review_blocked', 'repair_final_review_failed',
  'repair_integration_conflict', 'repair_target_verification_failed', 'repair_publication_refresh_exhausted', 'repair_candidate_changed',
  'repair_execution_failed', 'repair_no_change', 'repair_push_unverified', 'repair_interrupted', 'repair_pr_merged', 'repair_pr_closed', 'repair_canceled'
]);
export const runSystemActivitySchema = z.union([
  z.object({ ...metadata, kind: z.literal('integration'), code: integrationActivityCode, ...integration }).strict(),
  z.object({ ...metadata, kind: z.literal('ci_decision'), code: z.enum(['repair_queued', 'repair_disabled', 'repair_budget_exhausted', 'repair_unverified_provenance']), ...ci }).strict(),
  z.object({ ...metadata, kind: z.literal('ci_guidance'), code: z.literal('repair_needs_guidance'), ...ci }).strict(),
  z.object({
    ...metadata, kind: z.literal('ci_outcome'), code: ciOutcomeActivityCode, ...ci, publishHeadSha: sha.optional(),
    workspaceHold: z.boolean(), requiredPending: z.boolean().optional(), base: label, paths: z.array(path).max(100).optional(),
    sourceSha: sha.optional(), targetSha: sha.optional(), cleanup: z.enum(['restored', 'inspection_required']).optional(),
    findings: z.array(z.object({ severity: z.enum(['blocker', 'warning', 'info']), summary: label }).strict()).max(20).optional()
  }).strict()
]);

export type RunSystemActivity = z.infer<typeof runSystemActivitySchema>;
export type PrCiCoverage = z.infer<typeof prCiCoverageSchema>;
