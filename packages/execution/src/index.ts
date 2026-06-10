export const executionPackageName = '@autocatalyst/execution' as const;

export {
  createStepResultContractRegistry,
  resolveStepResultContract,
  type StepResultContractDefinition,
  type StepResultContractRegistry,
  type StepResultContractResolver,
  type StepResultContractResolution,
  type StepResultContractResolutionFailure
} from './result-contracts.js';

export {
  validateStepResult,
  defaultStepResultCorrectionMaxAttempts,
  type ValidateStepResultInput,
  type StepResultValidationOutcome,
  type StepResultValidationSuccess,
  type StepResultValidationFailure,
  type StepResultValidationFailureCode,
  type ResultValidationIssue,
  type ResultToleranceEvent,
  type ResultDegradationPolicy
} from './result-tolerance.js';

export {
  createResultNormalizerRegistry,
  defaultResultNormalizers,
  createFilenameAliasNormalizer,
  createUrlWrappedIdentifierNormalizer,
  type ResultNormalizer,
  type ResultNormalizerInput,
  type ResultNormalizerOutcome,
  type ResultNormalizerRegistry,
  type FilenameAliasNormalizerOptions,
  type UrlWrappedIdentifierNormalizerOptions
} from './result-normalizers.js';

export {
  buildResultCorrectionRequest,
  createNoopResultCorrectionRequester,
  type ResultCorrectionRequester,
  type ResultCorrectionRequest,
  type ResultCorrectionRequestInput
} from './result-correction.js';

export {
  readScratchStepResultFile,
  type ReadScratchStepResultFileInput,
  type StepResultFileReadOutcome,
  type StepResultFileReadSuccess,
  type StepResultFileReadFailure,
  type StepResultFileErrorCode
} from './result-file.js';

export { StubRunner, type StubRunnerOptions } from './stub-runner.js';

export {
  runnerProgressToolNameSchema,
  updatePlanToolInputSchema,
  reportProgressToolInputSchema,
  notifyToolInputSchema,
  type RunnerProgressToolName,
  type UpdatePlanToolInput,
  type ReportProgressToolInput,
  type NotifyToolInput
} from './runner-progress-tools.js';

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
  applyRequestAlteration,
  buildClaudeProcessLaunchEnvironment,
  claudeProviderOwnedEnvironmentVariables,
  defaultMaxRetries,
  defaultRequestTimeoutMs,
  isTransientProviderFailure,
  maximumMaxRetries,
  maximumRequestTimeoutMs,
  ProviderAlterationError,
  redactProcessLaunchConfigForLog,
  redactProviderRequestForLog,
  redactProviderResponseForLog,
  transientHttpStatuses,
  validateHttpHeaderName,
  type AlteredProviderRequest,
  type ClaudeProcessLaunchInput,
  type ClaudeProcessLaunchResult,
  type ProviderAlterationErrorCode,
  type ProviderCapabilityDegradation,
  type ProviderRequest,
  type RedactProcessLaunchConfigInput,
  type RedactProviderRequestInput,
  type RedactProviderResponseInput,
  type RequestAlterationOptions,
  type RetryPolicy
} from './request-alteration.js';

export {
  ProviderConfigurationError,
  ProviderConnectionError,
  ProviderProtocolError,
  UnsupportedProviderCapabilityError,
  type AgentConnection,
  type AgentConnectionTelemetryContext,
  type AgentProviderAdapter,
  type AgentProviderSession,
  type AgentProviderSessionInput,
  type AgentProviderSessionMetadata,
  type AgentTokenUsage,
  type ProcessLaunchConfig,
  type ProcessLaunchConfigInput,
  type ProviderConfigurationErrorCode,
  type ProviderConnectionErrorCode,
  type ProviderConnectionMechanism,
  type ProviderFetchTransport,
  type ProviderProtocolErrorCode,
  type ResolvedAgentCredentialReference,
  type ResolvedAgentRunnerProfile,
  type UnsupportedProviderCapabilityErrorCode
} from './agent-provider-adapter.js';

export {
  createAgentConnection,
  type AgentConnectionFactoryOptions,
  type ProviderConnectionLogger,
  type ProviderCredentialResolver
} from './connection.js';

export {
  createAgentOrchestratorRunner,
  type AgentOrchestratorTelemetryEmitter,
  type CreateAgentOrchestratorRunnerOptions
} from './agent-orchestrator-runner.js';

export {
  createExecutionEntryPoint,
  type CreateExecutionEntryPointOptions,
  type ExecutionEntryPoint,
  type ExecutionEntryPointInput
} from './execution-entry-point.js';

export type {
  ExecutionResultValidationConfig,
  ExecutionResultValidationResolver,
  NoExecutionResultValidationConfig,
  ScratchFileExecutionResultValidationConfig
} from './execution-entry-point.js';

export {
  executionTerminalResultEventSchema,
  executionBoundaryEventSchema,
  validateExecutionBoundaryEvent,
  validateExecutionBoundaryEventStream,
  type ExecutionTerminalResultEvent,
  type ExecutionBoundaryEvent
} from './execution-boundary-events.js';

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
