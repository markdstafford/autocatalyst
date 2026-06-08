import { z } from 'zod';

import { principalSchema } from './principal.js';

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema)
]));

export const nonModelPrincipalSchema = principalSchema.refine(
  (principal) => principal.kind === 'human' || principal.kind === 'system',
  { message: 'Owner principal must be human or system.' }
);

export const modelIdentitySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1).optional()
}).strict();

export const tokenBreakdownSchema = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
  cacheWrite: z.number().int().min(0)
}).strict();

export const costSchema = z.object({
  model: modelIdentitySchema,
  usd: z.number().int().min(0).nullable().optional(),
  tokens: tokenBreakdownSchema
}).strict();

export const trackedIssueSchema = z.object({
  number: z.number().int().min(1),
  title: z.string().min(1),
  state: z.enum(['open', 'closed', 'merged', 'unknown']),
  url: z.string().url()
}).strict();

export const credentialReferenceSchema = z.object({
  id: z.string().min(1),
  purpose: z.enum(['repo', 'issue_tracker', 'code_host', 'publisher', 'other']),
  label: z.string().min(1).optional()
}).strict();

export const channelReferenceSchema = z.object({
  provider: z.string().min(1),
  channelId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  label: z.string().min(1).optional()
}).strict();

const feedbackAnchorFileRangeSchema = z.object({
  kind: z.literal('file_range'),
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1)
}).strict();

export const feedbackAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), artifactId: z.string().min(1) }).strict(),
  feedbackAnchorFileRangeSchema,
  z.object({ kind: z.literal('message'), messageId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('run_step'), runStepId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('external'), url: z.string().url() }).strict()
]).superRefine((anchor, ctx) => {
  if (anchor.kind === 'file_range' && anchor.endLine < anchor.startLine) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'endLine must be greater than or equal to startLine.',
      path: ['endLine']
    });
  }
});

export const feedbackThreadEntrySchema = z.object({
  id: z.string().min(1),
  author: principalSchema,
  body: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();

export const feedbackThreadSchema = z.array(feedbackThreadEntrySchema).min(1);

export const testResultEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), id: z.string().min(1), url: z.string().url().optional(), summary: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('publication'), id: z.string().min(1), url: z.string().url().optional(), summary: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('log'), id: z.string().min(1).optional(), url: z.string().url().optional(), summary: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('external'), id: z.string().min(1).optional(), url: z.string().url().optional(), summary: z.string().min(1).optional() }).strict()
]).superRefine((value, ctx) => {
  if ((value.kind === 'log' || value.kind === 'external') && value.url === undefined && value.summary === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.kind === 'log' ? 'Log' : 'External'} evidence requires url or summary.`,
      path: ['url']
    });
  }
});

export const testingGuideResultSchema = z.object({
  status: z.enum(['not_run', 'passed', 'failed', 'blocked']),
  summary: z.string().min(1).optional(),
  checkedAt: z.string().datetime().optional(),
  evidence: z.array(testResultEvidenceSchema).optional()
}).strict();

export const inferenceSettingsSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  seed: z.number().int().optional(),
  extra: z.record(jsonValueSchema).optional()
}).strict();

export const sessionRoleSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u);

export const frontedResourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), id: z.string().min(1), reference: z.string().min(1).optional(), url: z.string().url().optional() }).strict(),
  z.object({ kind: z.literal('pull_request'), id: z.string().min(1), reference: z.string().min(1).optional(), url: z.string().url().optional() }).strict(),
  z.object({ kind: z.literal('issue'), id: z.string().min(1).optional(), reference: z.string().min(1).optional(), url: z.string().url().optional() }).strict(),
  z.object({ kind: z.literal('external'), id: z.string().min(1).optional(), reference: z.string().min(1).optional(), url: z.string().url().optional() }).strict()
]).superRefine((value, ctx) => {
  if ((value.kind === 'issue' || value.kind === 'external') && value.reference === undefined && value.url === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.kind === 'issue' ? 'Issue' : 'External'} resource requires reference or url.`,
      path: ['reference']
    });
  }
});

export function requireTenantMatchesOwner<T extends { owner: { tenantId: string }; tenant: string }>(value: T, context: z.RefinementCtx): void {
  if (value.tenant !== value.owner.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tenant'], message: 'Tenant must match owner.tenantId.' });
  }
}

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type NonModelPrincipal = z.infer<typeof nonModelPrincipalSchema>;
export type ModelIdentity = z.infer<typeof modelIdentitySchema>;
export type TokenBreakdown = z.infer<typeof tokenBreakdownSchema>;
export type Cost = z.infer<typeof costSchema>;
export type TrackedIssue = z.infer<typeof trackedIssueSchema>;
export type CredentialReference = z.infer<typeof credentialReferenceSchema>;
export type ChannelReference = z.infer<typeof channelReferenceSchema>;
export type FeedbackAnchor = z.infer<typeof feedbackAnchorSchema>;
export type FeedbackThreadEntry = z.infer<typeof feedbackThreadEntrySchema>;
export type FeedbackThread = z.infer<typeof feedbackThreadSchema>;
export type TestResultEvidence = z.infer<typeof testResultEvidenceSchema>;
export type TestingGuideResult = z.infer<typeof testingGuideResultSchema>;
export type InferenceSettings = z.infer<typeof inferenceSettingsSchema>;
export type SessionRole = z.infer<typeof sessionRoleSchema>;
export type FrontedResource = z.infer<typeof frontedResourceSchema>;
