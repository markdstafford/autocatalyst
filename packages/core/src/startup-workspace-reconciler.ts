import type { Run } from '@autocatalyst/api-contract';
import {
  WorkspaceProvisioningError,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult
} from '@autocatalyst/execution';

import type { Orchestrator } from './orchestrator.js';

/**
 * Safe run failure reason emitted when a missing workspace cannot be recreated because
 * the run branch is absent from the host repository. This string is in the execution
 * package's known failure-reason allowlist, so it survives public-surface normalization.
 */
export const RUN_BRANCH_MISSING_FAILURE_REASON = 'run_branch_missing' as const;

/**
 * Structured, path-free log sink for startup reconciliation. Implementations must not
 * expand the provided fields with filesystem paths, credentials, or raw git output —
 * only stable ids and typed codes are passed in.
 */
export interface StartupWorkspaceReconcilerLogger {
  info?(fields: Record<string, unknown>, message: string): void;
  warn?(fields: Record<string, unknown>, message: string): void;
  error?(fields: Record<string, unknown>, message: string): void;
}

export interface StartupWorkspaceReconcilerDependencies {
  /** Every non-terminal run, across all tenants. */
  readonly listNonTerminalRuns: () => Promise<readonly Run[]>;
  /**
   * Build the provisioning request for a run. Return `null` to skip a run that does not
   * use a two-root workspace or whose workspace settings cannot be resolved. The
   * reconciler forces `materializationBase` to `run_branch` before provisioning, so the
   * returned request's own `materializationBase` (if any) is ignored.
   */
  readonly buildProvisionRequest: (run: Run) => Promise<ProvisionWorkspaceRequest | null>;
  readonly provisionWorkspace: (request: ProvisionWorkspaceRequest) => Promise<ProvisionWorkspaceResult>;
  readonly orchestrator: Pick<Orchestrator, 'applyDirective'>;
  readonly logger?: StartupWorkspaceReconcilerLogger;
}

export interface StartupWorkspaceReconciliationSummary {
  /** Runs returned by the lister. */
  readonly total: number;
  /** Runs skipped because they do not use a two-root workspace or had no resolvable settings. */
  readonly skipped: number;
  /** Workspaces found already present on the expected branch and left in place. */
  readonly present: number;
  /** Workspaces recreated from the run branch. */
  readonly recreated: number;
  /** Runs failed through the orchestrator because their run branch was missing. */
  readonly failedMissingBranch: number;
  /** Runs where reconciliation encountered a non-fatal error and the walk continued. */
  readonly errored: number;
}

function provisioningErrorCode(error: unknown): string | undefined {
  return error instanceof WorkspaceProvisioningError ? error.code : undefined;
}

/**
 * Walk every non-terminal run that uses a two-root workspace and reconcile its on-disk
 * workspace against the durable run branch:
 *
 * - present workspace on the expected branch → left alone;
 * - missing workspace → recreated from the run branch (no dispatch, no step advance);
 * - missing run branch → run failed through the orchestrator with a safe reason;
 * - any other failure → logged safely and the walk continues.
 *
 * The walk never dispatches a run, never advances a run step, and a failure on one run
 * never prevents later runs from being reconciled. It resolves to a summary; it does not
 * throw for per-run failures.
 */
export async function reconcileStartupWorkspaces(
  dependencies: StartupWorkspaceReconcilerDependencies
): Promise<StartupWorkspaceReconciliationSummary> {
  const { listNonTerminalRuns, buildProvisionRequest, provisionWorkspace, orchestrator, logger } = dependencies;

  let total = 0;
  let skipped = 0;
  let present = 0;
  let recreated = 0;
  let failedMissingBranch = 0;
  let errored = 0;

  let runs: readonly Run[];
  try {
    runs = await listNonTerminalRuns();
  } catch (error) {
    logger?.error?.({ errorName: (error as Error)?.name }, 'Startup workspace reconciliation could not list runs.');
    return { total: 0, skipped: 0, present: 0, recreated: 0, failedMissingBranch: 0, errored: 0 };
  }

  total = runs.length;

  for (const run of runs) {
    let request: ProvisionWorkspaceRequest | null;
    try {
      request = await buildProvisionRequest(run);
    } catch (error) {
      errored += 1;
      logger?.warn?.(
        { runId: run.id, tenant: run.tenant, workKind: run.workKind, errorCode: provisioningErrorCode(error) },
        'Startup workspace reconciliation could not resolve run workspace settings; continuing.'
      );
      continue;
    }

    if (request === null) {
      skipped += 1;
      continue;
    }

    let result: ProvisionWorkspaceResult;
    try {
      result = await provisionWorkspace({ ...request, materializationBase: { kind: 'run_branch' } });
    } catch (error) {
      const code = provisioningErrorCode(error);
      if (code === 'run_branch_missing') {
        try {
          await orchestrator.applyDirective({
            runId: run.id,
            tenant: run.tenant,
            directive: 'fail',
            reason: RUN_BRANCH_MISSING_FAILURE_REASON,
            origin: 'system'
          });
          failedMissingBranch += 1;
          logger?.warn?.(
            { runId: run.id, tenant: run.tenant, workKind: run.workKind, errorCode: code },
            'Startup workspace reconciliation failed a run whose run branch is missing.'
          );
        } catch (failError) {
          errored += 1;
          logger?.error?.(
            { runId: run.id, tenant: run.tenant, workKind: run.workKind, errorName: (failError as Error)?.name },
            'Startup workspace reconciliation could not fail a run with a missing branch; continuing.'
          );
        }
        continue;
      }

      errored += 1;
      logger?.warn?.(
        { runId: run.id, tenant: run.tenant, workKind: run.workKind, errorCode: code },
        'Startup workspace reconciliation failed for a run; continuing.'
      );
      continue;
    }

    if (result.shape === 'two_roots' && result.outcome === 'present') {
      present += 1;
      continue;
    }

    recreated += 1;
    logger?.info?.(
      { runId: run.id, tenant: run.tenant, workKind: run.workKind },
      'Startup workspace reconciliation recreated a missing run workspace from its branch.'
    );
  }

  return { total, skipped, present, recreated, failedMissingBranch, errored };
}
