import { describe, expect, it, vi } from 'vitest';
import type { Artifact, Conversation, Message, Run, RunStateTransitionEvent, RunStep, Topic } from '@autocatalyst/api-contract';

import type { ConversationIngressRepository, RunRepository } from './domain-repositories.js';
import { RunDispatchQueue } from './run-dispatch-queue.js';
import { InMemoryRunEventBus, type RunEventPublisher } from './run-events.js';
import {
  DefaultOrchestrator,
  OrchestratorError,
  type RunUnitOfWork,
  type WorkspaceContextResolver
} from './orchestrator.js';
import type { SpecAuthoringServiceDependencies } from './spec-authoring-service.js';
import { SpecAuthoringError } from './spec-authoring-service.js';

const timestamp = '2026-06-08T00:00:00.000Z';
const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1', displayName: 'Ada' };

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
    ...(opts.resolveWorkspaceContext !== undefined ? { resolveWorkspaceContext: opts.resolveWorkspaceContext } : {})
  });
  return { orchestrator, runs, conversationIngress, events, dispatchQueue };
}

describe('DefaultOrchestrator.createRun', () => {
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
    const { orchestrator } = makeOrchestrator({ runs, events: publisher });

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
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const findById = vi.fn().mockResolvedValue(existing);
    const recordTransition = vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep });
    const runs = makeFakeRunRepo({
      findById,
      recordRunStepTransition: recordTransition
    });
    const unitRun = vi.fn().mockResolvedValue({ directive: 'advance' });
    const unitOfWork: RunUnitOfWork = { run: unitRun };
    const { publisher, events } = makeRecordingPublisher();
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, events: publisher });

    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });

    expect(unitRun).toHaveBeenCalledTimes(1);
    const unitArg = unitRun.mock.calls[0]?.[0];
    expect(unitArg.runId).toBe('run_1');
    expect(unitArg.run).toEqual(existing);
    expect(unitArg.tenant).toBe('tenant_1');
    // Orchestrator (not the unit) recorded the transition
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect(result.run.currentStep).toBe('spec.author');
    expect(events).toHaveLength(1);
    expect(events[0]?.transition.directive).toBe('advance');
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
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(makeRun()) });
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
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, dispatchQueue });

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
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, dispatchQueue });

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

describe('DefaultOrchestrator.tick', () => {
  it('returns { status: "noop" } when no runId is provided', async () => {
    const { orchestrator } = makeOrchestrator();
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
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork });

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
