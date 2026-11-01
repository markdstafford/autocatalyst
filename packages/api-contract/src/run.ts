import { z } from 'zod';

import { nonModelPrincipalSchema, requireTenantMatchesOwner, testingGuideResultSchema, trackedIssueSchema } from './domain-value-objects.js';

export const runWorkKindSchema = z.string().min(1);

export const waitingOnSchema = z.enum(['system', 'ai', 'human', 'none']);
export type RunWaitingOn = z.infer<typeof waitingOnSchema>;

/**
 * Derived, API-read-only run status. Not a persisted field: the read mapper derives it from
 * `terminal` and `currentStep` (see the control-plane service). Persisted/event runs parse
 * through {@link runSchema} without it, so it is optional on the resource schema.
 */
export const runStatusSchema = z.enum(['in_progress', 'done', 'failed', 'canceled']);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSchema = z.object({
  id: z.string().min(1),
  topicId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  workKind: runWorkKindSchema,
  currentStep: z.string().min(1),
  waitingOn: waitingOnSchema.optional(),
  // API-read-only fields. The read mapper fills `status` and `projectId` for list/get/reply/recover
  // responses; persisted rows and run-event payloads parse without them, so both stay optional.
  status: runStatusSchema.optional(),
  projectId: z.string().min(1).optional(),
  // Temporary persistence discriminator for the one-active-run partial index. ADR-015 will reconcile
  // terminality to the workflow step catalog's waiting_on-derived source of truth when that feature lands.
  terminal: z.boolean(),
  trackedIssue: trackedIssueSchema.optional(),
  testingGuideResult: testingGuideResultSchema.optional(),
  failureReason: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine(requireTenantMatchesOwner);

export const createRunInputSchema = z.object({
  topicId: z.string().min(1),
  owner: nonModelPrincipalSchema,
  tenant: z.string().min(1),
  workKind: runWorkKindSchema,
  currentStep: z.string().min(1),
  // Temporary persistence discriminator for the one-active-run partial index. ADR-015 will reconcile
  // terminality to the workflow step catalog's waiting_on-derived source of truth when that feature lands.
  terminal: z.boolean(),
  trackedIssue: trackedIssueSchema.optional(),
  testingGuideResult: testingGuideResultSchema.optional()
}).strict().superRefine(requireTenantMatchesOwner);

export const runCollectionPath = '/v1/runs' as const;
export const runResourcePath = '/v1/runs/:id' as const;
export const getRunSuccessStatusCode = 200 as const;
export const listRunsSuccessStatusCode = 200 as const;

/** Maximum accepted page size for the run collection read; also the server default page size. */
export const maxRunListLimit = 100 as const;

export const createRunWorkKindSchema = z.enum(['feature', 'enhancement', 'bug', 'chore', 'file_issue', 'question']);

export const runIdParamsSchema = z.object({ id: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------
// Cursor paging
// ---------------------------------------------------------------------------

/**
 * Opaque-to-clients cursor encoding the ordering position for the next page. The run list is
 * ordered `createdAt DESC, id DESC`; the cursor carries exactly the ordered-position data needed
 * to continue from the last returned row.
 */
export const runListCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().min(1)
}).strict();
export type RunListCursor = z.infer<typeof runListCursorSchema>;

function malformedCursorError(): z.ZodError {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: ['cursor'], message: 'Malformed cursor.' }
  ]);
}

function toBase64Url(input: string): string {
  // Cursor contents are ASCII (ISO datetime + id), so btoa is safe and works in Node and browsers.
  return btoa(input).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64Url(input: string): string {
  const normalized = input.replace(/-/gu, '+').replace(/_/gu, '/');
  return atob(normalized);
}

/** Encode an ordered-position cursor into the opaque string returned to clients as `nextCursor`. */
export function encodeRunListCursor(cursor: RunListCursor): string {
  return toBase64Url(JSON.stringify(runListCursorSchema.parse(cursor)));
}

/**
 * Decode a client-supplied opaque cursor back into its ordered-position data. Malformed or
 * undecodable cursors throw a {@link z.ZodError} so callers surface a `400 validation_error`
 * rather than an internal fault.
 */
export function decodeRunListCursor(value: string): RunListCursor {
  let json: string;
  try {
    json = fromBase64Url(value);
  } catch {
    throw malformedCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformedCursorError();
  }
  return runListCursorSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// List query contract
// ---------------------------------------------------------------------------

/**
 * One comma-separated filter field. Fastify delivers a single query value as a string and a
 * repeated key as an array; the leading `z.string()` rejects the array form so repeated keys
 * surface as validation errors. Each comma item is validated against `item`; empty items fail,
 * and duplicate non-empty items are de-duplicated.
 */
function commaSeparatedFilter<Output>(item: z.ZodType<Output>, label: string): z.ZodType<Output[], z.ZodTypeDef, unknown> {
  return z.string().transform((value, ctx): Output[] => {
    const parts = value.split(',');
    const out: Output[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      const parsed = item.safeParse(part);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid ${label} filter value.` });
        return z.NEVER;
      }
      const key = JSON.stringify(parsed.data);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(parsed.data);
      }
    }
    return out;
  }) as unknown as z.ZodType<Output[], z.ZodTypeDef, unknown>;
}

export const listRunsQuerySchema = z.object({
  status: commaSeparatedFilter(runStatusSchema, 'status').optional(),
  waitingOn: commaSeparatedFilter(waitingOnSchema, 'waitingOn').optional(),
  workKind: commaSeparatedFilter(createRunWorkKindSchema, 'workKind').optional(),
  projectId: commaSeparatedFilter(z.string().min(1), 'projectId').optional(),
  limit: z.coerce.number().int().positive().max(maxRunListLimit).optional(),
  cursor: z.string().min(1).optional()
}).strict();
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const runListResponseSchema = z.object({
  runs: z.array(runSchema),
  nextCursor: z.string().min(1).optional()
}).strict();

export type RunWorkKind = z.infer<typeof runWorkKindSchema>;
export type Run = z.infer<typeof runSchema>;
export type CreateRunInput = z.infer<typeof createRunInputSchema>;
export type CreateRunWorkKind = z.infer<typeof createRunWorkKindSchema>;
export type RunIdParams = z.infer<typeof runIdParamsSchema>;
export type RunListResponse = z.infer<typeof runListResponseSchema>;
