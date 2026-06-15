import { z } from 'zod';

import {
  findingDispositionSchema,
  reviewerResultSchema
} from '@autocatalyst/api-contract';
import type {
  JsonValue,
  Principal
} from '@autocatalyst/api-contract';
import type {
  ExecutionRunUnitOfWork,
  ReviewedRoleDispatchResult,
  ReviewedRoleDispatcher,
  RunRoleWorkInput
} from '@autocatalyst/core';
import { safeFailureReasonFromError } from '@autocatalyst/core';

// ---------------------------------------------------------------------------
// Safe session metadata schema
//
// The checkpoint result from a role session may optionally carry a typed
// session metadata object. This schema validates the safe subset that the
// dispatcher can expose to callers without leaking provider internals.
// Fields are all optional — absence of any field is not an error.
// ---------------------------------------------------------------------------

const safeSessionMetadataSchema = z.object({
  sessionId: z.string().min(1).optional(),
  lastPosition: z.string().min(1).optional(),
  modelPrincipal: z.object({
    id: z.string().min(1),
    kind: z.enum(['human', 'model', 'system']),
    tenantId: z.string().min(1),
    displayName: z.string().min(1).optional()
  }).strict().optional()
}).strict();

// Lenient wrapper that never throws — returns undefined on any parse failure.
function parseSafeSessionMetadata(checkpoint: JsonValue | undefined): {
  sessionId?: string;
  lastPosition?: string;
  modelPrincipal?: Principal;
} {
  if (checkpoint === null || checkpoint === undefined) {
    return {};
  }
  const parsed = safeSessionMetadataSchema.safeParse(checkpoint);
  if (!parsed.success) {
    return {};
  }
  return {
    ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
    ...(parsed.data.lastPosition !== undefined ? { lastPosition: parsed.data.lastPosition } : {}),
    ...(parsed.data.modelPrincipal !== undefined ? { modelPrincipal: parsed.data.modelPrincipal } : {})
  };
}

// Lenient reviewer result parser — returns undefined on any parse failure so
// callers can distinguish a well-formed reviewer output from raw checkpoint data.
function parseReviewerResult(checkpoint: JsonValue | undefined): import('@autocatalyst/api-contract').ReviewerResult | undefined {
  if (checkpoint === null || checkpoint === undefined) {
    return undefined;
  }
  const parsed = reviewerResultSchema.safeParse(checkpoint);
  return parsed.success ? parsed.data : undefined;
}

// Lenient dispositions parser — returns undefined when no valid dispositions array is found.
function parseDispositions(
  checkpoint: JsonValue | undefined
): import('@autocatalyst/api-contract').FindingDisposition[] | undefined {
  if (checkpoint === null || checkpoint === undefined) {
    return undefined;
  }
  if (typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    return undefined;
  }
  const raw = (checkpoint as Record<string, unknown>)['dispositions'];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const result: import('@autocatalyst/api-contract').FindingDisposition[] = [];
  for (const item of raw) {
    const parsed = findingDispositionSchema.safeParse(item);
    if (!parsed.success) {
      return undefined;
    }
    result.push(parsed.data);
  }
  return result.length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Reviewed execution dispatcher
//
// Adapts the existing `ExecutionRunUnitOfWork` to implement
// `ReviewedRoleDispatcher`. Key invariants:
//
// - Implementer calls: write-capable tools, metadata carries role/round via
//   task inputs so the execution context resolver can forward them.
// - Reviewer calls: `toolPolicyMode` forced to `read_only` regardless of
//   input. The role and round are carried as task inputs for downstream
//   context resolution.
// - Results: session checkpoint data is passed through, with best-effort
//   parsing of reviewer results, dispositions, and session metadata.
// - Failures are sanitized through the existing runner failure path.
// ---------------------------------------------------------------------------

export interface ReviewedExecutionDispatcherOptions {
  readonly unitOfWork: ExecutionRunUnitOfWork;
}

export function createReviewedExecutionDispatcher(
  options: ReviewedExecutionDispatcherOptions
): ReviewedRoleDispatcher {
  const { unitOfWork } = options;

  return {
    async runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult> {
      // Enforce reviewer invariant: always read_only, never write.
      const effectiveToolPolicyMode = input.role === 'reviewer' ? 'read_only' : (input.toolPolicyMode ?? 'write');

      // Build an augmented RunWorkInput that threads role/round metadata into
      // the execution pipeline. The task input keys use a namespaced prefix to
      // avoid collisions with step-level task inputs defined by the caller.
      //
      // NOTE: The current ExecutionRunUnitOfWork accepts RunWorkInput directly.
      // Role and round are injected as metadata that downstream resolvers
      // (execution context, entry point) can read when they support it.
      // Today these are logged/recorded through session persistence by the
      // session repository; the execution entry point reads `role` from
      // AgentRunnerFactoryInput which is derived from resolveRole in the
      // delegating entry point wired in server.ts.
      //
      // For this adapter we pass the effective role and round through the
      // RunWorkInput so integrators that wire a role-aware resolveContext can
      // apply them. The base implementation ignores unknown keys, so this is
      // safe even when the underlying resolver has not been updated yet.
      const augmentedInput = {
        ...input,
        // Signal the effective tool policy for downstream context resolvers.
        toolPolicyMode: effectiveToolPolicyMode,
        // Reviewer workspace policy signal: downstream resolvers should
        // restrict file and git access to read-only when role is 'reviewer'.
        reviewerPolicy: input.role === 'reviewer' ? { fileAccess: 'read_only', gitAccess: 'read_only' } : undefined
      };

      let checkpointResult: JsonValue | undefined;
      let workResult: import('@autocatalyst/core').RunWorkResult;

      try {
        const result = await unitOfWork.runWithCheckpoint(augmentedInput);
        workResult = result.workResult;
        checkpointResult = result.checkpointResult;
      } catch (error) {
        // Sanitize unexpected throws through the existing failure path.
        const reason = safeFailureReasonFromError(error) ?? 'Reviewed dispatch failed: unexpected_error';
        return {
          workResult: { directive: 'fail', reason }
        };
      }

      // Build dispatch result from work result + checkpoint data.
      const sessionMeta = parseSafeSessionMetadata(checkpointResult);

      const dispatchResult: ReviewedRoleDispatchResult = {
        workResult,
        ...(checkpointResult !== undefined ? { sessionCheckpointResult: checkpointResult } : {}),
        ...(sessionMeta.sessionId !== undefined ? { sessionId: sessionMeta.sessionId } : {}),
        ...(sessionMeta.lastPosition !== undefined ? { lastPosition: sessionMeta.lastPosition } : {}),
        ...(sessionMeta.modelPrincipal !== undefined ? { modelPrincipal: sessionMeta.modelPrincipal } : {})
      };

      // For reviewer sessions: attempt to parse reviewer result from checkpoint.
      if (input.role === 'reviewer' && checkpointResult !== undefined) {
        const reviewerResult = parseReviewerResult(checkpointResult);
        if (reviewerResult !== undefined) {
          return { ...dispatchResult, reviewerResult };
        }
      }

      // For implementer sessions: attempt to parse dispositions from checkpoint.
      if (input.role === 'implementer' && checkpointResult !== undefined) {
        const dispositions = parseDispositions(checkpointResult);
        if (dispositions !== undefined) {
          return { ...dispatchResult, dispositions };
        }
      }

      return dispatchResult;
    }
  };
}
