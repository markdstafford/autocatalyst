import type { Project } from '@autocatalyst/api-contract';

import { createNodeWorkspaceDriver } from './internal/workspace-driver.js';
import { createWorkspaceProvisioner } from './internal/workspace-provisioner.js';
import { createWorkspacePruner } from './internal/workspace-pruner.js';
import { createWorkspaceTeardown } from './internal/workspace-teardown.js';

export type WorkspaceRunKind = 'feature' | 'enhancement' | 'bug' | 'chore' | 'file_issue' | 'question';
export type ImplementingWorkspaceRunKind = Extract<WorkspaceRunKind, 'feature' | 'enhancement' | 'bug' | 'chore'>;
export type WorkspaceProvisioningShape = 'none' | 'scratch_only' | 'two_roots';

export interface WorkspaceProvisioningRoots {
  readonly reposRoot: string;
  readonly workspacesRoot: string;
}

export interface ProvisionWorkspaceRequest {
  readonly runId: string;
  readonly runKind: WorkspaceRunKind;
  readonly topicSlug: string;
  readonly shortRunId: string;
  readonly defaultBranch?: string;
  readonly project: Project;
  readonly roots: WorkspaceProvisioningRoots;
}

export type ProvisionWorkspaceResult =
  | {
      readonly shape: 'none';
      readonly runId: string;
    }
  | {
      readonly shape: 'scratch_only';
      readonly runId: string;
      readonly workspaceRoot: string;
      readonly runRoot: string;
      readonly scratchRoot: string;
    }
  | {
      readonly shape: 'two_roots';
      readonly runId: string;
      readonly workspaceRoot: string;
      readonly runRoot: string;
      readonly repoRoot: string;
      readonly scratchRoot: string;
      readonly hostRepositoryPath: string;
      readonly branchName: string;
    };

export type WorkspaceProvisioningErrorCode =
  | 'invalid_run_id'
  | 'unsupported_run_kind'
  | 'invalid_project_repository'
  | 'host_clone_failed'
  | 'fetch_failed'
  | 'default_branch_resolution_failed'
  | 'worktree_creation_failed'
  | 'scratch_creation_failed'
  | 'run_workspace_exists'
  | 'rollback_failed'
  | 'out_of_root_path'
  | 'branch_guard_failed';

export interface WorkspaceErrorCauseSummary {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

/** @deprecated Use WorkspaceErrorCauseSummary */
export type WorkspaceProvisioningErrorCauseSummary = WorkspaceErrorCauseSummary;

export interface WorkspaceProvisioningErrorContext {
  readonly runId?: string;
  readonly shape?: WorkspaceProvisioningShape;
  readonly targetPath?: string;
  readonly root?: string;
  readonly rootKind?: 'workspace' | 'repos';
  readonly intent?: 'write' | 'delete' | 'git';
  readonly expectedBranch?: string;
  readonly actualBranch?: string | null;
  readonly cause?: WorkspaceErrorCauseSummary;
  readonly rollbackCause?: WorkspaceErrorCauseSummary;
}

export class WorkspaceProvisioningError extends Error {
  readonly code: WorkspaceProvisioningErrorCode;
  readonly context?: WorkspaceProvisioningErrorContext;

  constructor(
    code: WorkspaceProvisioningErrorCode,
    message: string,
    context?: WorkspaceProvisioningErrorContext
  ) {
    super(message);
    this.name = 'WorkspaceProvisioningError';
    this.code = code;
    if (context !== undefined) {
      this.context = context;
    }
  }
}

const credentialInUrlPattern = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(?::([^/@\s]+))?@/giu;

export function redactWorkspaceDiagnostic(value: string): string {
  return value.replace(credentialInUrlPattern, '$1[redacted]@');
}

export function summarizeWorkspaceCause(cause: unknown): WorkspaceErrorCauseSummary {
  if (cause instanceof WorkspaceProvisioningError) {
    return {
      name: cause.name,
      message: redactWorkspaceDiagnostic(cause.message),
      code: cause.code
    };
  }

  if (cause instanceof Error) {
    const errorWithCode = cause as Error & { readonly code?: string | number };
    return {
      name: cause.name,
      message: redactWorkspaceDiagnostic(cause.message),
      ...(errorWithCode.code !== undefined && { code: errorWithCode.code })
    };
  }

  return {
    name: 'Error',
    message: redactWorkspaceDiagnostic(String(cause))
  };
}

export async function provisionWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionWorkspaceResult> {
  const driver = createNodeWorkspaceDriver();
  const pruner = createWorkspacePruner({ driver });
  const provisioner = createWorkspaceProvisioner({ driver, pruner });
  return provisioner.provisionWorkspace(request);
}

// --- Prune types ---

export type WorkspacePruneMode = 'worktree' | 'directory';

/**
 * `skipped` is reserved for caller-level retention decisions or future non-destructive prune policies.
 * The destructive pruner in this feature returns deleted, missing, rejected, or failed.
 */
export type WorkspacePruneStatus = 'deleted' | 'missing' | 'skipped' | 'rejected' | 'failed';

export interface PruneWorkspacePathRequest {
  readonly runId: string;
  readonly mode: WorkspacePruneMode;
  readonly workspaceRoot: string;
  readonly targetPath: string;
  readonly hostRepositoryPath?: string;
}

export interface WorkspacePruneResult {
  readonly runId: string;
  readonly mode: WorkspacePruneMode;
  readonly status: WorkspacePruneStatus;
  readonly root: string;
  readonly targetPath: string;
  readonly durationMs: number;
  readonly errorCode?: WorkspacePruneErrorCode;
}

export type WorkspacePruneErrorCode =
  | 'unsupported_prune_mode'
  | 'out_of_root_path'
  | 'target_not_directory'
  | 'target_stat_failed'
  | 'missing_host_repository'
  | 'directory_remove_failed'
  | 'worktree_remove_failed'
  | 'worktree_admin_prune_failed';

export interface WorkspacePruneErrorContext {
  readonly runId?: string;
  readonly mode?: WorkspacePruneMode;
  readonly root?: string;
  readonly rootKind?: 'workspace' | 'repos';
  readonly targetPath?: string;
  readonly cause?: WorkspaceErrorCauseSummary;
}

export class WorkspacePruneError extends Error {
  readonly code: WorkspacePruneErrorCode;
  readonly context?: WorkspacePruneErrorContext;

  constructor(code: WorkspacePruneErrorCode, message: string, context?: WorkspacePruneErrorContext) {
    super(message);
    this.name = 'WorkspacePruneError';
    this.code = code;
    if (context !== undefined) {
      this.context = context;
    }
  }
}

// --- Teardown types ---

export type WorkspaceTerminalStep = 'done' | 'canceled' | 'failed';
export type WorkspaceTeardownOutcome = 'completed' | 'retained' | 'skipped' | 'partial_failure' | 'failed';
export type WorkspaceBranchAction = 'deleted' | 'retained' | 'not_applicable' | 'failed';
export type WorkspaceCheckpointAction = 'committed' | 'no_changes' | 'not_applicable' | 'failed';
export type WorkspacePrunePurpose = 'worktree' | 'run_directory';

export interface WorkspaceTeardownPruneResult extends WorkspacePruneResult {
  readonly purpose: WorkspacePrunePurpose;
}

export interface TeardownWorkspaceRequest {
  readonly runId: string;
  readonly runKind: WorkspaceRunKind;
  readonly terminalStep: WorkspaceTerminalStep;
  readonly workspaceRoot?: string;
  readonly runRoot?: string;
  readonly repoRoot?: string;
  readonly scratchRoot?: string;
  readonly hostRepositoryPath?: string;
  readonly branchName?: string;
  readonly checkpointSubject?: string;
}

export interface WorkspaceBranchResult {
  readonly name?: string;
  readonly action: WorkspaceBranchAction;
  readonly errorCode?: WorkspaceTeardownErrorCode;
}

export interface WorkspaceCheckpointResult {
  readonly action: WorkspaceCheckpointAction;
  readonly commitSha?: string;
  readonly message?: string;
  readonly errorCode?: WorkspaceTeardownErrorCode;
}

export interface WorkspaceTeardownResult {
  readonly runId: string;
  readonly runKind: WorkspaceRunKind;
  readonly terminalStep: WorkspaceTerminalStep;
  readonly outcome: WorkspaceTeardownOutcome;
  readonly prunes: readonly WorkspaceTeardownPruneResult[];
  readonly branch?: WorkspaceBranchResult;
  readonly checkpoint?: WorkspaceCheckpointResult;
}

export type WorkspaceTeardownErrorCode =
  | 'invalid_terminal_step'
  | 'unsupported_run_kind'
  | 'missing_workspace_context'
  | 'worktree_branch_mismatch'
  | 'invalid_checkpoint_subject'
  | 'checkpoint_commit_failed'
  | 'branch_delete_failed';

export interface WorkspaceTeardownErrorContext {
  readonly runId?: string;
  readonly runKind?: WorkspaceRunKind;
  readonly terminalStep?: string;
  readonly action?: 'validate' | 'checkpoint' | 'prune' | 'delete_branch';
  readonly targetPath?: string;
  readonly expectedBranch?: string;
  readonly actualBranch?: string | null;
  readonly cause?: WorkspaceErrorCauseSummary;
}

export class WorkspaceTeardownError extends Error {
  readonly code: WorkspaceTeardownErrorCode;
  readonly context?: WorkspaceTeardownErrorContext;

  constructor(code: WorkspaceTeardownErrorCode, message: string, context?: WorkspaceTeardownErrorContext) {
    super(message);
    this.name = 'WorkspaceTeardownError';
    this.code = code;
    if (context !== undefined) {
      this.context = context;
    }
  }
}

// --- Public entrypoints ---

export async function pruneWorkspacePath(request: PruneWorkspacePathRequest): Promise<WorkspacePruneResult> {
  const driver = createNodeWorkspaceDriver();
  const pruner = createWorkspacePruner({ driver });
  return pruner.pruneWorkspacePath(request);
}

export async function teardownWorkspace(request: TeardownWorkspaceRequest): Promise<WorkspaceTeardownResult> {
  const driver = createNodeWorkspaceDriver();
  const pruner = createWorkspacePruner({ driver });
  const teardown = createWorkspaceTeardown({ driver, pruner });
  return teardown.teardownWorkspace(request);
}
