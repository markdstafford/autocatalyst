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
  RunListCursor,
  RunArchiveFilter,
  RunStatus,
  RunStep,
  RunWaitingOn,
  StoredSession,
  ModelRateRecord,
  TestResult,
  Topic
} from '@autocatalyst/api-contract';

/**
 * Mutable fields of a project that may be changed through the update API. Distinct
 * from {@link CreateProjectInput}: it carries only client-updatable fields and never
 * `owner`, `tenant`, `repoUrl`, `hostRepository`, or `workspaceRootOverride`.
 * A present key (including an explicit `null` for a setting) is applied; an absent
 * key is left unchanged.
 */
export interface UpdateProjectInput {
  readonly displayName?: string;
  readonly issueTrackerSetting?: Project['issueTrackerSetting'];
  readonly codeHostSetting?: Project['codeHostSetting'];
  readonly credentialRefs?: Project['credentialRefs'];
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  /** Global lookup by id, used by orchestrator/workspace resolution. */
  findById(id: string): Promise<Project | null>;
  /** Tenant-scoped lookup; returns null for missing and cross-tenant ids. */
  findById(tenant: string, id: string): Promise<Project | null>;
  /** Tenant-scoped list. */
  list(tenant: string): Promise<readonly Project[]>;
  /** Tenant-scoped update of mutable fields; returns null for missing/cross-tenant ids. */
  update(tenant: string, id: string, input: UpdateProjectInput): Promise<Project | null>;
}

export interface ConversationRepository {
  create(input: CreateConversationInput): Promise<Conversation>;
  findById(id: string): Promise<Conversation | null>;
  setActiveTopic(conversationId: string, topicId: string): Promise<Conversation>;
}

export interface TopicRepository {
  /** Update only the title of a tenant-owned topic; return null for absent or foreign IDs. */
  updateTitle?(tenant: string, id: string, title: string): Promise<Topic | null>;
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

export class RunTransitionConflictError extends Error {
  constructor(readonly code: 'missing_run' | 'terminal_run' | 'source_step_mismatch' | 'source_occurrence_mismatch') {
    super('Run transition source changed.');
    this.name = 'RunTransitionConflictError';
  }
}

export class ArchivedRunRecoveryError extends Error {
  constructor() {
    super('Unarchive the run before recovering it.');
    this.name = 'ArchivedRunRecoveryError';
  }
}

export interface RunReadContext {
  readonly projectId: string;
  readonly title?: string;
}

export interface RecordRunStepTransitionInput {
  readonly expectedStep: string;
  readonly abandonInput?: boolean;
  readonly runId: string;
  readonly currentStep: string;
  readonly terminal: boolean;
  readonly runStep: LifecycleRunStepInput;
  readonly sourceRunStepId?: string;
  /** Final checkpoint for the occurrence being closed. */
  readonly checkpointResult?: JsonValue;
  /** Initial checkpoint for the occurrence being opened in the same transition. */
  readonly destinationCheckpointResult?: JsonValue;
  readonly publicationProvenance?: { readonly pullRequestId: string; readonly headSha: string };
  readonly failureReason?: string;
}

export interface RecordRunStepTransitionResult {
  readonly run: Run;
  readonly runStep: RunStep;
}

/**
 * Atomic reopen of a failed terminal run. Moves the run back to the re-dispatch step,
 * clears terminality and failure reason, and opens a new RunStep row while leaving all
 * earlier (including the terminal `failed`) rows untouched. Implementations must enforce
 * the one-active-run-per-topic invariant inside the transaction and surface an active-run
 * conflict rather than assembling the writes separately in the service.
 */
export interface RecoverFailedRunInput {
  readonly runId: string;
  readonly reDispatchStep: string;
  readonly runStep: LifecycleRunStepInput;
  readonly destinationCheckpointResult?: JsonValue;
}

export interface RecoverFailedRunResult {
  readonly run: Run;
  readonly runStep: RunStep;
}

/**
 * Server-side filters for the run collection read. Archive visibility is a single mode; the other
 * fields are de-duplicated sets of comma-separated values. Items within a field combine with OR;
 * different fields combine with AND. All filtering happens in the SQL query before page selection.
 */
export interface ListRunsByTenantFilters {
  readonly archived?: RunArchiveFilter;
  readonly status?: readonly RunStatus[];
  readonly waitingOn?: readonly RunWaitingOn[];
  readonly workKind?: readonly string[];
  readonly projectId?: readonly string[];
}

export interface ListRunsByTenantOptions {
  readonly limit?: number;
  /** Ordered-position cursor for the next page (decoded from the opaque client cursor). */
  readonly cursor?: RunListCursor;
  readonly filters?: ListRunsByTenantFilters;
}

/**
 * One page of the filtered run collection. `nextCursor` is present only when at least one further
 * matching row exists beyond this page.
 */
export interface ListRunsByTenantResult {
  readonly runs: readonly Run[];
  readonly nextCursor?: RunListCursor;
}

export interface RunRepository {
  setArchived?(runId: string, tenant: string, archivedAt: string | null): Promise<Run | null>;
  resolveRunContext?(runId: string): Promise<RunReadContext | null>;
  create(input: CreateRunInput): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  findActiveByTopic(topicId: string): Promise<Run | null>;
  listByTopic(topicId: string): Promise<readonly Run[]>;
  listByTenant(tenant: string, options?: ListRunsByTenantOptions): Promise<ListRunsByTenantResult>;
  /**
   * Resolve the owning project id for a single run through its topic and conversation in a
   * constant number of queries. Returns null when the run, its topic, or its conversation is
   * missing (a data-integrity signal). Optional so in-memory test doubles need not implement it.
   */
  resolveProjectId?(runId: string): Promise<string | null>;
  /**
   * List every non-terminal run across all tenants. Used by startup reconciliation to
   * find runs whose on-disk workspace may need to be recreated. Optional so in-memory
   * test doubles need not implement it.
   */
  listNonTerminal?(): Promise<readonly Run[]>;
  recordRunLifecycleStart(input: RecordRunLifecycleStartInput): Promise<RecordRunLifecycleStartResult>;
  recordRunStepTransition(input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult>;
  findLatestOpenRunStep?(input: { runId: string; step: string }): Promise<RunStep | null>;
  /**
   * Atomically reopen a failed terminal run at the re-dispatch step. Optional so in-memory
   * test doubles need not implement it; the control-plane service requires it to be present
   * when recovering a run.
   */
  recoverFailedRun?(input: RecoverFailedRunInput): Promise<RecoverFailedRunResult>;
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

export interface FeedbackAnchorOffsetsPersistenceInput {
  readonly feedbackId: string;
  readonly from: number;
  readonly to: number;
}

export interface SpecReviewAnchorPersistenceInput {
  readonly feedbackId: string;
  readonly runId: string;
  readonly tenant: string;
  readonly artifactId: string;
  readonly anchor: Extract<Feedback['anchor'], { kind: 'artifact_range' }> | null;
}

export interface FeedbackRepository {
  /** Host-created, retryable model finding. The supplied ID comes from convergence state only. */
  createSpecReviewFinding?(id: string, input: CreateFeedbackInput): Promise<Feedback>;
  bindSpecReviewAnchor?(input: SpecReviewAnchorPersistenceInput): Promise<void>;
  create(input: CreateFeedbackInput): Promise<Feedback>;
  findById(id: string): Promise<Feedback | null>;
  listByRun(runId: string): Promise<readonly Feedback[]>;
  updateStatusAndAppendThread(input: FeedbackStatusTransitionPersistenceInput): Promise<Feedback>;
  appendThreadEntry(input: FeedbackThreadAppendPersistenceInput): Promise<Feedback>;
  /**
   * Persist repaired `from`/`to` offsets on an existing `artifact_range` anchor (read-side spec
   * anchor reconciliation, ADR-033). Optional so existing test doubles need not implement it; when
   * absent, read-side repairs are returned in responses but not persisted. Implementations must
   * leave status, thread, quotedText, and all other fields untouched.
   */
  updateAnchorOffsets?(input: FeedbackAnchorOffsetsPersistenceInput): Promise<Feedback>;
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
  readonly after?: { readonly createdAt: string; readonly id: string };
  readonly tenant: string;
  readonly limit: number;
}

/** A tenant-owned PR exists but its state did not match the guarded write. */
export class PullRequestStateConflictError extends Error {
  constructor() {
    super('PullRequest state mismatch.');
    this.name = 'PullRequestStateConflictError';
  }
}

export interface PullRequestRepository {
  create(input: CreatePullRequestInput): Promise<PullRequest>;
  findById(id: string): Promise<PullRequest | null>;
  findByRun(runId: string): Promise<PullRequest | null>;
  /** Throws PullRequestStateConflictError only on an existing row’s expectedState mismatch. */
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
  create(input: CreateSessionInput, attemptId?: string): Promise<StoredSession>;
  findById(id: string): Promise<StoredSession | null>;
  listByRun(runId: string): Promise<readonly StoredSession[]>;
  readPricingSnapshot?(tenant: string, runId: string): Promise<{
    sessions: readonly StoredSession[];
    history: readonly ModelRateRecord[];
  }>;
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
  readonly provisionedBaseRef?: string | null;
  readonly createdAt: string;
}

export interface RunWorkspaceMetadata {
  readonly runId: string;
  readonly workspaceHandle: string;
  readonly workspaceRepoRoot: string;
  readonly provisionedBaseRef?: string | null;
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
