import type { JsonValue } from '@autocatalyst/api-contract';
import type {
  AltitudeCheckpointRef,
  ImplementationAltitude,
  ReviewerFindingContext,
  ReviewerFindingSeverity,
  ReviewerResult,
  FindingDisposition,
  ConvergenceRoundRecord,
  Principal
} from '@autocatalyst/api-contract';
import type { RunWorkInput, RunWorkResult } from './orchestrator.js';

export const reviewedRoleDispatcherContractVersion = 'reviewed-role-dispatcher.v1' as const;

export type ToolPolicyMode = 'write' | 'read_only';

export interface AltitudeReviewContext {
  readonly altitude: ImplementationAltitude;
  readonly altitudeRound: number;
  readonly allowedWork?: string;
  readonly acceptedCheckpoints?: readonly AltitudeCheckpointRef[];
  readonly findingCategories?: readonly string[];
}

export interface ReviewContext {
  readonly previousFindings?: readonly ReviewerFindingContext[];
  readonly requiredDispositions?: readonly {
    feedbackId: string;
    title: string;
    severity: ReviewerFindingSeverity;
    body: string;
  }[];
  readonly previousRounds?: readonly ConvergenceRoundRecord[];
  readonly routingDistinct?: boolean;
  readonly altitudeContext?: AltitudeReviewContext;
  readonly humanGuidance?: string;
}

export interface RunRoleWorkInput extends RunWorkInput {
  readonly role: 'implementer' | 'reviewer';
  readonly round: number;
  readonly reviewContext?: ReviewContext;
  readonly toolPolicyMode?: ToolPolicyMode;
  readonly routeProfileId?: string;
  readonly route?: unknown; // ModelRoutingResolution when available
}

export interface ReviewedRoleDispatchResult {
  readonly workResult: RunWorkResult;
  readonly sessionCheckpointResult?: JsonValue;
  readonly reviewerResult?: ReviewerResult;
  readonly dispositions?: FindingDisposition[];
  readonly sessionId?: string;
  readonly lastPosition?: string;
  readonly modelPrincipal?: Principal;
}

/**
 * Contract for dispatching implementer and reviewer role sessions.
 *
 * INVARIANTS:
 * - Reviewer sessions are forced to read_only tool access regardless of toolPolicyMode input.
 * - Absent reviewer workspace policy grants no file or git access.
 */
export interface ReviewedRoleDispatcher {
  runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult>;
}
