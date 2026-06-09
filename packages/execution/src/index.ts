export interface RunnerInput {
  readonly runId: string;
}

export interface RunnerResult {
  readonly runId: string;
  readonly status: 'accepted';
}

export interface Runner {
  run(input: RunnerInput): Promise<RunnerResult>;
}

export const executionPackageName = '@autocatalyst/execution' as const;

export {
  WorkspaceProvisioningError,
  provisionWorkspace,
  redactWorkspaceDiagnostic,
  summarizeWorkspaceCause
} from './workspace.js';
export type {
  ImplementingWorkspaceRunKind,
  ProvisionWorkspaceRequest,
  ProvisionWorkspaceResult,
  WorkspaceProvisioningErrorCauseSummary,
  WorkspaceProvisioningErrorCode,
  WorkspaceProvisioningErrorContext,
  WorkspaceProvisioningRoots,
  WorkspaceProvisioningShape,
  WorkspaceRunKind
} from './workspace.js';
