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
  composeAgentProviderAdapterRegistry
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
  ComposeAgentProviderAdapterRegistryInput
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
  LifecycleRunStepInput,
  RecordRunLifecycleStartInput,
  RecordRunLifecycleStartResult,
  RecordRunStepTransitionInput,
  RecordRunStepTransitionResult
} from './domain-repositories.js';

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
  WorkspaceResolverInput,
  ExecutionContextResolutionErrorCode
} from './execution-context-resolver.js';

export { consumeRunnerEventStream } from './runner-event-stream.js';
export type {
  ConsumeRunnerEventStreamOptions,
  ConsumeRunnerEventStreamResult
} from './runner-event-stream.js';

export { createExecutionRunUnitOfWork } from './execution-run-unit-of-work.js';
export type { ExecutionRunUnitOfWorkOptions, ExecutionRunUnitOfWork } from './execution-run-unit-of-work.js';

export { consumeRunnerEvents } from './runner-event-consumer.js';
export type {
  ConsumeRunnerEventsInput,
  ConsumeRunnerEventsResult,
  RunnerEventConsumerDependencies
} from './runner-event-consumer.js';
