import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Message, Run, RunStateTransitionEvent, RunStep, Topic } from '@autocatalyst/api-contract';

import type { ConversationIngressRepository, RunRepository } from './domain-repositories.js';
import { RunDispatchQueue } from './run-dispatch-queue.js';
import { InMemoryRunEventBus, type RunEventPublisher } from './run-events.js';
import {
  DefaultOrchestrator,
  OrchestratorError,
  type RunUnitOfWork
} from './orchestrator.js';

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
    publisher: { publish: (event) => events.push(event) },
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
    ...(opts.isActiveRunConflict !== undefined ? { isActiveRunConflict: opts.isActiveRunConflict } : {})
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

  it('maps unit-of-work fail result to OrchestratorError (queue slot released)', async () => {
    const existing = makeRun();
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(existing) });
    const unitOfWork: RunUnitOfWork = {
      run: vi.fn().mockResolvedValue({ directive: 'fail', reason: 'nope' })
    };
    const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 1 });
    const { orchestrator } = makeOrchestrator({ runs, unitOfWork, dispatchQueue });

    await expect(
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError' });

    // Slot was released after the failure
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

  it('failed unit releases capacity so subsequent dispatches can proceed', async () => {
    const existing = makeRun({ currentStep: 'intake' });
    const updated = makeRun({ currentStep: 'spec.author' });
    const updatedStep = makeRunStep({ id: 'step_2', step: 'spec.author', phase: 'spec' });
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(existing),
      recordRunStepTransition: vi.fn().mockResolvedValue({ run: updated, runStep: updatedStep })
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

    await expect(
      orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' })
    ).rejects.toMatchObject({ name: 'OrchestratorError' });

    expect(dispatchQueue.activeCount).toBe(0);

    // Second dispatch should succeed because capacity was released.
    const result = await orchestrator.dispatch({ runId: 'run_1', tenant: 'tenant_1' });
    expect(result.run.currentStep).toBe('spec.author');
    expect(dispatchQueue.activeCount).toBe(0);
  });
});

describe('DefaultOrchestrator.tick', () => {
  it('returns { status: "noop" } when no runId is provided', async () => {
    const { orchestrator } = makeOrchestrator();
    const result = await orchestrator.tick({});
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
