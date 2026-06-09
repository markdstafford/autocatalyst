export const executionPackageName = '@autocatalyst/execution' as const;

export {
  createExecutionMaterializer,
  type ExecutionMaterializer,
  type ExecutionMaterializerOptions
} from './internal/execution-materializer.js';

export {
  RunnerProtocolError,
  type Runner,
  type RunnerCloseResult,
  type RunnerProtocolErrorCode,
  type RunnerRunInput
} from './runner.js';

export {
  ExecutionMaterializationError,
  type ExecutionMaterializationErrorCode,
  type MaterializedExecutionEnvironment,
  type MaterializedWorkspace
} from './materialized-environment.js';

export {
  sanitizeSecretResolutionCause,
  type ExecutionSecretResolver
} from './secret-resolver.js';

export {
  createExecutionEntryPoint,
  type CreateExecutionEntryPointOptions,
  type ExecutionEntryPoint,
  type ExecutionEntryPointInput
} from './execution-entry-point.js';

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
