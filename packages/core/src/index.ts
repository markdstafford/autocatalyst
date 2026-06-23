export { getHealth } from './health.js';
export type { HealthDependencyChecker } from './health.js';
export { createProbeResource, getProbeResource } from './probe-resource.js';
export type { ProbeResourceRepository } from './probe-resource.js';
export { registerControlPlaneRoutes } from './routes.js';
export type { ControlPlaneRouteDependencies } from './routes.js';

export { hardcodedDevelopmentPrincipal, attachPrincipalToRequest, getPrincipalFromRequest, requirePrincipalFromRequest } from './principal.js';

export { registerBearerAuthHook } from './auth.js';
export type { BearerAuthOptions } from './auth.js';

export { permissivePolicyDecisionPoint, authorizeRequest } from './policy.js';
export type { PolicyDecisionPoint, PolicyDecisionInput, PolicyDecision, PolicyAction, PolicyResourceDescriptor } from './policy.js';

export { createConfigurationRecord, listConfigurationRecords, getConfigurationRecord, updateConfigurationRecord, deleteConfigurationRecord } from './configuration-record.js';
export type { ConfigurationRecordRepository, CreateConfigurationRecordInput, UpdateConfigurationRecordInput } from './configuration-record.js';

export { createSecret, SecretStoreLockedError, SecretResolutionError } from './secret.js';
export type { SecretStore, CreateSecretInput, SecretResolver, SecretResolutionErrorCode, SecretResolutionErrorDetails } from './secret.js';

export {
  InMemoryExtensionRegistryCatalog,
  createExtensionRegistryCatalog,
  defaultExtensionRegistryCatalog,
  validateProviderConfigurationAgainstRegistry
} from './extension-registry.js';
export type {
  ExtensionRegistryEntry,
  ExtensionRegistryCatalog,
  ProviderConfigurationWarningCode,
  ProviderConfigurationWarning
} from './extension-registry.js';

export {
  buildProviderAdapterKey,
  emptyProviderAdapterMap,
  composeConfiguredProviders,
  composeAgentProviderAdapterRegistry,
  composeDirectProviderAdapterRegistry
} from './provider-composition.js';
export type {
  ProviderAdapterFactoryInput,
  ProviderPortBinding,
  ProviderAdapterFactory,
  ProviderAdapterMap,
  ProviderCompositionUnresolvedReason,
  ProviderCompositionUnresolved,
  ProviderCompositionResult,
  ComposeConfiguredProvidersInput,
  ComposeAgentProviderAdapterRegistryInput,
  ComposeDirectProviderAdapterRegistryInput
} from './provider-composition.js';

export type {
  ArtifactRepository,
  ConversationRepository,
  DomainRepositories,
  FeedbackRepository,
  MessageRepository,
  ProjectRepository,
  PublicationRepository,
  PullRequestRepository,
  RunRepository,
  RunStepRepository,
  SessionRepository,
  TestResultRepository,
  TopicRepository
} from './domain-repositories.js';

export type {
  ConversationIngressRepository,
  CreateConversationTopicMessageAndRunInput,
  CreateConversationTopicMessageAndRunResult,
  FeedbackStatusTransitionPersistenceInput,
  FeedbackThreadAppendPersistenceInput,
  FeedbackThreadEntryPersistenceInput,
  LifecycleRunStepInput,
  ListRunsByTenantOptions,
  RecordRunLifecycleStartInput,
  RecordRunLifecycleStartResult,
  RecordRunStepTransitionInput,
  RecordRunStepTransitionResult,
  ListOpenPullRequestsInput,
  RunWorkspaceMetadata,
  RunWorkspaceMetadataRepository,
  UpsertRunWorkspaceMetadataInput,
  UpdatePullRequestStateInput,
  UpdateRunStepCheckpointInput
} from './domain-repositories.js';

export { FeedbackConcurrentModificationError } from './domain-repositories.js';

export {
  deriveRunTerminal,
  getRunStepDefinition,
  isKnownRunStepId,
  messageAcceptingSteps,
  modelActiveSteps,
  runStepCatalog,
  runStepDefinitions,
  runStepIds,
  terminalSteps
} from './run-step-catalog.js';
export type { RunPhase, RunStepDefinition, RunStepId, RunStepRole, WaitingOn } from './run-step-catalog.js';

export * from './convergence-policy.js';

export {
  validateReviewerResult,
  type ValidateReviewerResultInput,
  type ReviewerResultValidationOutcome,
  type ReviewerResultValidationSuccess,
  type ReviewerResultValidationFailure
} from './reviewer-result-validation.js';

export {
  getRunWorkflowById,
  getRunWorkflowForWorkKind,
  isKnownRunWorkflowId,
  runWorkflowIds,
  runWorkflows
} from './run-workflows.js';
export type { RunArtifactKind, RunDirective, RunWorkflowDefinition, RunWorkflowId, WorkflowTransitionTable } from './run-workflows.js';

export { nextWorkflowStep } from './run-transition.js';
export type { TransitionErrorCode, TransitionResult } from './run-transition.js';

export { RunLifecycleError, applyRunDirective, buildEntryRunStep, startRunLifecycle } from './run-lifecycle.js';
export type { ApplyRunDirectiveInput, RunLifecycleErrorCode, RunLifecycleState, StartRunLifecycleInput } from './run-lifecycle.js';

export * from './run-events.js';

export * from './run-dispatch-queue.js';

export * from './orchestrator.js';

export * from './control-plane-service.js';

export {
  createExecutionContextResolver,
  ExecutionContextResolutionError
} from './execution-context-resolver.js';
export type {
  ExecutionContextResolver,
  CreateExecutionContextResolverOptions,
  ExecutionContextPromptCallback,
  ExecutionContextTaskInputsCallback,
  WorkspaceResolverInput,
  ExecutionContextResolutionErrorCode
} from './execution-context-resolver.js';

export { consumeRunnerEventStream } from './runner-event-stream.js';
export type {
  ConsumeRunnerEventStreamOptions,
  ConsumeRunnerEventStreamResult
} from './runner-event-stream.js';

export { safeFailureReasonFromError } from './safe-failure-reason.js';

export { createExecutionRunUnitOfWork } from './execution-run-unit-of-work.js';
export type {
  ExecutionRunUnitOfWorkOptions,
  ExecutionRunUnitOfWork,
  DirectStepExecutionPort,
  DirectStepWorkInput,
  ExecutionModeResolution
} from './execution-run-unit-of-work.js';

export { consumeRunnerEvents } from './runner-event-consumer.js';
export type {
  ConsumeRunnerEventsInput,
  ConsumeRunnerEventsResult,
  RunnerEventConsumerDependencies
} from './runner-event-consumer.js';

export {
  SpecFrontmatterError,
  parseSpecFrontmatter,
  renderSpecFrontmatter,
  validateCommittedSpecFrontmatter,
  renderCommittedSpecMarkdown
} from './spec-frontmatter.js';
export type { SpecFrontmatterErrorCode, SpecMarkdownRenderErrorCode, RenderCommittedSpecMarkdownInput } from './spec-frontmatter.js';

export {
  ModelRoutingConfigurationError,
  createModelRoutingResolver,
  type ModelRoutingResolver,
  type CreateModelRoutingResolverOptions,
  type ModelRoutingConfigurationReader,
  type ResolveAgentRouteInput,
  type ResolveDirectRouteInput,
  type ResolveDistinctAgentRoutesInput,
  type ModelRoutingResolution,
  type ModelRoutingDistinctResolution,
  type ModelRoutingSafeDetails
} from './model-routing-resolver.js';

export {
  SpecAuthoringError,
  completeSpecAuthoring
} from './spec-authoring-service.js';

export {
  FeedbackLifecycleError,
  createArtifactFeedback,
  addressFeedback,
  markFeedbackWontFix,
  resolveFeedback,
  reopenFeedback,
  listBlockingFeedback,
  resolveApproverAddressedFeedback,
  appendFeedbackThreadReply,
  type AppendFeedbackThreadReplyInput,
  type FeedbackLifecycleDependencies
} from './feedback-lifecycle.js';

export {
  SpecReviewGateBlockedError,
  assertSpecReviewGateCanAdvance
} from './spec-review-gate.js';
export type {
  SpecAuthoringErrorCode,
  WorkspaceFileSystemPort,
  WorkspaceGitPort,
  SpecAuthoringServiceDependencies,
  CompleteSpecAuthoringInput,
  CompleteSpecAuthoringOutput
} from './spec-authoring-service.js';

export {
  SpecApprovalError,
  finalizeSpecApproval,
  type FinalizeSpecApprovalInput,
  type SpecApprovalFinalizerDependencies,
  type SpecApprovalErrorCode
} from './spec-approval-finalizer.js';

export * from './spec-freeze.js';

export * from './convergence-engine.js';

export { createLayeredConvergenceEngine } from './layered-convergence-engine.js';
export type { LayeredConvergenceEngineOptions } from './layered-convergence-engine.js';

export * from './reviewed-role-dispatcher.js';

export * from './run-workspace-git.js';

export { validateAltitudeContract } from './altitude-contract-validator.js';
export type { ValidateAltitudeContractInput } from './altitude-contract-validator.js';

export {
  validateBuildContractPreservation,
  extractPublicContracts,
  extractPrivateContracts,
  canonicalizeSignature
} from './build-contract-preservation.js';
export type {
  ValidateBuildContractInput,
  ExtractedContract,
  ExtractedContractEntry
} from './build-contract-preservation.js';

export { filterAltitudeFindings } from './layered-finding-filter.js';
export type { FilterAltitudeFindingsInput } from './layered-finding-filter.js';

export {
  createConvergenceFeedback,
  createReviewerFeedback
} from './convergence-feedback.js';
export type {
  ConvergenceFeedbackInput,
  ConvergenceFeedbackResult,
  ReviewerFeedbackCreationInput,
  ReviewerFeedbackCreationResult
} from './convergence-feedback.js';

export {
  SpecAuthorContextError,
  assertSupportedSpecAuthorWorkKind,
  buildSpecAuthorContext,
  buildSpecAuthorPrompt,
  buildSpecAuthorTaskInputs,
  toSafeDetails
} from './spec-authoring-context.js';
export type {
  SpecAuthorContext,
  SpecAuthorContextErrorCode,
  SpecAuthorExpectedKind,
  SpecAuthorLinkedIssueContext,
  SpecAuthorOutputContractInput,
  SpecAuthorPromptInput,
  SpecAuthorRequestContext,
  SpecAuthorRevisionFeedback,
  SpecAuthorSupportedWorkKind,
  SpecAuthorTaskInputs
} from './spec-authoring-context.js';

export {
  buildImplementationBuildContext,
  buildImplementationBuildPrompt,
  buildImplementationBuildTaskInputs,
  implementationBuildResultFile
} from './implementation-build-context.js';
export type {
  ImplementationBuildApprovedSpecContext,
  ImplementationBuildContext,
  ImplementationBuildPromptInput,
  ImplementationBuildReviewContext,
  ImplementationBuildRole,
  ImplementationBuildTaskInputs
} from './implementation-build-context.js';

export { IssueTrackerError } from './issue-tracker.js';
export type { IssueTrackerErrorCode, IssueTrackerErrorOptions, IssueTrackerPort, IssueTrackerTarget, ReadTrackedIssueInput } from './issue-tracker.js';
export { StaticIssueTrackerRegistry } from './issue-tracker-registry.js';
export type { IssueTrackerRegistry } from './issue-tracker-registry.js';

export * from './code-host.js';
export * from './code-host-registry.js';

export { DefaultIssueReferenceIntakeResolver, IssueReferenceIntakeError } from './issue-reference-intake.js';
export type {
  IssueReferenceIntakeErrorCode,
  IssueReferenceIntakeResolver,
  ResolveConversationCreateInput,
  ResolvedConversationCreate,
  DefaultIssueReferenceIntakeResolverOptions
} from './issue-reference-intake.js';

export * from './conventional-title.js';
export * from './implementation-summary.js';
export * from './pr-content.js';
export * from './pr-finalize.js';
export {
  validatePullRequestFinalizeResult,
  type ValidatePullRequestFinalizeResultInput,
  type PullRequestFinalizeResultValidationOutcome,
  type PullRequestFinalizeResultValidationSuccess,
  type PullRequestFinalizeResultValidationFailure
} from './pr-finalize-result-validation.js';
export * from './pr-open-handler.js';
export * from './pr-lifecycle.js';

export * from './execution-session-recorder.js';

export {
  deriveAgentModelMemoryKey,
  createRunStepAgentModelMemoryStore,
  type AgentModelMemoryKeyInput,
  type RunStepAgentModelMemoryStoreInput
} from './provider-model-memory.js';
