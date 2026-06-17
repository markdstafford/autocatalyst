import type {
  Artifact,
  ArtifactCachedStatus,
  ArtifactKind,
  Conversation,
  CreateArtifactInput,
  CreateConversationInput,
  CreateFeedbackInput,
  CreateMessageInput,
  CreateProjectInput,
  CreatePublicationInput,
  CreatePullRequestInput,
  CreateRunInput,
  CreateRunStepInput,
  CreateSessionInput,
  CreateTestResultInput,
  CreateTopicInput,
  Feedback,
  FeedbackStatus,
  JsonValue,
  Message,
  NonModelPrincipal,
  Project,
  Publication,
  PullRequest,
  Run,
  RunStep,
  Session,
  TestResult,
  Topic
} from '@autocatalyst/api-contract';

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
}

export interface ConversationRepository {
  create(input: CreateConversationInput): Promise<Conversation>;
  findById(id: string): Promise<Conversation | null>;
  setActiveTopic(conversationId: string, topicId: string): Promise<Conversation>;
}

export interface TopicRepository {
  create(input: CreateTopicInput): Promise<Topic>;
  findById(id: string): Promise<Topic | null>;
  listByConversation(conversationId: string): Promise<readonly Topic[]>;
}

export interface MessageRepository {
  create(input: CreateMessageInput): Promise<Message>;
  findById(id: string): Promise<Message | null>;
  listByTopic(topicId: string): Promise<readonly Message[]>;
}

export type LifecycleRunStepInput = Omit<CreateRunStepInput, 'runId' | 'occurrence'>;

export interface RecordRunLifecycleStartInput {
  readonly run: CreateRunInput;
  readonly runStep: LifecycleRunStepInput;
}

export interface RecordRunLifecycleStartResult {
  readonly run: Run;
  readonly runStep: RunStep;
}

export interface RecordRunStepTransitionInput {
  readonly runId: string;
  readonly currentStep: string;
  readonly terminal: boolean;
  readonly runStep: LifecycleRunStepInput;
  readonly sourceRunStepId?: string;
  readonly checkpointResult?: JsonValue;
  readonly failureReason?: string;
}

export interface RecordRunStepTransitionResult {
  readonly run: Run;
  readonly runStep: RunStep;
}

export interface ListRunsByTenantOptions {
  readonly limit?: number;
}

export interface RunRepository {
  create(input: CreateRunInput): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  findActiveByTopic(topicId: string): Promise<Run | null>;
  listByTopic(topicId: string): Promise<readonly Run[]>;
  listByTenant(tenant: string, options?: ListRunsByTenantOptions): Promise<readonly Run[]>;
  recordRunLifecycleStart(input: RecordRunLifecycleStartInput): Promise<RecordRunLifecycleStartResult>;
  recordRunStepTransition(input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult>;
  findLatestOpenRunStep?(input: { runId: string; step: string }): Promise<RunStep | null>;
}

export interface ArtifactRepository {
  create(input: CreateArtifactInput): Promise<Artifact>;
  findById(id: string): Promise<Artifact | null>;
  listByRun(runId: string): Promise<readonly Artifact[]>;
  findByRunAndKind(input: { readonly runId: string; readonly kind: ArtifactKind }): Promise<Artifact | null>;
  updateCachedStatus(input: { readonly artifactId: string; readonly cachedStatus: ArtifactCachedStatus; readonly updatedAt: string }): Promise<Artifact>;
}

export interface FeedbackThreadEntryPersistenceInput {
  readonly id: string;
  readonly author: NonModelPrincipal;
  readonly body: string;
  readonly createdAt: string;
}

export interface FeedbackStatusTransitionPersistenceInput {
  readonly feedbackId: string;
  readonly expectedStatus: FeedbackStatus;
  readonly nextStatus: FeedbackStatus;
  readonly threadEntry: FeedbackThreadEntryPersistenceInput;
  readonly updatedAt: string;
}

export class FeedbackConcurrentModificationError extends Error {
  readonly code = 'feedback_concurrent_modification' as const;
  readonly feedbackId: string;
  readonly expectedStatus: FeedbackStatus;
  readonly actualStatus: FeedbackStatus | undefined;

  constructor(feedbackId: string, expectedStatus: FeedbackStatus, actualStatus?: FeedbackStatus) {
    super('Feedback status changed before transition could be persisted.');
    this.name = 'FeedbackConcurrentModificationError';
    this.feedbackId = feedbackId;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
  }
}

export interface FeedbackThreadAppendPersistenceInput {
  readonly feedbackId: string;
  readonly threadEntry: FeedbackThreadEntryPersistenceInput;
  readonly updatedAt: string;
}

export interface FeedbackRepository {
  create(input: CreateFeedbackInput): Promise<Feedback>;
  findById(id: string): Promise<Feedback | null>;
  listByRun(runId: string): Promise<readonly Feedback[]>;
  updateStatusAndAppendThread(input: FeedbackStatusTransitionPersistenceInput): Promise<Feedback>;
  appendThreadEntry(input: FeedbackThreadAppendPersistenceInput): Promise<Feedback>;
}

export interface PublicationRepository {
  create(input: CreatePublicationInput): Promise<Publication>;
  findById(id: string): Promise<Publication | null>;
  listByRun(runId: string): Promise<readonly Publication[]>;
}

export interface UpdatePullRequestStateInput {
  readonly runId: string;
  readonly tenant: string;
  readonly state: PullRequest['state'];
  readonly updatedAt: string;
  readonly expectedState?: PullRequest['state'];
}

export interface ListOpenPullRequestsInput {
  readonly tenant: string;
  readonly limit: number;
}

export interface PullRequestRepository {
  create(input: CreatePullRequestInput): Promise<PullRequest>;
  findById(id: string): Promise<PullRequest | null>;
  findByRun(runId: string): Promise<PullRequest | null>;
  updateState(input: UpdatePullRequestStateInput): Promise<PullRequest>;
  listOpen(input: ListOpenPullRequestsInput): Promise<readonly PullRequest[]>;
}

export interface UpdateRunStepCheckpointInput {
  readonly runStepId: string;
  readonly runId: string;
  readonly tenant: string;
  readonly checkpointResult: JsonValue;
  readonly expectedUpdatedAt?: string;
}

export interface RunStepRepository {
  create(input: CreateRunStepInput): Promise<RunStep>;
  findById(id: string): Promise<RunStep | null>;
  listByRun(runId: string): Promise<readonly RunStep[]>;
  updateCheckpoint(input: UpdateRunStepCheckpointInput): Promise<RunStep>;
}

export interface SessionRepository {
  create(input: CreateSessionInput): Promise<Session>;
  findById(id: string): Promise<Session | null>;
  listByRun(runId: string): Promise<readonly Session[]>;
}

export interface TestResultRepository {
  create(input: CreateTestResultInput): Promise<TestResult>;
  findById(id: string): Promise<TestResult | null>;
  listByRun(runId: string): Promise<readonly TestResult[]>;
}

export interface UpsertRunWorkspaceMetadataInput {
  readonly runId: string;
  readonly workspaceHandle: string;
  readonly workspaceRepoRoot: string;
  readonly createdAt: string;
}

export interface RunWorkspaceMetadata {
  readonly runId: string;
  readonly workspaceHandle: string;
  readonly workspaceRepoRoot: string;
  readonly createdAt: string;
}

/** Internal-only repository for persisting workspace paths across server restarts.
 *  The workspaceRepoRoot field is never exposed through public API responses. */
export interface RunWorkspaceMetadataRepository {
  upsert(input: UpsertRunWorkspaceMetadataInput): Promise<void>;
  findByRunId(runId: string): Promise<RunWorkspaceMetadata | null>;
}

export interface DomainRepositories {
  projects: ProjectRepository;
  conversations: ConversationRepository;
  topics: TopicRepository;
  messages: MessageRepository;
  runs: RunRepository;
  artifacts: ArtifactRepository;
  feedback: FeedbackRepository;
  publications: PublicationRepository;
  pullRequests: PullRequestRepository;
  runSteps: RunStepRepository;
  sessions: SessionRepository;
  testResults: TestResultRepository;
  runWorkspaceMetadata: RunWorkspaceMetadataRepository;
}

export interface CreateConversationTopicMessageAndRunInput {
  readonly conversation: CreateConversationInput;
  readonly topic: Omit<CreateTopicInput, 'conversationId'>;
  readonly message?: Omit<CreateMessageInput, 'topicId'>;
  readonly run: Omit<CreateRunInput, 'topicId'>;
  readonly runStep: LifecycleRunStepInput;
}

export interface CreateConversationTopicMessageAndRunResult {
  readonly conversation: Conversation;
  readonly topic: Topic;
  readonly message?: Message;
  readonly run: Run;
  readonly runStep: RunStep;
}

export interface ConversationIngressRepository {
  createConversationTopicMessageAndRun(
    input: CreateConversationTopicMessageAndRunInput
  ): Promise<CreateConversationTopicMessageAndRunResult>;
}
