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
  WorkspacePruneError,
  WorkspaceTeardownError,
  provisionWorkspace,
  pruneWorkspacePath,
  redactWorkspaceDiagnostic,
  summarizeWorkspaceCause,
  teardownWorkspace
} from './workspace.js';
export type {
  ImplementingWorkspaceRunKind,
  PruneWorkspacePathRequest,
  ProvisionWorkspaceRequest,
  ProvisionWorkspaceResult,
  TeardownWorkspaceRequest,
  WorkspaceBranchAction,
  WorkspaceBranchResult,
  WorkspaceCheckpointAction,
  WorkspaceCheckpointResult,
  WorkspaceErrorCauseSummary,
  WorkspacePruneErrorCode,
  WorkspacePruneErrorContext,
  WorkspacePruneMode,
  WorkspacePruneResult,
  WorkspacePruneStatus,
  WorkspacePrunePurpose,
  WorkspaceProvisioningErrorCauseSummary,
  WorkspaceProvisioningErrorCode,
  WorkspaceProvisioningErrorContext,
  WorkspaceProvisioningRoots,
  WorkspaceProvisioningShape,
  WorkspaceRunKind,
  WorkspaceTeardownErrorCode,
  WorkspaceTeardownErrorContext,
  WorkspaceTeardownOutcome,
  WorkspaceTeardownPruneResult,
  WorkspaceTeardownResult,
  WorkspaceTerminalStep
} from './workspace.js';
