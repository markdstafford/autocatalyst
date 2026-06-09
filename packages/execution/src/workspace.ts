import type { Project } from '@autocatalyst/api-contract';

import { createNodeWorkspaceDriver } from './internal/workspace-driver.js';
import { createWorkspaceProvisioner } from './internal/workspace-provisioner.js';

export type WorkspaceRunKind = 'feature' | 'enhancement' | 'bug' | 'chore' | 'file_issue' | 'question';
export type ImplementingWorkspaceRunKind = 'feature' | 'enhancement' | 'bug' | 'chore';
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

export interface WorkspaceProvisioningErrorCauseSummary {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

export interface WorkspaceProvisioningErrorContext {
  readonly runId?: string;
  readonly shape?: WorkspaceProvisioningShape;
  readonly targetPath?: string;
  readonly root?: string;
  readonly rootKind?: 'workspace' | 'repos';
  readonly intent?: 'write' | 'delete' | 'git';
  readonly expectedBranch?: string;
  readonly actualBranch?: string | null;
  readonly cause?: WorkspaceProvisioningErrorCauseSummary;
  readonly rollbackCause?: WorkspaceProvisioningErrorCauseSummary;
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

export function summarizeWorkspaceCause(cause: unknown): WorkspaceProvisioningErrorCauseSummary {
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
  const provisioner = createWorkspaceProvisioner({ driver: createNodeWorkspaceDriver() });
  return provisioner.provisionWorkspace(request);
}
