import { describe, expect, it, vi } from 'vitest';
import type { Artifact, Conversation, Feedback, Message, NonModelPrincipal, Run, RunStateTransitionEvent, RunStep, Topic } from '@autocatalyst/api-contract';
import type { RunReplyRequest } from '@autocatalyst/api-contract';

import type { ConversationIngressRepository, FeedbackRepository, RunRepository, RunStepRepository, RunWorkspaceMetadataRepository } from './domain-repositories.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import { SpecReviewGateBlockedError } from './spec-review-gate.js';
import { RunDispatchQueue } from './run-dispatch-queue.js';
import { InMemoryRunEventBus, type RunEventPublisher } from './run-events.js';
import {
  DefaultOrchestrator,
  OrchestratorError,
  type AutoDispatchOptions,
  type ReplyToRunInput,
  type RunUnitOfWork,
  type WorkspaceContextResolver
} from './orchestrator.js';
import type { SpecAuthoringServiceDependencies } from './spec-authoring-service.js';
import { SpecAuthoringError } from './spec-authoring-service.js';
import type { SpecApprovalFinalizerDependencies } from './spec-approval-finalizer.js';
import type { SpecFreezeDependencies, freezeRunSpecForPullRequest as freezeRunSpecForPullRequestFn } from './spec-freeze.js';
import { SpecFreezeError } from './spec-freeze.js';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';
import type { ConvergenceEngine, ConvergenceEngineInput } from './convergence-engine.js';

const timestamp = '2026-06-08T00:00:00.000Z';
const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1', displayName: 'Ada' };

function expectNoSentinels(serialized: string): void {
  expect(serialized).not.toContain('sk-test-secret');
  expect(serialized).not.toContain('authorization: Bearer');
  expect(serialized).not.toContain('/Users/mark/private');
  expect(serialized).not.toContain('sec_secret_handle_value');
  expect(serialized).not.toContain('raw SDK diagnostic');
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'intake',
    terminal: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step_1',
    runId: 'run_1',
    phase: null,
    step: 'intake',
    role: 'none',
    startedAt: timestamp,
    endedAt: null,
    durationMs: null,
    occurrence: { index: 0, attempt: 1 },
    checkpointResult: null,
    ...overrides
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    projectId: 'proj_1',
    owner,
    tenant: 'tenant_1',
    identity: 'identity_1',
    activeTopicId: 'topic_1',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic_1',
    conversationId: 'conv_1',
    owner,
    tenant: 'tenant_1',
    title: 'My topic',
    kind: 'main',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_1',
    author: owner,
    direction: 'inbound',
    body: 'Hello',
    createdAt: timestamp,
    ...overrides
  };
}

function makeFakeRunRepo(overrides: Partial<RunRepository> = {}): RunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    findActiveByTopic: vi.fn().mockResolvedValue(null),
    listByTopic: vi.fn().mockResolvedValue([]),
    listByTenant: vi.fn().mockResolvedValue([]),
    recordRunLifecycleStart: vi.fn().mockResolvedValue({ run: makeRun(), runStep: makeRunStep() }),
    recordRunStepTransition: vi.fn().mockResolvedValue({ run: makeRun(), runStep: makeRunStep() }),
    ...overrides
  };
}

function makeFakeIngressRepo(overrides: Partial<ConversationIngressRepository> = {}): ConversationIngressRepository {
  return {
    createConversationTopicMessageAndRun: vi.fn().mockResolvedValue({
      conversation: makeConversation(),
      topic: makeTopic(),
      message: makeMessage(),
      run: makeRun(),
      runStep: makeRunStep()
    }),
    ...overrides
  };
}

function makeRecordingPublisher(): { publisher: RunEventPublisher; events: RunStateTransitionEvent[] } {
  const events: RunStateTransitionEvent[] = [];
  return {
    publisher: {
      append: async (input) => { events.push(input.event as RunStateTransitionEvent); },
      replayAfter: async () => ({ status: 'ok', events: [] }),
      subscribe: () => ({ events: (async function*() {})() as unknown as AsyncIterable<RunStateTransitionEvent>, close: () => {} })
    } as unknown as RunEventPublisher,
    events
  };
}

function makeFakeRunStepRepo(overrides: Partial<RunStepRepository> = {}): RunStepRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    listByRun: vi.fn().mockResolvedValue([]),
    updateCheckpoint: vi.fn().mockResolvedValue(makeRunStep()),
    ...overrides
  };
}

function makeOrchestrator(opts: {
  runs?: RunRepository;
  conversationIngress?: ConversationIngressRepository;
  events?: RunEventPublisher;
  dispatchQueue?: RunDispatchQueue;
  unitOfWork?: RunUnitOfWork;
  clock?: () => string;
  eventIdGenerator?: () => string;
  isActiveRunConflict?: (error: unknown) => boolean;
  specAuthoringDependencies?: SpecAuthoringServiceDependencies;
  resolveWorkspaceContext?: WorkspaceContextResolver;
  resolveApproverAddressedFeedback?: (input: { runId: string; target: 'artifact'; approver: NonModelPrincipal }, deps: FeedbackLifecycleDependencies) => Promise<void>;
  assertSpecReviewGateCanAdvance?: (input: { run: Run }, deps: { listBlockingFeedback: (input: { runId: string; target: 'artifact' }) => Promise<readonly Feedback[]> }) => Promise<void>;
  feedbackLifecycleDependencies?: FeedbackLifecycleDependencies;
  finalizeSpecApproval?: (input: unknown, deps: SpecApprovalFinalizerDependencies) => Promise<void>;
  specApprovalFinalizerDependencies?: SpecApprovalFinalizerDependencies;
  freezeRunSpecForPullRequest?: typeof freezeRunSpecForPullRequestFn;
  specFreezeDependencies?: SpecFreezeDependencies;
  runWorkspaceMetadata?: RunWorkspaceMetadataRepository;
  runSteps?: RunStepRepository;
  convergenceEngine?: ConvergenceEngine;
  logger?: { warn: ReturnType<typeof vi.fn> };
  autoDispatch?: AutoDispatchOptions;
} = {}) {
  const runs = opts.runs ?? makeFakeRunRepo();
  const conversationIngress = opts.conversationIngress ?? makeFakeIngressRepo();
  const events = opts.events ?? new InMemoryRunEventBus();
  const dispatchQueue = opts.dispatchQueue ?? new RunDispatchQueue({ maxConcurrent: 4 });
  const orchestrator = new DefaultOrchestrator({
    runs,
    conversationIngress,
    events,
    dispatchQueue,
    ...(opts.unitOfWork !== undefined ? { unitOfWork: opts.unitOfWork } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.eventIdGenerator !== undefined ? { eventIdGenerator: opts.eventIdGenerator } : {}),
    ...(opts.isActiveRunConflict !== undefined ? { isActiveRunConflict: opts.isActiveRunConflict } : {}),
    ...(opts.specAuthoringDependencies !== undefined ? { specAuthoringDependencies: opts.specAuthoringDependencies } : {}),
    ...(opts.resolveWorkspaceContext !== undefined ? { resolveWorkspaceContext: opts.resolveWorkspaceContext } : {}),
    ...(opts.resolveApproverAddressedFeedback !== undefined ? { resolveApproverAddressedFeedback: opts.resolveApproverAddressedFeedback } : {}),
    ...(opts.assertSpecReviewGateCanAdvance !== undefined ? { assertSpecReviewGateCanAdvance: opts.assertSpecReviewGateCanAdvance } : {}),
    ...(opts.feedbackLifecycleDependencies !== undefined ? { feedbackLifecycleDependencies: opts.feedbackLifecycleDependencies } : {}),
    ...(opts.finalizeSpecApproval !== undefined ? { finalizeSpecApproval: opts.finalizeSpecApproval as typeof import('./spec-approval-finalizer.js').finalizeSpecApproval } : {}),
    ...(opts.specApprovalFinalizerDependencies !== undefined ? { specApprovalFinalizerDependencies: opts.specApprovalFinalizerDependencies } : {}),
    ...(opts.freezeRunSpecForPullRequest !== undefined ? { freezeRunSpecForPullRequest: opts.freezeRunSpecForPullRequest } : {}),
    ...(opts.specFreezeDependencies !== undefined ? { specFreezeDependencies: opts.specFreezeDependencies } : {}),
    ...(opts.runWorkspaceMetadata !== undefined ? { runWorkspaceMetadata: opts.runWorkspaceMetadata } : {}),
    ...(opts.runSteps !== undefined ? { runSteps: opts.runSteps } : {}),
    ...(opts.convergenceEngine !== undefined ? { convergenceEngine: opts.convergenceEngine } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.autoDispatch !== undefined ? { autoDispatch: opts.autoDispatch } : {})
  });
  return { orchestrator, runs, conversationIngress, events, dispatchQueue };
}

describe('DefaultOrchestrator.createRun', () => {
  it('publishes the start event before detached auto-dispatch starts and createRun returns without awaiting work completion', async () => {
    const order: string[] = [];
    let releaseUnit!: () => void;
    // unitRun blocks until releaseUnit() is called — if createRun awaited work it would never resolve.
    // spec.author is an AI step, so it goes through the unit of work.
    const unitRun = vi.fn(async () => {
      order.push('unit-start');
      await new Promise<void>((release) => { releaseUnit = release; });
      return { directive: 'advance' };
    });
    const runs = makeFakeRunRepo({
      // Lifecycle start puts the run at spec.author (an AI step that triggers unit-of-work auto-dispatch)
      recordRunLifecycleStart: vi.fn().mockResolvedValue({ run: makeRun({ currentStep: 'spec.author' }), runStep: makeRunStep({ step: 'spec.author', phase: 'spec' }) }),
      findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'spec.author' })),
      // Transition to a human gate so auto-dispatch stops after the first dispatch instead
      // of re-dispatching an ever-advancing fake forever.
      recordRunStepTransition: vi.fn().mockResolvedValue({
        run: makeRun({ currentStep: 'spec.human_review' }),
        runStep: makeRunStep({ id: 'step_2', step: 'spec.human_review', phase: 'spec' })
      })
    });
    const publisher: RunEventPublisher = {
      append: async () => { order.push('event'); },
      replayAfter: async () => ({ status: 'ok', events: [] }),
      subscribe: () => ({ events: (async function*() {})() as unknown as AsyncIterable<RunStateTransitionEvent>, close: () => {} })
    } as unknown as RunEventPublisher;
    const { orchestrator } = makeOrchestrator({ runs, events: publisher, unitOfWork: { run: unitRun } });

    // createRun resolves with the committed run — it does NOT await unit completion
    const result = await orchestrator.createRun({ topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature' });
    expect(result).toMatchObject({ run: { id: 'run_1', currentStep: 'spec.author' } });

    // The event was published before auto-dispatch started
    expect(order[0]).toBe('event');

    // Auto-dispatch fires detached — wait for it to start and verify ordering
    await vi.waitFor(() => expect(unitRun).toHaveBeenCalledTimes(1));
    expect(order).toContain('unit-start');
    expect(order.indexOf('event')).toBeLessThan(order.indexOf('unit-start'));

    releaseUnit();
  });

  it('publishes a start event after a successful lifecycle start', async () => {
    const run = makeRun();
    const runStep = makeRunStep();
    const runs = makeFakeRunRepo({
      recordRunLifecycleStart: vi.fn().mockResolvedValue({ run, runStep })
    });
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

    const result = await orchestrator.createRun({
      topicId: 'topic_1',
      owner,
      tenant: 'tenant_1',
      workKind: 'feature'
    });

    expect(result.run).toEqual(run);
    expect(result.runStep).toEqual(runStep);
    expect(events).toHaveLength(1);
    expect(events[0]?.transition.directive).toBe('start');
    expect(events[0]?.transition.toStep).toBe('intake');
    expect(events[0]?.transition.fromStep).toBeUndefined();
    expect(events[0]?.runId).toBe('run_1');
    expect(events[0]?.tenant).toBe('tenant_1');
  });

  it('maps unknown work kind to OrchestratorError("unknown_work_kind")', async () => {
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ events: publisher });
    await expect(
      orchestrator.createRun({
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_1',
        workKind: 'not_a_real_kind'
      })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'unknown_work_kind' });
    expect(events).toHaveLength(0);
  });

  it('maps active-run conflict to OrchestratorError("active_run_conflict") with details', async () => {
    class ActiveRunConflictPersistenceError extends Error {
      constructor() {
        super('Active run conflict');
        this.name = 'ActiveRunConflictPersistenceError';
      }
    }
    const existingActive = makeRun({ id: 'existing_run_1' });
    const runs = makeFakeRunRepo({
      recordRunLifecycleStart: vi.fn().mockRejectedValue(new ActiveRunConflictPersistenceError()),
      findActiveByTopic: vi.fn().mockResolvedValue(existingActive)
    });
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

    try {
      await orchestrator.createRun({
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_1',
        workKind: 'feature'
      });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestratorError);
      const err = error as OrchestratorError;
      expect(err.code).toBe('active_run_conflict');
      expect(err.details).toEqual({ topicId: 'topic_1', existingRunId: 'existing_run_1' });
    }
    expect(events).toHaveLength(0);
  });

  it('does NOT publish an event on failed persistence', async () => {
    const runs = makeFakeRunRepo({
      recordRunLifecycleStart: vi.fn().mockRejectedValue(new Error('boom'))
    });
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

    await expect(
      orchestrator.createRun({
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_1',
        workKind: 'feature'
      })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });
    expect(events).toHaveLength(0);
  });
});

describe('DefaultOrchestrator.createConversationWithFirstRun', () => {
  it('calls ingress repository and publishes start event after commit', async () => {
    const run = makeRun();
    const runStep = makeRunStep();
    const conversation = makeConversation();
    const topic = makeTopic();
    const message = makeMessage();
    const createIngress = vi.fn().mockResolvedValue({ conversation, topic, message, run, runStep });
    const conversationIngress: ConversationIngressRepository = {
      createConversationTopicMessageAndRun: createIngress
    };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ conversationIngress, events: publisher });

    const result = await orchestrator.createConversationWithFirstRun({
      projectId: 'proj_1',
      owner,
      tenant: 'tenant_1',
      identity: 'identity_1',
      topic: { title: 'My topic' },
      message: { body: 'Hello' },
      workKind: 'feature'
    });

    expect(result.run).toEqual(run);
    expect(result.runStep).toEqual(runStep);
    expect(result.conversation).toEqual(conversation);
    expect(result.topic).toEqual(topic);
    expect(result.message).toEqual(message);
    expect(createIngress).toHaveBeenCalledTimes(1);
    const ingressArg = createIngress.mock.calls[0]?.[0];
    expect(ingressArg.conversation.projectId).toBe('proj_1');
    expect(ingressArg.topic.title).toBe('My topic');
    expect(ingressArg.message.body).toBe('Hello');
    expect(ingressArg.run.workKind).toBe('feature');
    expect(ingressArg.runStep.step).toBe('intake');
    expect(events).toHaveLength(1);
    expect(events[0]?.transition.directive).toBe('start');
  });

  it('maps unknown work kind without calling ingress repository', async () => {
    const createIngress = vi.fn();
    const conversationIngress: ConversationIngressRepository = {
      createConversationTopicMessageAndRun: createIngress
    };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ conversationIngress, events: publisher });

    await expect(
      orchestrator.createConversationWithFirstRun({
        projectId: 'proj_1',
        owner,
        tenant: 'tenant_1',
        identity: 'identity_1',
        topic: { title: 'T' },
        workKind: 'not_a_real_kind'
      })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'unknown_work_kind' });
    expect(createIngress).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('does NOT publish an event on failed ingress persistence', async () => {
    const conversationIngress: ConversationIngressRepository = {
      createConversationTopicMessageAndRun: vi.fn().mockRejectedValue(new Error('boom'))
    };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ conversationIngress, events: publisher });

    await expect(
      orchestrator.createConversationWithFirstRun({
        projectId: 'proj_1',
        owner,
        tenant: 'tenant_1',
        identity: 'identity_1',
        topic: { title: 'T' },
        workKind: 'feature'
      })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });
    expect(events).toHaveLength(0);
  });
});

describe('DefaultOrchestrator.applyDirective', () => {
  it('reads existing run, applies directive, publishes event with fromStep', async () => {
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const newStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: newStep })
    });
    const { publisher, events } = makeRecordingPublisher();
    // This test exercises applyDirective's return and event, not the auto-dispatch chain;
    // disable auto-dispatch so the detached follow-on dispatch does not run against fakes
    // that are not set up for it.
    const { orchestrator } = makeOrchestrator({ runs, events: publisher, autoDispatch: { enabled: false } });

    const result = await orchestrator.applyDirective({
      runId: 'run_1',
      directive: 'advance',
      tenant: 'tenant_1'
    });

    expect(result.run.currentStep).toBe('spec.author');
    expect(result.runStep.step).toBe('spec.author');
    expect(events).toHaveLength(1);
    expect(events[0]?.transition.directive).toBe('advance');
    expect(events[0]?.transition.fromStep).toBe('intake');
    expect(events[0]?.transition.toStep).toBe('spec.author');
  });

  it('maps missing run to OrchestratorError("missing_run")', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(null)
    });
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

    await expect(
      orchestrator.applyDirective({ runId: 'missing_run', directive: 'advance', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'missing_run' });
    expect(events).toHaveLength(0);
  });

  it('maps terminal run to OrchestratorError("terminal_run")', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ terminal: true, currentStep: 'done' }))
    });
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

    await expect(
      orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'terminal_run' });
    expect(events).toHaveLength(0);
  });

  it('does NOT publish an event on failed transition persistence', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun()),
      recordRunStepTransition: vi.fn().mockRejectedValue(new Error('boom'))
    });
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

    await expect(
      orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });
    expect(events).toHaveLength(0);
  });
});

describe('DefaultOrchestrator.dispatch', () => {
  it('rejects missing run', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const unitOfWork: RunUnitOfWork = { run: vi.fn() };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });
    await expect(
      orchestrator.dispatch({ runId: 'missing', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'missing_run' });
  });

  it('rejects terminal run', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ terminal: true, currentStep: 'done' }))
    });
    const unitOfWork: RunUnitOfWork = { run: vi.fn() };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });
    await expect(
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'terminal_run' });
  });

  it('invokes unit of work and applies the resulting advance directive', async () => {
    const existing = makeRun({ currentStep: 'pr.finalize' });
    const updated = makeRun({ currentStep: 'pr.open' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'pr.open', phase: 'pr' });
    const findById = vi.fn().mockResolvedValue(existing);
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById,
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({
      directive: 'advance',
      result: { directive: 'advance', reconciledSummary: 'ok', titleSubject: 'feat', validationSummary: [], findings: [] }
    });
    const unitOfWork: RunUnitOfWork = { run: unitRun };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, events: publisher, autoDispatch: { enabled: false } });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(unitRun).toHaveBeenCalledTimes(1);
    const unitArg = unitRun.mock.calls[0]?.[0];
    expect(unitArg.runId).toBe('run_1');
    expect(unitArg.run).toEqual(existing);
    expect(unitArg.tenant).toBe('tenant_1');
    // Orchestrator (not the unit) recorded the transition
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('pr.open');
    expect(events).toHaveLength(1);
    expect(events[0]?.transition.directive).toBe('advance');
  });

  it('runs deterministic spec freeze before advancing to pr.open on pr.finalize advance', async () => {
    const existing = makeRun({ currentStep: 'pr.finalize', workKind: 'feature' });
    const updated = makeRun({ currentStep: 'pr.open' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'pr.open', phase: 'pr' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });
    const unitRun = vi.fn().mockResolvedValue({
      directive: 'advance',
      result: { directive: 'advance', reconciledSummary: 'ok', titleSubject: 'feat', validationSummary: [], findings: [] }
    });
    const freeze = vi.fn().mockResolvedValue({ artifactPath: 'p', shippedAt: 't', commitSha: 'sha' });
    const freezeDeps = {} as SpecFreezeDependencies;
    const resolveWorkspaceContext: WorkspaceContextResolver = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'wsh'
    });
    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      autoDispatch: { enabled: false },
      freezeRunSpecForPullRequest: freeze,
      specFreezeDependencies: freezeDeps,
      resolveWorkspaceContext
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // Freeze was invoked exactly once with the resolved workspace root and the current run.
    expect(freeze).toHaveBeenCalledTimes(1);
    const freezeCall = freeze.mock.calls[0]!;
    expect((freezeCall[0] as { workspaceRepoRoot: string }).workspaceRepoRoot).toBe('/tmp/repo');
    expect((freezeCall[0] as { run: Run }).run.id).toBe('run_1');
    expect(freezeCall[1]).toBe(freezeDeps);

    // Advance to pr.open succeeded.
    expect(result.run.currentStep).toBe('pr.open');
  });

  it('does NOT run spec freeze when pr.finalize result is revise', async () => {
    const existing = makeRun({ currentStep: 'pr.finalize', workKind: 'feature' });
    const updated = makeRun({ currentStep: 'implementation.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.human_review', phase: 'implementation' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });
    const unitRun = vi.fn().mockResolvedValue({
      directive: 'advance',
      result: {
        directive: 'revise',
        reconciledSummary: 'needs work',
        titleSubject: 'feat',
        validationSummary: [],
        findings: [{ severity: 'blocker', summary: 'oops' }]
      }
    });
    const freeze = vi.fn().mockResolvedValue({ artifactPath: 'p', shippedAt: 't', commitSha: null });
    const resolveWorkspaceContext: WorkspaceContextResolver = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'wsh'
    });
    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      autoDispatch: { enabled: false },
      freezeRunSpecForPullRequest: freeze,
      specFreezeDependencies: {} as SpecFreezeDependencies,
      resolveWorkspaceContext
    });

    await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(freeze).not.toHaveBeenCalled();
  });

  it('fails the run with reason spec_freeze_failed when the spec freeze throws on pr.finalize advance', async () => {
    const existing = makeRun({ currentStep: 'pr.finalize', workKind: 'feature' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({
      directive: 'advance',
      result: { directive: 'advance', reconciledSummary: 'ok', titleSubject: 'feat', validationSummary: [], findings: [] }
    });
    const freeze = vi.fn().mockRejectedValue(new SpecFreezeError('boom'));
    const resolveWorkspaceContext: WorkspaceContextResolver = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/tmp/repo',
      workspaceHandle: 'wsh'
    });
    const logger = { warn: vi.fn() };
    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      autoDispatch: { enabled: false },
      freezeRunSpecForPullRequest: freeze,
      specFreezeDependencies: {} as SpecFreezeDependencies,
      resolveWorkspaceContext,
      logger
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(freeze).toHaveBeenCalledTimes(1);
    // Run was failed with the sanitized reason — not advanced to pr.open.
    expect(result.run.currentStep).toBe('failed');
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.failureReason).toBe('spec_freeze_failed');
  });

  it('dispatches implementation.plan with an explicit passthrough checkpoint before implementation.build', async () => {
    const runAtPlan = makeRun({ currentStep: 'implementation.plan', workKind: 'feature' });

    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(runAtPlan),
      recordRunStepTransition: vi.fn().mockResolvedValue({
        run: makeRun({ currentStep: 'implementation.build' }),
        runStep: makeRunStep({ step: 'implementation.build' })
      })
    });

    const unitOfWork = { run: vi.fn() };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, autoDispatch: { enabled: false } });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(result.run.currentStep).toBe('implementation.build');
    expect(unitOfWork.run).not.toHaveBeenCalled();

    // Verify the checkpoint was recorded in the transition
    const transitionCall = (runs.recordRunStepTransition as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(transitionCall?.checkpointResult).toMatchObject({
      kind: 'implementation_plan_passthrough',
      reason: 'issue_63_reply_ingress_uses_existing_build_convergence'
    });
  });

  it('applies fail directive through lifecycle when unit of work returns fail (queue slot released)', async () => {
    const existing = makeRun();
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: failed, runStep: failedStep })
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'fail', reason: 'nope' })
    };
    const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 1 });
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, dispatchQueue });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });
    expect(result.run.currentStep).toBe('failed');
    expect(result.run.terminal).toBe(true);

    // Slot was released after the dispatch
    expect(dispatchQueue.activeCount).toBe(0);
  });

  it('errors if no unit of work is configured', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'spec.author' })) });
    const { orchestrator } = makeOrchestrator({ runs });
    await expect(
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });
  });
});

describe('DefaultOrchestrator.createConversationWithFirstRun — duplicate active run', () => {
  it('maps ActiveRunConflictPersistenceError-like errors to active_run_conflict', async () => {
    class ActiveRunConflictPersistenceError extends Error {
      readonly topicId: string;
      readonly existingRunId: string | null;
      constructor(topicId: string, existingRunId: string | null) {
        super(`Active run conflict for topic '${topicId}'.`);
        this.name = 'ActiveRunConflictPersistenceError';
        this.topicId = topicId;
        this.existingRunId = existingRunId;
      }
    }
    const conversationIngress: ConversationIngressRepository = {
      createConversationTopicMessageAndRun: vi
        .fn()
        .mockRejectedValue(new ActiveRunConflictPersistenceError('topic_existing', 'run_existing'))
    };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ conversationIngress, events: publisher });

    try {
      await orchestrator.createConversationWithFirstRun({
        projectId: 'proj_1',
        owner,
        tenant: 'tenant_1',
        identity: 'identity_1',
        topic: { title: 'T' },
        workKind: 'feature'
      });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestratorError);
      const err = error as OrchestratorError;
      expect(err.code).toBe('active_run_conflict');
      expect(err.details).toEqual({ topicId: 'topic_existing', existingRunId: 'run_existing' });
    }
    expect(events).toHaveLength(0);
  });
});

describe('DefaultOrchestrator.createConversationWithFirstRun — auto-dispatch ordering', () => {
  it('auto-dispatches the initial intake step (system step) after conversation creation start event publication', async () => {
    const order: string[] = [];
    const run = makeRun({ currentStep: 'intake' });
    const runStep = makeRunStep({ step: 'intake' });
    const conversation = makeConversation();
    const topic = makeTopic();
    const message = makeMessage();
    const unitRun = vi.fn();
    const conversationIngress = makeFakeIngressRepo({
      createConversationTopicMessageAndRun: vi.fn().mockResolvedValue({ conversation, topic, message, run, runStep })
    });
    // intake is a system step — it advances directly via applyDirective (no unit of work).
    // Transitions to spec.human_review (a human gate) so auto-dispatch stops after one advancement.
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(run),
      recordRunStepTransition: vi.fn().mockImplementation(async () => {
        order.push('dispatch');
        return {
          run: makeRun({ currentStep: 'spec.human_review' }),
          runStep: makeRunStep({ id: 'step_2', step: 'spec.human_review', phase: 'spec' })
        };
      })
    });
    const publisher: RunEventPublisher = {
      append: async () => { order.push('event'); },
      replayAfter: async () => ({ status: 'ok', events: [] }),
      subscribe: () => ({ events: (async function*() {})() as unknown as AsyncIterable<RunStateTransitionEvent>, close: () => {} })
    } as unknown as RunEventPublisher;
    const { orchestrator } = makeOrchestrator({ conversationIngress, runs, events: publisher, unitOfWork: { run: unitRun } });

    await orchestrator.createConversationWithFirstRun({
      projectId: 'proj_1',
      owner,
      tenant: 'tenant_1',
      identity: 'identity_1',
      topic: { title: 'T' },
      message: { body: 'hello' },
      workKind: 'feature'
    });

    // Wait for the detached auto-dispatch of intake to complete
    await vi.waitFor(() => expect(order).toContain('dispatch'));
    // intake is a system step — unit of work must NOT be called
    expect(unitRun).not.toHaveBeenCalled();
    // The start event was published before the intake auto-dispatch ran
    expect(order[0]).toBe('event');
    expect(order.indexOf('event')).toBeLessThan(order.indexOf('dispatch'));
  });
});

describe('DefaultOrchestrator.createConversationWithFirstRun — auto-dispatch disabled', () => {
  it('does not auto-dispatch when autoDispatch is explicitly disabled', async () => {
    const run = makeRun({ currentStep: 'intake' });
    const runStep = makeRunStep({ step: 'intake' });
    const conversation = makeConversation();
    const topic = makeTopic();
    const message = makeMessage();
    const conversationIngress = makeFakeIngressRepo({
      createConversationTopicMessageAndRun: vi.fn().mockResolvedValue({ conversation, topic, message, run, runStep })
    });
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const { orchestrator } = makeOrchestrator({
      conversationIngress,
      unitOfWork: { run: unitRun },
      autoDispatch: { enabled: false }
    });

    await orchestrator.createConversationWithFirstRun({
      projectId: 'proj_1',
      owner,
      tenant: 'tenant_1',
      identity: 'identity_1',
      topic: { title: 'T' },
      workKind: 'feature'
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unitRun).not.toHaveBeenCalled();
  });
});

describe('DefaultOrchestrator — auto-dispatch failure reasons', () => {
  it('marks auto-dispatch failures with an allowlisted lower-level reason when available', async () => {
    // The unit-of-work throws ModelRoutingConfigurationError — this escapes dispatch()
    // and is caught by the .catch() in #scheduleAutoDispatch, invoking #handleAutoDispatchFailure.
    // After Task 4, that handler maps the error to 'profile_incomplete' via safeFailureReasonFromError.
    const specAuthorRun = makeRun({ currentStep: 'spec.author' });
    const specAuthorStep = makeRunStep({ step: 'spec.author', phase: 'spec' });
    const failedRun = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failedRun, runStep: failedStep });

    // runs.findById always returns the spec.author run (non-terminal) so that
    // #handleAutoDispatchFailure's "is current still dispatchable?" check passes.
    const runs = makeFakeRunRepo({
      recordRunLifecycleStart: vi.fn().mockResolvedValue({ run: specAuthorRun, runStep: specAuthorStep }),
      findById: vi.fn().mockResolvedValue(specAuthorRun),
      recordRunStepTransition: recordTransition
    });

    // Unit-of-work throws rather than returning a fail directive — this causes dispatch() to throw,
    // which propagates to #handleAutoDispatchFailure via the .catch() in #scheduleAutoDispatch.
    const unitRun = vi.fn(async () => {
      throw new ModelRoutingConfigurationError('profile_incomplete', 'raw configuration detail');
    });
    const unitOfWork: RunUnitOfWork = { run: unitRun };

    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });

    // createRun starts the lifecycle at spec.author and then calls #scheduleAutoDispatch.
    // Auto-dispatch fires dispatch() which calls the unit-of-work. The unit-of-work throws,
    // causing dispatch() to reject, which triggers #handleAutoDispatchFailure.
    await orchestrator.createRun({
      topicId: 'topic_1',
      owner,
      tenant: 'tenant_1',
      workKind: 'feature'
    });

    // Wait for the detached auto-dispatch (which throws) and the subsequent
    // #handleAutoDispatchFailure to record the fail transition.
    await vi.waitFor(() => expect(recordTransition).toHaveBeenCalled(), { timeout: 3000 });

    // The failure reason recorded must be 'profile_incomplete', not 'auto_dispatch_failed'.
    // recordRunStepTransition receives { runId, currentStep, terminal, runStep, failureReason }.
    expect(recordTransition).toHaveBeenCalledWith(expect.objectContaining({
      failureReason: 'profile_incomplete'
    }));
    expect(recordTransition).not.toHaveBeenCalledWith(expect.objectContaining({
      failureReason: 'auto_dispatch_failed'
    }));
  });
});

describe('DefaultOrchestrator.dispatch — bounded queue', () => {
  it('never exceeds cap when multiple units are dispatched concurrently', async () => {
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });
    const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
    let peakActive = 0;
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockImplementation(async () => {
        peakActive = Math.max(peakActive, dispatchQueue.activeCount);
        // Give other dispatches a chance to start while this one is "active"
        await new Promise<void>((resolve) => setImmediate(resolve));
        peakActive = Math.max(peakActive, dispatchQueue.activeCount);
        return { directive: 'advance' };
      })
    };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, dispatchQueue, autoDispatch: { enabled: false } });

    await Promise.all([
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' }),
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' }),
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' }),
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' })
    ]);

    expect(peakActive).toBeLessThanOrEqual(2);
    expect(dispatchQueue.activeCount).toBe(0);
  });

  it('fail directive releases capacity so subsequent dispatches can proceed', async () => {
    const existing = makeRun({ currentStep: 'intake' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    let transitionCallCount = 0;
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockImplementation(async () => {
        transitionCallCount += 1;
        if (transitionCallCount === 1) {
          return { run: failed, runStep: failedStep };
        }
        return { run: updated, runStep: updatedStep };
      })
    });
    const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 1 });
    let callCount = 0;
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { directive: 'fail', reason: 'boom' };
        }
        return { directive: 'advance' };
      })
    };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, dispatchQueue, autoDispatch: { enabled: false } });

    const firstResult = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });
    expect(firstResult.run.currentStep).toBe('failed');

    expect(dispatchQueue.activeCount).toBe(0);

    // Second dispatch should succeed because capacity was released.
    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });
    expect(result.run.currentStep).toBe('spec.author');
    expect(dispatchQueue.activeCount).toBe(0);
  });
});

describe('DefaultOrchestrator.applyDirective — tenant enforcement', () => {
  it('rejects when run.tenant does not match input.tenant', async () => {
    const run = makeRun({ tenant: 'tenant_1' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(run) });
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

    await expect(
      orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_other' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'forbidden' });
    expect(events).toHaveLength(0);
  });
});

describe('DefaultOrchestrator.dispatch — tenant enforcement', () => {
  it('rejects when run.tenant does not match input.tenant', async () => {
    const run = makeRun({ tenant: 'tenant_1' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(run) });
    const unitOfWork: RunUnitOfWork = { run: vi.fn() };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, events: publisher });

    await expect(
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_other' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'forbidden' });
    expect(events).toHaveLength(0);
  });
});

describe('DefaultOrchestrator.tick fallback seam', () => {
  it('returns { status: "noop" } when no runId is provided', async () => {
    const { orchestrator } = makeOrchestrator({ autoDispatch: { enabled: false } });
    const result = await orchestrator.tick({ tenant: 'tenant_1' });
    expect(result).toEqual({ status: 'noop' });
  });

  it('dispatches and returns { status: "dispatched", runId } when runId is provided', async () => {
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });
    const unitOfWork: RunUnitOfWork = { run: vi.fn().mockResolvedValue({ directive: 'advance' }) };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, autoDispatch: { enabled: false } });

    const result = await orchestrator.tick({ runId: 'run_1', tenant: 'tenant_1' });
    expect(result).toEqual({ status: 'dispatched', runId: 'run_1' });
  });
});

// --- Spec authoring completion helpers ---

function makeArtifact(): Artifact {
  return {
    id: 'art_1',
    runId: 'run_1',
    owner,
    tenant: 'tenant_1',
    kind: 'feature_spec',
    canonicalRecord: 'file',
    location: 'context-human/specs/feature-test.md',
    cachedStatus: 'draft',
    publicationRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function makeSpecAuthoringDeps(overrides: Partial<SpecAuthoringServiceDependencies> = {}): SpecAuthoringServiceDependencies {
  const artifact = makeArtifact();
  return {
    artifacts: {
      create: vi.fn().mockResolvedValue(artifact),
      findById: vi.fn().mockResolvedValue(null),
      listByRun: vi.fn().mockResolvedValue([]),
      findByRunAndKind: vi.fn().mockResolvedValue(null),
      updateCachedStatus: vi.fn().mockResolvedValue(artifact)
    },
    filesystem: {
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nspecced_by: autocatalyst\n---\n# Test\n\nBody.')
    },
    git: {
      commitFiles: vi.fn().mockResolvedValue({})
    },
    ...overrides
  } as unknown as SpecAuthoringServiceDependencies;
}

function makeSpecAuthorResult() {
  return {
    kind: 'feature_spec',
    slug: 'test',
    relativePath: 'context-human/specs/feature-test.md',
    frontmatter: {
      created: '2026-06-11',
      last_updated: '2026-06-11',
      status: 'draft',
      specced_by: 'autocatalyst'
    },
    body: '# Test\n\nBody.'
  };
}

describe('DefaultOrchestrator.dispatch — system steps', () => {
  it('advances intake directly without requiring unit of work', async () => {
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });
    const unitRun = vi.fn();
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun }, autoDispatch: { enabled: false } });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(unitRun).not.toHaveBeenCalled();
    expect(result.run.currentStep).toBe('spec.author');
  });

  it('refuses runner dispatch for unsupported system side-effect steps', async () => {
    const existing = makeRun({ currentStep: 'issues.file', workKind: 'file_issue' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    const unitRun = vi.fn();
    const unitOfWork: RunUnitOfWork = { run: unitRun };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });

    await expect(orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' }))
      .rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
    expect(unitRun).not.toHaveBeenCalled();
  });
});

describe('DefaultOrchestrator.dispatch — human-waiting steps', () => {
  it('refuses runner dispatch for human-waiting spec review', async () => {
    const existing = makeRun({ currentStep: 'spec.human_review' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing)
    });
    const unitRun = vi.fn();
    const unitOfWork: RunUnitOfWork = { run: unitRun };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });

    await expect(
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
    expect(unitRun).not.toHaveBeenCalled();
  });

  it('refuses runner dispatch for other human-waiting steps', async () => {
    const existing = makeRun({ currentStep: 'implementation.human_review' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing)
    });
    const unitRun = vi.fn();
    const unitOfWork: RunUnitOfWork = { run: unitRun };
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });

    await expect(
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
    expect(unitRun).not.toHaveBeenCalled();
  });
});

describe('DefaultOrchestrator.dispatch — spec.author completion', () => {
  it('calls completeSpecAuthoring before persisting spec.author advance', async () => {
    const specAuthorResult = makeSpecAuthorResult();
    const existing = makeRun({ currentStep: 'spec.author' });
    const updated = makeRun({ currentStep: 'spec.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.human_review', phase: 'spec' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'advance', result: specAuthorResult })
    };
    const specAuthoringDeps = makeSpecAuthoringDeps();
    const resolveWorkspaceContext = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/workspace/repo',
      workspaceHandle: 'ws_1'
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork,
      specAuthoringDependencies: specAuthoringDeps,
      resolveWorkspaceContext
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(resolveWorkspaceContext).toHaveBeenCalledWith({ runId: 'run_1' });
    expect(specAuthoringDeps.filesystem.writeFile).toHaveBeenCalledTimes(1);
    expect(specAuthoringDeps.git.commitFiles).toHaveBeenCalledTimes(1);
    expect(recordTransition).toHaveBeenCalledTimes(1);
    // The checkpoint passed to applyDirective should include the artifact id from completion
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.checkpointResult?.artifactId).toBe('art_1');
    expect(result.run.currentStep).toBe('spec.human_review');
  });

  it('does not advance when completeSpecAuthoring throws', async () => {
    const specAuthorResult = makeSpecAuthorResult();
    const existing = makeRun({ currentStep: 'spec.author' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'advance', result: specAuthorResult })
    };
    const specAuthoringDeps = makeSpecAuthoringDeps({
      git: {
        commitFiles: vi.fn().mockRejectedValue(new SpecAuthoringError('spec_commit_failed', 'git failed'))
      } as unknown as SpecAuthoringServiceDependencies['git']
    });
    const resolveWorkspaceContext = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/workspace/repo',
      workspaceHandle: 'ws_1'
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork,
      specAuthoringDependencies: specAuthoringDeps,
      resolveWorkspaceContext
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // Should have applied fail directive — run does not advance to spec.human_review
    expect(result.run.currentStep).toBe('failed');
    expect(result.run.terminal).toBe(true);
    // Transition was called once; the resulting run is terminal (failed)
    expect(recordTransition).toHaveBeenCalledTimes(1);
  });

  it('does not advance when workspace metadata persistence fails', async () => {
    const specAuthorResult = makeSpecAuthorResult();
    const existing = makeRun({ currentStep: 'spec.author' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'advance', result: specAuthorResult })
    };
    const specAuthoringDeps = makeSpecAuthoringDeps();
    const resolveWorkspaceContext = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/workspace/repo',
      workspaceHandle: 'ws_1'
    });
    const upsert = vi.fn().mockRejectedValue(new Error('sqlite write failed'));
    const runWorkspaceMetadata = {
      upsert,
      findByRunId: vi.fn().mockResolvedValue(null)
    } as unknown as RunWorkspaceMetadataRepository;

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork,
      specAuthoringDependencies: specAuthoringDeps,
      resolveWorkspaceContext,
      runWorkspaceMetadata
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // The spec was authored, but the run must not enter the gate without a
    // recoverable workspace-metadata record — it fails instead of advancing.
    expect(specAuthoringDeps.git.commitFiles).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.currentStep).toBe('failed');
    expect(result.run.currentStep).toBe('failed');
    expect(result.run.terminal).toBe(true);
  });

  it('does not advance when resolveWorkspaceContext throws', async () => {
    const specAuthorResult = makeSpecAuthorResult();
    const existing = makeRun({ currentStep: 'spec.author' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'advance', result: specAuthorResult })
    };

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork,
      specAuthoringDependencies: makeSpecAuthoringDeps(),
      resolveWorkspaceContext: vi.fn().mockRejectedValue(new Error('workspace unavailable'))
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });
    expect(result.run.currentStep).toBe('failed');
    expect(result.run.terminal).toBe(true);
  });

  it('falls through to fail when specAuthoringDependencies not configured for spec.author advance', async () => {
    const specAuthorResult = makeSpecAuthorResult();
    const existing = makeRun({ currentStep: 'spec.author' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'advance', result: specAuthorResult })
    };
    // No specAuthoringDependencies or resolveWorkspaceContext injected
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });
    expect(result.run.currentStep).toBe('failed');
    expect(result.run.terminal).toBe(true);
  });

  it('does NOT call completeSpecAuthoring when workKind is not feature or enhancement', async () => {
    const existing = makeRun({ currentStep: 'spec.author', workKind: 'bug' });
    const updated = makeRun({ currentStep: 'spec.human_review', workKind: 'bug' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.human_review', phase: 'spec' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'advance' })
    };
    const specAuthoringDeps = makeSpecAuthoringDeps();
    const resolveWorkspaceContext = vi.fn();

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork,
      specAuthoringDependencies: specAuthoringDeps,
      resolveWorkspaceContext
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // completeSpecAuthoring must NOT have been triggered
    expect(resolveWorkspaceContext).not.toHaveBeenCalled();
    expect(specAuthoringDeps.filesystem.writeFile).not.toHaveBeenCalled();
    expect(specAuthoringDeps.git.commitFiles).not.toHaveBeenCalled();
    // The run still advances normally through applyDirective
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('spec.human_review');
  });

  it('does NOT call completeSpecAuthoring for non-spec.author steps', async () => {
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'advance' })
    };
    const specAuthoringDeps = makeSpecAuthoringDeps();
    const resolveWorkspaceContext = vi.fn();

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork,
      specAuthoringDependencies: specAuthoringDeps,
      resolveWorkspaceContext
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(resolveWorkspaceContext).not.toHaveBeenCalled();
    expect(specAuthoringDeps.filesystem.writeFile).not.toHaveBeenCalled();
    expect(result.run.currentStep).toBe('spec.author');
  });
});

// --- Gate guard helpers ---

function principal(id: string): NonModelPrincipal {
  return { id, kind: 'human', tenantId: 'tenant_1', displayName: id };
}

function makeFakeFeedbackRepo(overrides: Partial<FeedbackRepository> = {}): FeedbackRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    listByRun: vi.fn().mockResolvedValue([]),
    updateStatusAndAppendThread: vi.fn().mockResolvedValue(null),
    appendThreadEntry: vi.fn().mockResolvedValue(null),
    ...overrides
  };
}

function makeFakeFeedbackLifecycleDeps(overrides: Partial<FeedbackLifecycleDependencies> = {}): FeedbackLifecycleDependencies {
  return {
    feedback: makeFakeFeedbackRepo(),
    ids: () => 'id_1',
    clock: () => timestamp,
    ...overrides
  };
}

function makeDefaultApprovalFinalDeps(): SpecApprovalFinalizerDependencies {
  const artifact = {
    id: 'art_gate',
    runId: 'run_1',
    owner,
    tenant: 'tenant_1',
    kind: 'feature_spec' as const,
    canonicalRecord: 'file' as const,
    location: 'context-human/specs/feature-gate-test.md',
    cachedStatus: 'draft' as const,
    publicationRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const validContents = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nspecced_by: autocatalyst\n---\n# Gate test\n';
  let written = validContents;
  return {
    artifacts: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn(),
      findByRunAndKind: vi.fn().mockResolvedValue(artifact),
      updateCachedStatus: vi.fn().mockResolvedValue({ ...artifact, cachedStatus: 'approved' })
    } as unknown as SpecApprovalFinalizerDependencies['artifacts'],
    filesystem: {
      writeFile: vi.fn().mockImplementation(async ({ contents }: { contents: string }) => { written = contents; }),
      readFile: vi.fn().mockImplementation(async () => written)
    } as unknown as SpecApprovalFinalizerDependencies['filesystem'],
    git: { commitFiles: vi.fn().mockResolvedValue({ commitSha: 'gate_sha' }) } as unknown as SpecApprovalFinalizerDependencies['git'],
    clock: () => timestamp
  };
}

function makeOrchestratorAtSpecReview(overrides: {
  resolveApproverAddressedFeedback?: Parameters<typeof makeOrchestrator>[0]['resolveApproverAddressedFeedback'];
  assertSpecReviewGateCanAdvance?: Parameters<typeof makeOrchestrator>[0]['assertSpecReviewGateCanAdvance'];
  feedbackLifecycleDependencies?: FeedbackLifecycleDependencies;
  specApprovalFinalizerDependencies?: SpecApprovalFinalizerDependencies;
  resolveWorkspaceContext?: WorkspaceContextResolver;
  runs?: RunRepository;
} = {}) {
  const existing = makeRun({ currentStep: 'spec.human_review' });
  const updated = makeRun({ currentStep: 'implementation' });
  const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation', phase: 'implementation' });
  const runs = overrides.runs ?? makeFakeRunRepo({
    findById: vi.fn().mockResolvedValue(existing),
    recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
  });
  const feedbackLifecycleDependencies = overrides.feedbackLifecycleDependencies ?? makeFakeFeedbackLifecycleDeps();
  const specApprovalFinalizerDependencies = overrides.specApprovalFinalizerDependencies ?? makeDefaultApprovalFinalDeps();
  const resolveWorkspaceContext = overrides.resolveWorkspaceContext ?? vi.fn().mockResolvedValue({
    workspaceRepoRoot: '/tmp/gate-test',
    workspaceHandle: 'ws_gate'
  });
  const { orchestrator } = makeOrchestrator({
    runs,
    feedbackLifecycleDependencies,
    specApprovalFinalizerDependencies,
    resolveWorkspaceContext,
    ...(overrides.resolveApproverAddressedFeedback !== undefined
      ? { resolveApproverAddressedFeedback: overrides.resolveApproverAddressedFeedback }
      : {}),
    ...(overrides.assertSpecReviewGateCanAdvance !== undefined
      ? { assertSpecReviewGateCanAdvance: overrides.assertSpecReviewGateCanAdvance }
      : {})
  });
  return orchestrator;
}

describe('DefaultOrchestrator.applyDirective — spec.human_review gate guard', () => {
  it('co-resolves approver-owned addressed feedback before the gate', async () => {
    const callOrder: string[] = [];
    const resolveApproverAddressedFeedbackFn = vi.fn(async () => {
      callOrder.push('resolve');
    });
    const assertSpecReviewGateCanAdvanceFn = vi.fn(async () => {
      callOrder.push('assert');
    });
    const orchestrator = makeOrchestratorAtSpecReview({
      resolveApproverAddressedFeedback: resolveApproverAddressedFeedbackFn,
      assertSpecReviewGateCanAdvance: assertSpecReviewGateCanAdvanceFn
    });

    await orchestrator.applyDirective({
      runId: 'run_1',
      tenant: 'tenant_1',
      directive: 'advance',
      principal: principal('phoebe'),
      origin: 'human'
    });

    expect(resolveApproverAddressedFeedbackFn).toHaveBeenCalledTimes(1);
    expect(assertSpecReviewGateCanAdvanceFn).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['resolve', 'assert']);
  });

  it('uses principal as approver when provided', async () => {
    const resolveApproverAddressedFeedbackFn = vi.fn(async () => undefined);
    const orchestrator = makeOrchestratorAtSpecReview({
      resolveApproverAddressedFeedback: resolveApproverAddressedFeedbackFn
    });
    const phoebe = principal('phoebe');

    await orchestrator.applyDirective({
      runId: 'run_1',
      tenant: 'tenant_1',
      directive: 'advance',
      principal: phoebe,
      origin: 'human'
    });

    expect(resolveApproverAddressedFeedbackFn).toHaveBeenCalledWith(
      expect.objectContaining({ approver: phoebe }),
      expect.anything()
    );
  });

  it('falls back to run.owner as approver when principal not provided', async () => {
    const resolveApproverAddressedFeedbackFn = vi.fn(async () => undefined);
    const orchestrator = makeOrchestratorAtSpecReview({
      resolveApproverAddressedFeedback: resolveApproverAddressedFeedbackFn
    });

    await orchestrator.applyDirective({
      runId: 'run_1',
      tenant: 'tenant_1',
      directive: 'advance',
      origin: 'human'
    });

    expect(resolveApproverAddressedFeedbackFn).toHaveBeenCalledWith(
      expect.objectContaining({ approver: owner }),
      expect.anything()
    );
  });

  it('blocks advance when gate throws feedback_gate_blocked and maps to invalid_transition', async () => {
    const blockingId = 'fb_1';
    const assertSpecReviewGateCanAdvanceFn = vi.fn(async () => {
      throw new SpecReviewGateBlockedError('feedback_gate_blocked', 'Artifact feedback blocks spec approval.', [blockingId]);
    });
    const orchestrator = makeOrchestratorAtSpecReview({
      assertSpecReviewGateCanAdvance: assertSpecReviewGateCanAdvanceFn
    });

    await expect(
      orchestrator.applyDirective({
        runId: 'run_1',
        tenant: 'tenant_1',
        directive: 'advance',
        principal: principal('phoebe'),
        origin: 'human'
      })
    ).rejects.toMatchObject({
      name: 'OrchestratorError',
      code: 'invalid_transition',
      message: 'Artifact feedback blocks spec approval.'
    });
  });

  it('includes blockingFeedbackIds in error details when gate is blocked', async () => {
    const blockingId = 'fb_42';
    const assertSpecReviewGateCanAdvanceFn = vi.fn(async () => {
      throw new SpecReviewGateBlockedError('feedback_gate_blocked', 'Artifact feedback blocks spec approval.', [blockingId]);
    });
    const orchestrator = makeOrchestratorAtSpecReview({
      assertSpecReviewGateCanAdvance: assertSpecReviewGateCanAdvanceFn
    });

    try {
      await orchestrator.applyDirective({
        runId: 'run_1',
        tenant: 'tenant_1',
        directive: 'advance',
        principal: principal('phoebe'),
        origin: 'human'
      });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
      const err = error as { details: unknown };
      expect(err.details).toEqual({ code: 'feedback_gate_blocked', blockingFeedbackIds: [blockingId] });
    }
  });

  it('does NOT run the gate guard when advance is for a non-spec.human_review step', async () => {
    const assertSpecReviewGateCanAdvanceFn = vi.fn(async () => undefined);
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });
    const orchestrator = makeOrchestratorAtSpecReview({
      runs,
      assertSpecReviewGateCanAdvance: assertSpecReviewGateCanAdvanceFn
    });

    const result = await orchestrator.applyDirective({
      runId: 'run_1',
      tenant: 'tenant_1',
      directive: 'advance'
    });

    expect(assertSpecReviewGateCanAdvanceFn).not.toHaveBeenCalled();
    expect(result.run.currentStep).toBe('spec.author');
  });

  it('does NOT run the gate guard for non-advance directives at spec.human_review', async () => {
    const assertSpecReviewGateCanAdvanceFn = vi.fn(async () => undefined);
    const existing = makeRun({ currentStep: 'spec.human_review' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: failed, runStep: failedStep })
    });
    const orchestrator = makeOrchestratorAtSpecReview({
      runs,
      assertSpecReviewGateCanAdvance: assertSpecReviewGateCanAdvanceFn
    });

    const result = await orchestrator.applyDirective({
      runId: 'run_1',
      tenant: 'tenant_1',
      directive: 'fail'
    });

    expect(assertSpecReviewGateCanAdvanceFn).not.toHaveBeenCalled();
    expect(result.run.currentStep).toBe('failed');
  });

});

// --- Spec approval finalizer helpers ---

function makeFakeApprovalDeps(): SpecApprovalFinalizerDependencies {
  const artifact = {
    id: 'art_1',
    runId: 'run_1',
    owner,
    tenant: 'tenant_1',
    kind: 'feature_spec' as const,
    canonicalRecord: 'file' as const,
    location: 'context-human/specs/feature-test.md',
    cachedStatus: 'draft' as const,
    publicationRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const validContents = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nspecced_by: autocatalyst\n---\n# Test\n';
  let writtenContents = validContents;
  return {
    artifacts: {
      create: vi.fn(),
      findById: vi.fn(),
      listByRun: vi.fn(),
      findByRunAndKind: vi.fn().mockResolvedValue(artifact),
      updateCachedStatus: vi.fn().mockResolvedValue({ ...artifact, cachedStatus: 'approved' })
    } as unknown as SpecApprovalFinalizerDependencies['artifacts'],
    filesystem: {
      writeFile: vi.fn().mockImplementation(async ({ contents }: { workspaceRepoRoot: string; relativePath: string; contents: string }) => {
        writtenContents = contents;
      }),
      readFile: vi.fn().mockImplementation(async () => writtenContents)
    } as unknown as SpecApprovalFinalizerDependencies['filesystem'],
    git: {
      commitFiles: vi.fn().mockResolvedValue({ commitSha: 'abc123' })
    } as unknown as SpecApprovalFinalizerDependencies['git'],
    clock: () => timestamp
  };
}

describe('DefaultOrchestrator.applyDirective — spec approval finalizer', () => {
  it('calls finalizeSpecApproval before advancing the run from spec.human_review', async () => {
    const finalizeSpecApprovalFn = vi.fn(async () => undefined);
    const specApprovalFinalizerDependencies = makeFakeApprovalDeps();
    const resolveWorkspaceContext = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/workspace/repo',
      workspaceHandle: 'ws_1'
    });

    const existing = makeRun({ currentStep: 'spec.human_review' });
    const updated = makeRun({ currentStep: 'implementation' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      finalizeSpecApproval: finalizeSpecApprovalFn,
      specApprovalFinalizerDependencies,
      feedbackLifecycleDependencies: makeFakeFeedbackLifecycleDeps(),
      resolveWorkspaceContext
    });

    const result = await orchestrator.applyDirective({
      runId: 'run_1',
      directive: 'advance',
      tenant: 'tenant_1',
      principal: principal('phoebe'),
      origin: 'human'
    });

    expect(finalizeSpecApprovalFn).toHaveBeenCalledTimes(1);
    expect(finalizeSpecApprovalFn).toHaveBeenCalledWith(
      expect.objectContaining({ run: existing }),
      specApprovalFinalizerDependencies
    );
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('implementation');
  });

  it('throws persistence_failed for feature runs when specApprovalFinalizerDependencies not configured', async () => {
    const finalizeSpecApprovalFn = vi.fn(async () => undefined);

    const existing = makeRun({ currentStep: 'spec.human_review', workKind: 'feature' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn()
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      finalizeSpecApproval: finalizeSpecApprovalFn,
      feedbackLifecycleDependencies: makeFakeFeedbackLifecycleDeps()
      // No specApprovalFinalizerDependencies — should fail explicitly for spec workflows
    });

    await expect(
      orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1', origin: 'human' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });

    expect(finalizeSpecApprovalFn).not.toHaveBeenCalled();
  });

  it('throws persistence_failed when finalizeSpecApproval throws', async () => {
    const finalizeSpecApprovalFn = vi.fn(async () => { throw new Error('approval failed'); });
    const specApprovalFinalizerDependencies = makeFakeApprovalDeps();
    const resolveWorkspaceContext = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/workspace/repo',
      workspaceHandle: 'ws_1'
    });

    const existing = makeRun({ currentStep: 'spec.human_review' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn()
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      finalizeSpecApproval: finalizeSpecApprovalFn,
      specApprovalFinalizerDependencies,
      resolveWorkspaceContext
    });

    await expect(
      orchestrator.applyDirective({
        runId: 'run_1',
        directive: 'advance',
        tenant: 'tenant_1',
        origin: 'human'
      })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });

    // Run must NOT have been advanced
    expect(runs.recordRunStepTransition).not.toHaveBeenCalled();
  });

  it('does NOT call finalizeSpecApproval for non-advance directives at spec.human_review', async () => {
    const finalizeSpecApprovalFn = vi.fn(async () => undefined);
    const specApprovalFinalizerDependencies = makeFakeApprovalDeps();
    const resolveWorkspaceContext = vi.fn().mockResolvedValue({
      workspaceRepoRoot: '/workspace/repo',
      workspaceHandle: 'ws_1'
    });

    const existing = makeRun({ currentStep: 'spec.human_review' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: failed, runStep: failedStep })
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      finalizeSpecApproval: finalizeSpecApprovalFn,
      specApprovalFinalizerDependencies,
      resolveWorkspaceContext
    });

    const result = await orchestrator.applyDirective({
      runId: 'run_1',
      directive: 'fail',
      tenant: 'tenant_1'
    });

    expect(finalizeSpecApprovalFn).not.toHaveBeenCalled();
    expect(result.run.currentStep).toBe('failed');
  });

  it('does NOT call finalizeSpecApproval for other steps', async () => {
    const finalizeSpecApprovalFn = vi.fn(async () => undefined);
    const specApprovalFinalizerDependencies = makeFakeApprovalDeps();

    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      finalizeSpecApproval: finalizeSpecApprovalFn,
      specApprovalFinalizerDependencies
    });

    await orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' });

    expect(finalizeSpecApprovalFn).not.toHaveBeenCalled();
  });
});

describe('DefaultOrchestrator auto-dispatch policy', () => {
  it('skips duplicate automatic schedules for the same run while one is in flight', async () => {
    let releaseUnit!: () => void;
    const unitRun = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseUnit = resolve; });
      return { directive: 'advance' };
    });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'spec.author' })),
      recordRunStepTransition: vi.fn()
        .mockResolvedValueOnce({ run: makeRun({ currentStep: 'spec.author' }), runStep: makeRunStep({ step: 'spec.author', phase: 'spec' }) })
        .mockResolvedValueOnce({ run: makeRun({ currentStep: 'spec.author' }), runStep: makeRunStep({ step: 'spec.author', phase: 'spec' }) })
    });
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun } });

    await orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' });
    await vi.waitFor(() => expect(unitRun).toHaveBeenCalledTimes(1));
    await orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unitRun).toHaveBeenCalledTimes(1);
    releaseUnit();
  });

  it('catches detached dispatch rejections and safely fails an eligible run', async () => {
    const logger = { warn: vi.fn() };
    // spec.author is an AI step — it goes through the unit of work and can fail there.
    const runAtDispatch = makeRun({ currentStep: 'spec.author' });
    const failedRun = makeRun({ currentStep: 'failed', terminal: true });
    // findById is called four times in the failure path:
    //   1. dispatch() reads the run before invoking unitOfWork
    //   2. #handleAutoDispatchFailure re-reads the run to check current state
    //   3. applyDirective({ directive: 'fail' }) reads the run in the guard check
    //   4. applyRunDirective() reads the run again to perform the transition
    const findById = vi.fn()
      .mockResolvedValueOnce(runAtDispatch)
      .mockResolvedValueOnce(runAtDispatch)
      .mockResolvedValueOnce(runAtDispatch)
      .mockResolvedValueOnce(runAtDispatch);
    const recordRunStepTransition = vi.fn().mockResolvedValue({
      run: failedRun,
      runStep: makeRunStep({ id: 'failed_step', step: 'failed' })
    });
    const runs = makeFakeRunRepo({
      findById,
      recordRunLifecycleStart: vi.fn().mockResolvedValue({ run: runAtDispatch, runStep: makeRunStep({ step: 'spec.author', phase: 'spec' }) }),
      recordRunStepTransition
    });
    const unitRun = vi.fn().mockRejectedValue(new Error('provider token secret=do-not-log'));
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun }, logger });

    await orchestrator.createRun({ topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature' });

    await vi.waitFor(() => expect(recordRunStepTransition).toHaveBeenCalledWith(expect.objectContaining({ currentStep: 'failed' })));
    expect(logger.warn).toHaveBeenCalledWith(
      'Auto-dispatch failed after a committed run transition.',
      expect.objectContaining({ runId: 'run_1', tenant: 'tenant_1', code: 'unexpected_error' })
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('do-not-log');
  });

  it('records auto_dispatch_failed reason when auto-dispatch fails an eligible run', async () => {
    // spec.author is an AI step — it goes through the unit of work and can fail there.
    const runAtDispatch = makeRun({ currentStep: 'spec.author' });
    const failedRun = makeRun({ currentStep: 'failed', terminal: true, failureReason: 'auto_dispatch_failed' });
    // findById is called: (1) dispatch pre-check, (2) failure handler re-read, (3) applyDirective guard, (4) applyRunDirective
    const findById = vi.fn()
      .mockResolvedValueOnce(runAtDispatch)
      .mockResolvedValueOnce(runAtDispatch)
      .mockResolvedValueOnce(runAtDispatch)
      .mockResolvedValueOnce(runAtDispatch);
    const recordRunStepTransition = vi.fn().mockResolvedValue({
      run: failedRun,
      runStep: makeRunStep({ id: 'failed_step', step: 'failed' })
    });
    const runs = makeFakeRunRepo({
      findById,
      recordRunLifecycleStart: vi.fn().mockResolvedValue({ run: runAtDispatch, runStep: makeRunStep({ step: 'spec.author', phase: 'spec' }) }),
      recordRunStepTransition
    });
    const unitRun = vi.fn().mockRejectedValue(new Error('unexpected unit failure'));
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun } });

    await orchestrator.createRun({ topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature' });

    await vi.waitFor(() => expect(recordRunStepTransition).toHaveBeenCalledWith(expect.objectContaining({ currentStep: 'failed' })));
    const transitionCall = recordRunStepTransition.mock.calls[0]?.[0];
    expect(transitionCall?.failureReason).toBe('auto_dispatch_failed');
  });

  it('does not overwrite human or terminal state from a detached failure handler', async () => {
    const logger = { warn: vi.fn() };
    // spec.author is an AI step — it goes through the unit of work and can fail there.
    const runs = makeFakeRunRepo({
      recordRunLifecycleStart: vi.fn().mockResolvedValue({ run: makeRun({ currentStep: 'spec.author' }), runStep: makeRunStep({ step: 'spec.author', phase: 'spec' }) }),
      findById: vi.fn()
        .mockResolvedValueOnce(makeRun({ currentStep: 'spec.author' }))
        .mockResolvedValueOnce(makeRun({ currentStep: 'spec.human_review' })),
      recordRunStepTransition: vi.fn()
    });
    const unitRun = vi.fn().mockRejectedValue(new Error('runner unavailable'));
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun }, logger });

    await orchestrator.createRun({ topicId: 'topic_1', owner, tenant: 'tenant_1', workKind: 'feature' });
    await vi.waitFor(() => expect(unitRun).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runs.recordRunStepTransition).not.toHaveBeenCalled();
  });

  it.each([
    ['done'],
    ['failed'],
    ['canceled']
  ] as const)('does not auto-dispatch terminal step %s', async (step) => {
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'spec.author' })),
      recordRunStepTransition: vi.fn().mockResolvedValue({
        run: makeRun({ currentStep: step, terminal: true }),
        runStep: makeRunStep({ id: `${step}_step`, step })
      })
    });
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun } });

    await orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unitRun).not.toHaveBeenCalled();
  });

  it('logs and skips auto-dispatch for an unknown destination step', async () => {
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const logger = { warn: vi.fn() };
    const unknownRun = makeRun({ currentStep: 'not.catalogued' as unknown as Run['currentStep'] });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'intake' })),
      recordRunStepTransition: vi.fn().mockResolvedValue({
        run: unknownRun,
        runStep: makeRunStep({ id: 'step_unknown', step: 'not.catalogued' as unknown as RunStep['step'] })
      })
    });
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun }, logger });

    await orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unitRun).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Unknown run step encountered while evaluating auto-dispatch eligibility.',
      { runId: 'run_1', tenant: 'tenant_1', currentStep: 'not.catalogued' }
    );
  });

  it('threads unit-of-work fail reason through to the persisted run and published event', async () => {
    const existing = makeRun({ currentStep: 'spec.author' });
    const failed = makeRun({ currentStep: 'failed', terminal: true, failureReason: 'provider_auth_failed' });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'fail', reason: 'provider_auth_failed' })
    };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, events: publisher, autoDispatch: { enabled: false } });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(result.run.failureReason).toBe('provider_auth_failed');
    // The recordRunStepTransition call should have received failureReason
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.failureReason).toBe('provider_auth_failed');
    // The published event's run should carry the failure reason
    expect(events).toHaveLength(1);
    expect(events[0]?.run.failureReason).toBe('provider_auth_failed');
  });

  it('normalizes an unsafe unit-of-work fail reason before persisting', async () => {
    const existing = makeRun({ currentStep: 'spec.author' });
    const failed = makeRun({ currentStep: 'failed', terminal: true, failureReason: 'runner_failed_before_terminal_result' });
    const failedStep = makeRunStep({ step: 'failed' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unsafeReason = '401 raw provider body token=sk-test-secret /Users/mark/private authorization: Bearer sec_secret_handle_value raw SDK diagnostic';
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'fail', reason: unsafeReason })
    };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, events: publisher, autoDispatch: { enabled: false } });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(result.run.failureReason).toBe('runner_failed_before_terminal_result');
    // The unsafe content must not appear in the transition call
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.failureReason).toBe('runner_failed_before_terminal_result');
    expectNoSentinels(JSON.stringify(transitionCall));
    // Events must not leak the unsafe content either
    expectNoSentinels(JSON.stringify(events));
  });

  it('auto-dispatches system and ai steps but not human or terminal steps', async () => {
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const logger = { warn: vi.fn() };
    // applyDirective transitions intake->spec.author, triggering auto-dispatch.
    // dispatch() reads the run fresh — return spec.author so it goes through unitRun.
    const runs = makeFakeRunRepo({
      findById: vi.fn()
        // 1st call: applyDirective guard check reads run at intake
        .mockResolvedValueOnce(makeRun({ currentStep: 'intake' }))
        // 2nd call: applyRunDirective reads run to perform transition
        .mockResolvedValueOnce(makeRun({ currentStep: 'intake' }))
        // 3rd call: auto-dispatched dispatch() reads the run — now at spec.author (an AI step)
        .mockResolvedValueOnce(makeRun({ currentStep: 'spec.author' }))
        // 4th call: applyDirective guard check inside the auto-dispatched dispatch path
        .mockResolvedValueOnce(makeRun({ currentStep: 'spec.author' }))
        // 5th call: applyRunDirective reads run again to perform 2nd transition
        .mockResolvedValueOnce(makeRun({ currentStep: 'spec.author' })),
      recordRunStepTransition: vi
        .fn()
        // 1st: explicit applyDirective intake->spec.author (triggers auto-dispatch)
        .mockResolvedValueOnce({
          run: makeRun({ currentStep: 'spec.author' }),
          runStep: makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' })
        })
        // 2nd: auto-dispatched applyDirective (spec.author->spec.human_review — human, no further dispatch)
        .mockResolvedValueOnce({
          run: makeRun({ currentStep: 'spec.human_review' }),
          runStep: makeRunStep({ id: 'step_3', step: 'spec.human_review', phase: 'spec' })
        })
    });
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork: { run: unitRun }, logger });

    await orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1' });

    // Wait for the detached auto-dispatch to complete
    await vi.waitFor(() => expect(unitRun).toHaveBeenCalledTimes(1));
    expect(unitRun.mock.calls[0]?.[0]).toMatchObject({ runId: 'run_1', tenant: 'tenant_1' });

    // spec.human_review is human-waiting — no further auto-dispatch
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unitRun).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Unknown run step'), expect.anything());
  });
});

describe('DefaultOrchestrator.dispatch — reviewed step selection', () => {
  function makeConvergenceEngine(result: Awaited<ReturnType<ConvergenceEngine['run']>>): { engine: ConvergenceEngine; calls: ConvergenceEngineInput[] } {
    const calls: ConvergenceEngineInput[] = [];
    const engine: ConvergenceEngine = {
      run: vi.fn(async (input: ConvergenceEngineInput) => {
        calls.push(input);
        return result;
      })
    };
    return { engine, calls };
  }

  const advanceCheckpoint = {
    kind: 'convergence_review' as const,
    step: 'spec.author',
    maxRounds: 3,
    routing: { distinct: true },
    rounds: [],
    outcome: 'converged' as const,
    openFeedbackIds: [],
    lastPositions: {},
    currentAltitude: 'build' as const,
    acceptedCheckpoints: []
  };

  it('keeps spec.author on one-shot path even when convergence engine is present', async () => {
    // spec.author carries both implementer+reviewer roles but is excluded from convergence to
    // preserve its #runSpecAuthoringCompletion path. Only implementation.build is convergence-routed.
    const existing = makeRun({ currentStep: 'spec.author' });
    const updated = makeRun({ currentStep: 'spec.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.human_review', phase: 'spec' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: advanceCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: advanceCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // Convergence engine must NOT be invoked for spec.author
    expect(calls).toHaveLength(0);
    expect(unitRun).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('spec.human_review');
  });

  it('delegates implementation.build to convergence engine', async () => {
    const existing = makeRun({ currentStep: 'implementation.build' });
    const updated = makeRun({ currentStep: 'implementation.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.human_review', phase: 'implementation' });
    const currentRunStep = makeRunStep({ step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([currentRunStep])
    });
    const unitRun = vi.fn();
    const buildCheckpoint = { ...advanceCheckpoint, step: 'implementation.build' };
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: buildCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: buildCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      unitOfWork: { run: unitRun },
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(unitRun).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: 'run_1', run: existing, tenant: 'tenant_1' });
    expect(result.run.currentStep).toBe('implementation.human_review');
  });

  it('keeps implementation.plan on passthrough path (no convergence engine, no unit of work)', async () => {
    const existing = makeRun({ currentStep: 'implementation.plan' });
    const updated = makeRun({ currentStep: 'implementation.build' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'advance' },
      checkpointResult: advanceCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // implementation.plan uses deterministic passthrough — neither convergence engine nor unit of work
    expect(calls).toHaveLength(0);
    expect(unitRun).not.toHaveBeenCalled();
    expect(result.run.currentStep).toBe('implementation.build');
  });

  it('keeps pr.finalize on one-shot path (reviewer-only step)', async () => {
    const existing = makeRun({ currentStep: 'pr.finalize' });
    const updated = makeRun({ currentStep: 'pr.open' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'pr.open', phase: 'pr' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({
      directive: 'advance',
      result: { directive: 'advance', reconciledSummary: 'ok', titleSubject: 'feat', validationSummary: [], findings: [] }
    });
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'advance' },
      checkpointResult: advanceCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // pr.finalize has only ['reviewer'], not both roles — one-shot path
    expect(calls).toHaveLength(0);
    expect(unitRun).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('pr.open');
  });

  it('applies returned convergence directives through centralized transition path', async () => {
    const existing = makeRun({ currentStep: 'implementation.build' });
    const updated = makeRun({ currentStep: 'implementation.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.human_review', phase: 'implementation' });
    const currentRunStep = makeRunStep({ step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn()
        .mockResolvedValueOnce(existing)
        // applyDirective re-reads the run
        .mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([currentRunStep])
    });
    const buildCheckpoint = { ...advanceCheckpoint, step: 'implementation.build' };
    const { engine } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: buildCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: buildCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // The advance directive from convergence engine flowed through applyDirective
    expect(recordTransition).toHaveBeenCalledTimes(1);
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    // recordRunStepTransition receives { runId, currentStep, terminal, runStep, failureReason, ... }
    expect(transitionCall?.currentStep).toBe('implementation.human_review');
    expect(result.run.currentStep).toBe('implementation.human_review');
  });

  it('applies fail directive when convergence engine returns fail', async () => {
    const existing = makeRun({ currentStep: 'implementation.build' });
    const failed = makeRun({ currentStep: 'failed', terminal: true });
    const failedStep = makeRunStep({ step: 'failed' });
    const currentRunStep = makeRunStep({ step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: failed, runStep: failedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([currentRunStep])
    });
    const failCheckpoint = { ...advanceCheckpoint, step: 'implementation.build', outcome: 'max_rounds' as const };
    const { engine } = makeConvergenceEngine({
      workResult: { directive: 'fail', reason: 'convergence_max_rounds' },
      checkpointResult: failCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(result.run.currentStep).toBe('failed');
    expect(result.run.terminal).toBe(true);
    // recordRunStepTransition receives { currentStep, terminal, ... } — fail lands at 'failed'
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.currentStep).toBe('failed');
  });

  it('passes the run step matching currentStep (not the first run step) to convergence engine', async () => {
    // Regression: orchestrator used runSteps[0] instead of runSteps.find(s => s.step === run.currentStep)
    const existing = makeRun({ currentStep: 'implementation.build' });
    const updated = makeRun({ currentStep: 'implementation.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.human_review', phase: 'implementation' });
    // Earlier step that must NOT be picked
    const priorRunStep = makeRunStep({ id: 'step_0', step: 'spec.author', phase: 'spec' });
    const currentRunStep = makeRunStep({ id: 'step_1', step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    // listByRun returns prior step first — orchestrator must not pick it
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([priorRunStep, currentRunStep])
    });
    const buildCheckpoint = { ...advanceCheckpoint, step: 'implementation.build' };
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: buildCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: buildCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(calls).toHaveLength(1);
    // The convergence engine must receive the implementation.build step, not spec.author
    expect(calls[0]?.runStep.step).toBe('implementation.build');
  });
});

describe('reviewed step integration — transitions and checkpoint persistence', () => {
  function makeConvergenceEngine(result: Awaited<ReturnType<ConvergenceEngine['run']>>): { engine: ConvergenceEngine; calls: ConvergenceEngineInput[] } {
    const calls: ConvergenceEngineInput[] = [];
    const engine: ConvergenceEngine = {
      run: vi.fn(async (input: ConvergenceEngineInput) => {
        calls.push(input);
        return result;
      })
    };
    return { engine, calls };
  }

  const convergedCheckpoint = {
    kind: 'convergence_review' as const,
    step: 'spec.author',
    maxRounds: 3,
    routing: { distinct: true },
    rounds: [],
    outcome: 'converged' as const,
    openFeedbackIds: [],
    lastPositions: {},
    currentAltitude: 'build' as const,
    acceptedCheckpoints: []
  };

  it('spec.author stays on one-shot path (not routed through convergence engine)', async () => {
    // spec.author carries both implementer+reviewer roles but must NOT go through convergence —
    // it has a separate spec-artifact completion step (#runSpecAuthoringCompletion) that the
    // convergence branch never calls. Scoping convergence to implementation.build only prevents
    // that regression.
    const existing = makeRun({ currentStep: 'spec.author' });
    const updated = makeRun({ currentStep: 'spec.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.human_review', phase: 'spec' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: convergedCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: convergedCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // Convergence engine must NOT be called for spec.author
    expect(calls).toHaveLength(0);
    expect(unitRun).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('spec.human_review');
  });

  it('implementation.build convergence advances run to implementation.human_review', async () => {
    const existing = makeRun({ currentStep: 'implementation.build' });
    const updated = makeRun({ currentStep: 'implementation.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.human_review', phase: 'implementation' });
    const currentRunStep = makeRunStep({ step: 'implementation.build', phase: 'implementation' });
    const buildCheckpoint = { ...convergedCheckpoint, step: 'implementation.build' };
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([currentRunStep])
    });
    const { engine } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: buildCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: buildCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(result.run.currentStep).toBe('implementation.human_review');
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.currentStep).toBe('implementation.human_review');
  });

  it('implementation.build max-round exhaustion via one-shot path (spec.author stays on one-shot path)', async () => {
    // Verify spec.author is NOT sent to convergence even with convergence engine present.
    // spec.author carries both roles but is excluded from convergence to preserve its
    // #runSpecAuthoringCompletion path.
    const existing = makeRun({ currentStep: 'spec.author' });
    const updated = makeRun({ currentStep: 'spec.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.human_review', phase: 'spec' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const escalatedCheckpoint = { ...convergedCheckpoint, outcome: 'max_rounds' as const };
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'needs_input', question: 'Convergence escalated: max_rounds' },
      checkpointResult: escalatedCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // Convergence engine must NOT be called for spec.author
    expect(calls).toHaveLength(0);
    expect(unitRun).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('spec.human_review');
  });

  it('implementation.build max-round exhaustion transitions run to implementation.awaiting_input', async () => {
    const existing = makeRun({ currentStep: 'implementation.build' });
    const awaitingInput = makeRun({ currentStep: 'implementation.awaiting_input' });
    const awaitingStep = makeRunStep({ id: 'step_2', step: 'implementation.awaiting_input', phase: 'implementation' });
    const currentRunStep = makeRunStep({ step: 'implementation.build', phase: 'implementation' });
    const escalatedCheckpoint = { ...convergedCheckpoint, step: 'implementation.build', outcome: 'max_rounds' as const };
    const recordTransition = vi.fn().mockResolvedValue({ run: awaitingInput, runStep: awaitingStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([currentRunStep])
    });
    const { engine } = makeConvergenceEngine({
      workResult: { directive: 'needs_input', question: 'Convergence escalated: max_rounds' },
      checkpointResult: escalatedCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // implementation.awaiting_input is the needs_input target for implementation.build
    expect(result.run.currentStep).toBe('implementation.awaiting_input');
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.currentStep).toBe('implementation.awaiting_input');
  });

  it('implementation.plan uses passthrough (not convergence engine) when convergence engine is present', async () => {
    const existing = makeRun({ currentStep: 'implementation.plan' });
    const updated = makeRun({ currentStep: 'implementation.build' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const { engine, calls } = makeConvergenceEngine({
      workResult: { directive: 'advance' },
      checkpointResult: convergedCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      unitOfWork: { run: unitRun },
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // implementation.plan uses deterministic passthrough — must NOT use convergence engine or unit of work
    expect(calls).toHaveLength(0);
    expect(unitRun).not.toHaveBeenCalled();
    expect(result.run.currentStep).toBe('implementation.build');
  });

  it('keeps runner-origin advance blocked at implementation human review', async () => {
    const existing = makeRun({ currentStep: 'implementation.human_review' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing)
    });
    const { orchestrator } = makeOrchestrator({ runs });

    await expect(
      orchestrator.applyDirective({ runId: 'run_1', directive: 'advance', tenant: 'tenant_1', origin: 'runner' })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
  });

  it('convergence checkpoint is stored on the run step after successful advance', async () => {
    const existing = makeRun({ currentStep: 'implementation.build' });
    const updated = makeRun({ currentStep: 'implementation.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.human_review', phase: 'implementation' });
    const currentRunStep = makeRunStep({ step: 'implementation.build', phase: 'implementation' });
    const buildCheckpoint = { ...convergedCheckpoint, step: 'implementation.build' };
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([currentRunStep])
    });
    const { engine } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: buildCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: buildCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      convergenceEngine: engine,
      autoDispatch: { enabled: false }
    });

    await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    // The transition call must carry the convergence checkpoint so it gets persisted on the run step
    const transitionCall = recordTransition.mock.calls[0]?.[0];
    expect(transitionCall?.checkpointResult).toBeDefined();
    expect(transitionCall?.checkpointResult).toMatchObject({ kind: 'convergence_review', outcome: 'converged' });
  });

  it('clean first-round convergence (no findings, no dispositions) produces a non-empty cumulativeSummary', async () => {
    // Regression: a clean first-round convergence has no fixed dispositions, so the cumulative
    // summary previously had an empty narrative. The orchestrator must generate a fallback.
    const existing = makeRun({ currentStep: 'implementation.build' });
    const updated = makeRun({ currentStep: 'implementation.human_review' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.human_review', phase: 'implementation' });
    const currentRunStep = makeRunStep({ step: 'implementation.build', phase: 'implementation' });
    const cleanRoundCheckpoint = {
      kind: 'convergence_review' as const,
      step: 'implementation.build',
      maxRounds: 3,
      routing: { distinct: true },
      rounds: [
        {
          round: 1,
          changedFileCount: 5,
          findings: [],
          dispositions: [],
          outcome: 'converged' as const,
          altitude: 'build' as const
        }
      ],
      outcome: 'converged' as const,
      openFeedbackIds: [],
      lastPositions: {}
    };
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([currentRunStep])
    });
    const { engine } = makeConvergenceEngine({
      workResult: { directive: 'advance', result: cleanRoundCheckpoint as unknown as Readonly<Record<string, unknown>> },
      checkpointResult: cleanRoundCheckpoint
    });

    const { orchestrator } = makeOrchestrator({
      runs,
      runSteps,
      convergenceEngine: engine,
      clock: () => '2026-06-17T00:00:00.000Z',
      autoDispatch: { enabled: false }
    });

    await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    const transitionCall = recordTransition.mock.calls[0]?.[0];
    const checkpoint = transitionCall?.checkpointResult as { cumulativeSummary?: { cumulativeSummary?: string } };
    expect(checkpoint?.cumulativeSummary).toBeDefined();
    // Must have a non-empty implementation narrative, not just an empty string
    expect(checkpoint?.cumulativeSummary?.cumulativeSummary).toBeTruthy();
    expect(checkpoint?.cumulativeSummary?.cumulativeSummary).toContain('Round 1');
  });
});

// ---------------------------------------------------------------------------
// replyToRun helpers
// ---------------------------------------------------------------------------

function makeFakeFeedbackRepo2(items: Feedback[] = []): FeedbackRepository {
  const store: Feedback[] = [...items];
  return {
    create: vi.fn(async (input) => {
      const item = { id: `fb_${store.length + 1}`, ...input, createdAt: timestamp, updatedAt: timestamp } as Feedback;
      store.push(item);
      return item;
    }),
    findById: vi.fn(async (id) => store.find(f => f.id === id) ?? null),
    listByRun: vi.fn(async (_runId) => [...store]),
    updateStatusAndAppendThread: vi.fn(async (input) => {
      const item = store.find(f => f.id === input.feedbackId);
      if (!item) throw new Error('Not found');
      const updated = { ...item, status: input.nextStatus, thread: [...item.thread, input.threadEntry], updatedAt: input.updatedAt };
      const idx = store.findIndex(f => f.id === input.feedbackId);
      store[idx] = updated;
      return updated;
    }),
    appendThreadEntry: vi.fn()
  };
}

function makeFeedbackLifecycleDeps(items: Feedback[] = []): FeedbackLifecycleDependencies & { feedback: FeedbackRepository } {
  return {
    feedback: makeFakeFeedbackRepo2(items),
    ids: () => `id_${Math.random().toString(36).slice(2)}`,
    clock: () => timestamp
  };
}

function makeOpenImplementationFeedback(): Feedback {
  return {
    id: 'fb_open_1',
    runId: 'run_1',
    owner,
    tenant: 'tenant_1',
    target: 'implementation',
    status: 'open',
    title: 'Change this',
    body: 'Some body',
    thread: [],
    createdAt: timestamp,
    updatedAt: timestamp
  } as Feedback;
}

describe('DefaultOrchestrator.replyToRun', () => {
  // --- spec.human_review approve ---

  it('spec gate approval — advances run from spec.human_review and returns advance classification', async () => {
    const existing = makeRun({ currentStep: 'spec.human_review' });
    const updated = makeRun({ currentStep: 'implementation.plan' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.plan', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps();
    const specApprovalFinalizerDependencies = makeDefaultApprovalFinalDeps();
    const resolveWorkspaceContext = vi.fn().mockResolvedValue({ workspaceRepoRoot: '/tmp', workspaceHandle: 'ws_1' });

    const { orchestrator } = makeOrchestrator({
      runs,
      feedbackLifecycleDependencies,
      specApprovalFinalizerDependencies,
      resolveWorkspaceContext
    });

    const input: ReplyToRunInput = {
      runId: 'run_1',
      tenant: 'tenant_1',
      principal: principal('phoebe'),
      request: { kind: 'approve' }
    };

    const result = await orchestrator.replyToRun(input);

    expect(result.run.currentStep).toBe('implementation.plan');
    expect(result.classification).toEqual({ directive: 'advance', target: 'artifact' });
  });

  // --- implementation.human_review feedback ---

  it('implementation gate feedback — revises run and returns revise classification with createdFeedbackId', async () => {
    const existing = makeRun({ currentStep: 'implementation.human_review' });
    const updated = makeRun({ currentStep: 'implementation.build' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps();

    const { orchestrator } = makeOrchestrator({
      runs,
      feedbackLifecycleDependencies
    });

    const request: RunReplyRequest = {
      kind: 'feedback',
      title: 'Fix the tests',
      body: 'The tests are broken'
    };

    const input: ReplyToRunInput = {
      runId: 'run_1',
      tenant: 'tenant_1',
      principal: principal('phoebe'),
      request
    };

    const result = await orchestrator.replyToRun(input);

    expect(result.run.currentStep).toBe('implementation.build');
    expect(result.classification.directive).toBe('revise');
    expect(result.classification.target).toBe('implementation');
    expect(result.classification.createdFeedbackId).toBeDefined();
    expect(typeof result.classification.createdFeedbackId).toBe('string');
  });

  // --- implementation.human_review approval blocked by open feedback ---

  it('implementation gate approval blocked by open feedback — throws invalid_transition with feedback_gate_blocked details', async () => {
    const openFeedback = makeOpenImplementationFeedback();
    const existing = makeRun({ currentStep: 'implementation.human_review' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn()
    });
    // Provide open implementation feedback — it will block the gate
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps([openFeedback]);

    const { orchestrator } = makeOrchestrator({
      runs,
      feedbackLifecycleDependencies
    });

    const input: ReplyToRunInput = {
      runId: 'run_1',
      tenant: 'tenant_1',
      principal: principal('phoebe'),
      request: { kind: 'approve' }
    };

    await expect(orchestrator.replyToRun(input)).rejects.toMatchObject({
      name: 'OrchestratorError',
      code: 'invalid_transition'
    });

    try {
      await orchestrator.replyToRun(input);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
      const err = error as { details: unknown };
      expect(err.details).toMatchObject({ code: 'feedback_gate_blocked' });
    }
  });

  // --- serialization: two concurrent feedback replies ---

  it('two concurrent feedback replies to the same run are serialized — run transitions happen in order', async () => {
    const existing = makeRun({ currentStep: 'implementation.human_review' });
    const reviseRun = makeRun({ currentStep: 'implementation.build' });
    const reviseStep = makeRunStep({ id: 'step_2', step: 'implementation.build', phase: 'implementation' });

    const executionOrder: string[] = [];

    // Record transition fires in order — first and second call both succeed
    let callCount = 0;
    const recordTransition = vi.fn(async () => {
      callCount++;
      executionOrder.push(`transition_${callCount}`);
      return { run: reviseRun, runStep: reviseStep };
    });

    // findById always returns the existing run
    const findById = vi.fn().mockResolvedValue(existing);
    const runs = makeFakeRunRepo({ findById, recordRunStepTransition: recordTransition });
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps();

    const { orchestrator } = makeOrchestrator({ runs, feedbackLifecycleDependencies });

    const request: RunReplyRequest = { kind: 'feedback', title: 'Fix', body: 'Please fix' };
    const reply = () => orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request });

    // Start two concurrent replies — the queue serializes them
    const [r1, r2] = await Promise.allSettled([reply(), reply()]);

    // Both succeed (same mock state)
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');

    // Transitions run strictly in order — NOT interleaved
    expect(executionOrder).toEqual(['transition_1', 'transition_2']);
  });

  // --- missing run ---

  it('throws missing_run when run does not exist', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps();
    const { orchestrator } = makeOrchestrator({ runs, feedbackLifecycleDependencies });

    await expect(
      orchestrator.replyToRun({ runId: 'run_x', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'approve' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'missing_run' });
  });

  // --- terminal run ---

  it('throws terminal_run when run is already terminal', async () => {
    const existing = makeRun({ currentStep: 'done', terminal: true });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps();
    const { orchestrator } = makeOrchestrator({ runs, feedbackLifecycleDependencies });

    await expect(
      orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'approve' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'terminal_run' });
  });

  // --- guidance reply at human_review gate ---

  it('throws invalid_transition when guidance reply sent to human_review gate', async () => {
    const existing = makeRun({ currentStep: 'implementation.human_review' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps();
    const { orchestrator } = makeOrchestrator({ runs, feedbackLifecycleDependencies });

    await expect(
      orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'guidance', body: 'Go here' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
  });

  // --- non-gate step ---

  it('throws invalid_transition when run is not at a gate step', async () => {
    const existing = makeRun({ currentStep: 'spec.author' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    const feedbackLifecycleDependencies = makeFeedbackLifecycleDeps();
    const { orchestrator } = makeOrchestrator({ runs, feedbackLifecycleDependencies });

    await expect(
      orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'approve' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
  });

  // --- missing feedbackLifecycleDependencies ---

  it('throws persistence_failed when feedbackLifecycleDependencies not configured', async () => {
    const existing = makeRun({ currentStep: 'implementation.human_review' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    // No feedbackLifecycleDependencies
    const { orchestrator } = makeOrchestrator({ runs });

    await expect(
      orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'approve' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });
  });

  // --- implementation.awaiting_input guidance ---

  it('records convergence guidance and advances awaiting input to implementation.build', async () => {
    const awaitingStep = makeRunStep({
      id: 'step_awaiting',
      step: 'implementation.awaiting_input',
      checkpointResult: {
        pause: { kind: 'convergence_escalation', producingStep: 'implementation.build' }
      }
    });
    const existing = makeRun({ currentStep: 'implementation.awaiting_input' });
    const advanced = makeRun({ currentStep: 'implementation.build' });
    const advancedStep = makeRunStep({ id: 'step_build', step: 'implementation.build', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: advanced, runStep: advancedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const updateCheckpoint = vi.fn().mockResolvedValue(awaitingStep);
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([awaitingStep]),
      updateCheckpoint
    });

    const { orchestrator } = makeOrchestrator({ runs, runSteps });

    const result = await orchestrator.replyToRun({
      runId: 'run_1',
      tenant: 'tenant_1',
      principal: principal('phoebe'),
      request: { kind: 'guidance', body: 'Prefer public API; do not broaden auth.' }
    });

    expect(result.classification).toEqual({ directive: 'advance', pauseKind: 'convergence_escalation' });
    expect(result.run.currentStep).toBe('implementation.build');

    // First call: recordConvergenceEscalationGuidance stamps awaiting_input step
    const firstCall = updateCheckpoint.mock.calls[0]?.[0];
    expect(firstCall?.runStepId).toBe('step_awaiting');
    const awaitingCp = firstCall?.checkpointResult as { pause: { kind: string; humanGuidance: string } };
    expect(awaitingCp.pause.kind).toBe('convergence_escalation');
    expect(awaitingCp.pause.humanGuidance).toBe('Prefer public API; do not broaden auth.');

    // Second call: #replyToAwaitingInput stamps the new implementation.build step
    // so build dispatch reads guidance from the current execution context.
    expect(updateCheckpoint).toHaveBeenCalledTimes(2);
    const secondCall = updateCheckpoint.mock.calls[1]?.[0];
    expect(secondCall?.runStepId).toBe('step_build');
    const buildCp = secondCall?.checkpointResult as { resumedFromAwaitingInputStepId: string; humanGuidance: string };
    expect(buildCp.resumedFromAwaitingInputStepId).toBe('step_awaiting');
    expect(buildCp.humanGuidance).toBe('Prefer public API; do not broaden auth.');
  });

  it('build dispatch reads humanGuidance from current build step checkpoint', async () => {
    const buildStep = makeRunStep({
      id: 'step_build',
      step: 'implementation.build',
      phase: 'implementation',
      checkpointResult: {
        resumedFromAwaitingInputStepId: 'step_awaiting',
        humanGuidance: 'Use the public API path only.'
      }
    });
    const existing = makeRun({ currentStep: 'implementation.build' });
    const convergedRun = makeRun({ currentStep: 'implementation.human_review' });
    const convergedStep = makeRunStep({ step: 'implementation.human_review', phase: 'implementation' });
    const recordTransition = vi.fn().mockResolvedValue({ run: convergedRun, runStep: convergedStep });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: recordTransition
    });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([buildStep])
    });
    const capturedGuidance: (string | undefined)[] = [];
    const validCheckpoint = {
      kind: 'convergence_review' as const,
      step: 'implementation.build',
      maxRounds: 3,
      routing: { distinct: true },
      rounds: [],
      outcome: 'converged' as const,
      openFeedbackIds: [],
      lastPositions: {},
      currentAltitude: 'build' as const,
      acceptedCheckpoints: []
    };
    const fakeConvergenceEngine: ConvergenceEngine = {
      run: vi.fn(async (engineInput: ConvergenceEngineInput) => {
        capturedGuidance.push(engineInput.humanGuidance);
        return { workResult: { directive: 'advance' as const }, checkpointResult: validCheckpoint };
      })
    };

    const { orchestrator } = makeOrchestrator({ runs, runSteps, convergenceEngine: fakeConvergenceEngine, autoDispatch: { enabled: false } });

    await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(capturedGuidance[0]).toBe('Use the public API path only.');
  });

  it('throws invalid_transition when non-guidance reply sent to implementation.awaiting_input', async () => {
    const awaitingStep = makeRunStep({
      id: 'step_awaiting',
      step: 'implementation.awaiting_input',
      checkpointResult: {
        pause: { kind: 'convergence_escalation', producingStep: 'implementation.build' }
      }
    });
    const existing = makeRun({ currentStep: 'implementation.awaiting_input' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([awaitingStep])
    });

    const { orchestrator } = makeOrchestrator({ runs, runSteps });

    await expect(
      orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'approve' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition' });
  });

  it('throws persistence_failed when runSteps not configured and run is at awaiting_input', async () => {
    const existing = makeRun({ currentStep: 'implementation.awaiting_input' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    // No runSteps
    const { orchestrator } = makeOrchestrator({ runs });

    await expect(
      orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'guidance', body: 'fix it' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'persistence_failed' });
  });

  it('throws invalid_transition for unsupported pause kind at implementation.awaiting_input', async () => {
    const awaitingStep = makeRunStep({
      id: 'step_awaiting',
      step: 'implementation.awaiting_input',
      checkpointResult: null  // null checkpoint = not a convergence escalation
    });
    const existing = makeRun({ currentStep: 'implementation.awaiting_input' });
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    const runSteps = makeFakeRunStepRepo({
      listByRun: vi.fn().mockResolvedValue([awaitingStep])
    });

    const { orchestrator } = makeOrchestrator({ runs, runSteps });

    await expect(
      orchestrator.replyToRun({ runId: 'run_1', tenant: 'tenant_1', principal: principal('phoebe'), request: { kind: 'guidance', body: 'fix it' } })
    ).rejects.toMatchObject({ name: 'OrchestratorError', code: 'invalid_transition', details: { code: 'unsupported_pause' } });
  });
});
