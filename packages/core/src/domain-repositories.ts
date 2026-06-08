import type {
  Artifact,
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
  Message,
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
}

export interface RecordRunStepTransitionResult {
  readonly run: Run;
  readonly runStep: RunStep;
}

export interface RunRepository {
  create(input: CreateRunInput): Promise<Run>;
  findById(id: string): Promise<Run | null>;
  findActiveByTopic(topicId: string): Promise<Run | null>;
  listByTopic(topicId: string): Promise<readonly Run[]>;
  recordRunLifecycleStart(input: RecordRunLifecycleStartInput): Promise<RecordRunLifecycleStartResult>;
  recordRunStepTransition(input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult>;
}

export interface ArtifactRepository {
  create(input: CreateArtifactInput): Promise<Artifact>;
  findById(id: string): Promise<Artifact | null>;
  listByRun(runId: string): Promise<readonly Artifact[]>;
}

export interface FeedbackRepository {
  create(input: CreateFeedbackInput): Promise<Feedback>;
  findById(id: string): Promise<Feedback | null>;
  listByRun(runId: string): Promise<readonly Feedback[]>;
}

export interface PublicationRepository {
  create(input: CreatePublicationInput): Promise<Publication>;
  findById(id: string): Promise<Publication | null>;
  listByRun(runId: string): Promise<readonly Publication[]>;
}

export interface PullRequestRepository {
  create(input: CreatePullRequestInput): Promise<PullRequest>;
  findById(id: string): Promise<PullRequest | null>;
  findByRun(runId: string): Promise<PullRequest | null>;
}

export interface RunStepRepository {
  create(input: CreateRunStepInput): Promise<RunStep>;
  findById(id: string): Promise<RunStep | null>;
  listByRun(runId: string): Promise<readonly RunStep[]>;
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
}

export interface CreateConversationTopicMessageAndRunInput {
  readonly conversation: CreateConversationInput;
  readonly topic: Omit<CreateTopicInput, 'conversationId'>;
  readonly message?: Omit<CreateMessageInput, 'topicId'>;
  readonly run: Omit<CreateRunInput, 'topicId' | 'currentStep' | 'terminal'>;
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
