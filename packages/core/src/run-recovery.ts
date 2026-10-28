import type { Run, RunStep } from '@autocatalyst/api-contract';

import { getRunStepDefinition, type RunPhase } from './run-step-catalog.js';

/**
 * Recovery resolves a failed run back to a re-dispatch step. The policy table lives in
 * `context-human/concepts/run.md`; this module turns the run's durable `RunStep` history,
 * the optional operator mode, and commit status into a concrete {@link RecoveryPlan}.
 */

export type RecoveryMode = 'resume' | 'start_over';
export type RecoveryMaterializationBaseKind = 'run_branch' | 'current_default_branch';
export type RecoveryExistingWorkspaceBehavior = 'keep' | 'replace';

export interface RecoveryPlan {
  readonly mode: RecoveryMode;
  readonly reDispatchStep: string;
  readonly baseKind: RecoveryMaterializationBaseKind;
  readonly existingWorkspaceBehavior: RecoveryExistingWorkspaceBehavior;
}

/** First (phase-entry) step for each workflow phase, used by start-over re-dispatch. */
export function phaseFirstStep(phase: RunPhase): string | null {
  switch (phase) {
    case 'spec':
      return 'spec.author';
    case 'implementation':
      return 'implementation.plan';
    case 'docs':
      return 'docs.update';
    case 'pr':
      return 'pr.finalize';
    default:
      return null;
  }
}

/**
 * Find the non-terminal workflow step the run stopped at: the most recent `RunStep` whose
 * step is not a terminal step (`failed`/`done`/`canceled`), scanning the ordered history
 * from the end. Returns null when no such step exists (malformed history), which the caller
 * maps to a safe 409.
 *
 * `runSteps` is expected in ascending start order (as `listByRun` returns them).
 */
export function findStoppedStep(runSteps: readonly RunStep[]): RunStep | null {
  for (let i = runSteps.length - 1; i >= 0; i -= 1) {
    const candidate = runSteps[i];
    if (candidate === undefined) continue;
    const definition = getRunStepDefinition(candidate.step);
    if (definition === null) continue;
    if (definition.waitingOn === 'none') continue; // skip terminal rows (failed/done/canceled)
    return candidate;
  }
  return null;
}

export interface ResolveRecoveryPlanInput {
  readonly stoppedStep: RunStep;
  /** Explicit operator mode, or undefined to apply the recovery policy table. */
  readonly explicitMode?: RecoveryMode;
  /**
   * Whether the run branch carries committed checkpoints beyond the provisioned base.
   * Only consulted when `explicitMode` is omitted and the stopped phase is not `spec`.
   */
  readonly hasCommittedCheckpoints: boolean;
}

export class RecoveryPlanError extends Error {
  readonly code: 'unknown_stopped_phase';
  constructor(code: 'unknown_stopped_phase', message: string) {
    super(message);
    this.name = 'RecoveryPlanError';
    this.code = code;
  }
}

const RESUME_PLAN = (stoppedStep: string): RecoveryPlan => ({
  mode: 'resume',
  reDispatchStep: stoppedStep,
  baseKind: 'run_branch',
  existingWorkspaceBehavior: 'keep'
});

const START_OVER_PLAN = (reDispatchStep: string): RecoveryPlan => ({
  mode: 'start_over',
  reDispatchStep,
  baseKind: 'current_default_branch',
  existingWorkspaceBehavior: 'replace'
});

/**
 * Resolve the recovery plan. Mirrors the recovery policy table:
 *
 * - explicit `resume`: re-dispatch the stopped step on the run branch, keep the workspace.
 * - explicit `start_over`: re-dispatch the phase's first step (spec → `spec.author`) on a
 *   freshly fetched default branch, replacing the workspace.
 * - omitted, spec phase: start over at `spec.author`.
 * - omitted, implementation/docs/pr with committed checkpoints: resume the stopped step.
 * - omitted, pre-commit failure: start over at the phase's first step.
 */
export function resolveRecoveryPlan(input: ResolveRecoveryPlanInput): RecoveryPlan {
  const definition = getRunStepDefinition(input.stoppedStep.step);
  const phase = definition?.phase ?? null;
  const firstStep = phaseFirstStep(phase);
  if (firstStep === null) {
    throw new RecoveryPlanError(
      'unknown_stopped_phase',
      `Stopped step '${input.stoppedStep.step}' has no recoverable phase.`
    );
  }

  if (input.explicitMode === 'resume') {
    return RESUME_PLAN(input.stoppedStep.step);
  }
  if (input.explicitMode === 'start_over') {
    return START_OVER_PLAN(firstStep);
  }

  // Omitted mode: apply the policy table.
  if (phase === 'spec') {
    return START_OVER_PLAN('spec.author');
  }
  if (input.hasCommittedCheckpoints) {
    return RESUME_PLAN(input.stoppedStep.step);
  }
  return START_OVER_PLAN(firstStep);
}

// --- Service dependency ports ---------------------------------------------------------

export interface RecoverMaterializeWorkspaceInput {
  readonly run: Run;
  readonly baseKind: RecoveryMaterializationBaseKind;
  readonly existingWorkspaceBehavior: RecoveryExistingWorkspaceBehavior;
}

export interface RecoverMaterializeWorkspaceResult {
  /** Provisioning outcome recorded on the recovery event. */
  readonly provisioningOutcome: 'present' | 'materialized' | 'none';
}

export class RunRecoveryWorkspaceError extends Error {
  readonly code: 'run_branch_missing' | 'materialization_failed';
  constructor(code: 'run_branch_missing' | 'materialization_failed', message: string) {
    super(message);
    this.name = 'RunRecoveryWorkspaceError';
    this.code = code;
  }
}

/**
 * Host-provided seam for recovery's workspace concerns, keeping the control-plane service
 * free of git and execution internals. The composition root wires these against the
 * execution workspace provisioner and the run workspace git port.
 */
export interface RunRecoveryDependencies {
  /**
   * Whether the run branch carries committed checkpoints beyond the provisioned base ref.
   * Implementations compare the run branch head to `run_workspace_metadata.provisionedBaseRef`;
   * a missing branch or missing/identical base ref means no meaningful commit (false).
   */
  detectCommittedCheckpoints(input: { readonly run: Run }): Promise<boolean>;
  /**
   * Materialize the workspace for the resolved plan. Throws {@link RunRecoveryWorkspaceError}
   * with `run_branch_missing` when a `run_branch` base is requested but the branch is absent.
   */
  materializeWorkspace(input: RecoverMaterializeWorkspaceInput): Promise<RecoverMaterializeWorkspaceResult>;
}
