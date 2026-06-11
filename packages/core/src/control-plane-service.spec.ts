import { describe, expect, it, vi } from 'vitest';
import type {
  CreateConversationWithFirstRunRequest,
  Principal,
  Run,
  RunStep
} from '@autocatalyst/api-contract';

import { ControlPlaneServiceError, DefaultControlPlaneService } from './control-plane-service.js';
import type { RunRepository, RunStepRepository } from './domain-repositories.js';
import type { Orchestrator, OrchestratedConversationResult } from './orchestrator.js';
import { OrchestratorError } from './orchestrator.js';
import { permissivePolicyDecisionPoint, type PolicyDecisionPoint } from './policy.js';
import { InMemoryRunEventBus, type RunEventStore, type RunEventSubscriber, type RunEventSubscription } from './run-events.js';

const timestamp = '2026-06-08T00:00:00.000Z';
const owner = {
  id: 'user_1',
  kind: 'human' as const,
  tenantId: 'tenant_1',
  displayName: 'Ada'
};
const principal: Principal = owner;

function makeRun(overrides?: Partial<Run>): Run {
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

function makeRunStep(overrides?: Partial<RunStep>): RunStep {
  return {
    id: 'step_1',
    runId: 'run_1',
    phase: 'intake',
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

function makeOrchestratedResult(overrides?: Partial<OrchestratedConversationResult>): OrchestratedConversationResult {
  return {
    conversation: {
      id: 'conv_1',
      projectId: 'proj_1',
      owner,
      tenant: 'tenant_1',
      identity: 'I',
      activeTopicId: 'topic_1',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    topic: {
      id: 'topic_1',
      conversationId: 'conv_1',
      owner,
      tenant: 'tenant_1',
      title: 'T',
      kind: 'main',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    message: {
      id: 'msg_1',
      topicId: 'topic_1',
      owner,
      tenant: 'tenant_1',
      author: owner,
      direction: 'inbound',
      body: 'hello',
      createdAt: timestamp
    } as OrchestratedConversationResult['message'],
    run: makeRun(),
    runStep: makeRunStep(),
    ...overrides
  };
}

function makeFakeOrchestrator(overrides?: Partial<Orchestrator>): Orchestrator {
  return {
    createRun: vi.fn(),
    createConversationWithFirstRun: vi.fn().mockResolvedValue(makeOrchestratedResult()),
    applyDirective: vi.fn(),
    dispatch: vi.fn(),
    tick: vi.fn().mockResolvedValue({ status: 'noop' }),
    ...overrides
  } as Orchestrator;
}

function makeFakeRunRepo(overrides?: Partial<RunRepository>): RunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(makeRun()),
    findActiveByTopic: vi.fn().mockResolvedValue(null),
    listByTopic: vi.fn().mockResolvedValue([]),
    listByTenant: vi.fn().mockResolvedValue([]),
    recordRunLifecycleStart: vi.fn(),
    recordRunStepTransition: vi.fn(),
    ...overrides
  } as RunRepository;
}

function makeFakeRunStepRepo(overrides?: Partial<RunStepRepository>): RunStepRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    listByRun: vi.fn().mockResolvedValue([]),
    ...overrides
  } as RunStepRepository;
}

function makeDenyPolicy(): PolicyDecisionPoint {
  return { authorize: vi.fn().mockResolvedValue({ allowed: false }) };
}

function makeService(options?: {
  orchestrator?: Orchestrator;
  runs?: RunRepository;
  runSteps?: RunStepRepository;
  events?: RunEventStore | RunEventSubscriber;
  policy?: PolicyDecisionPoint;
}) {
  return new DefaultControlPlaneService({
    orchestrator: options?.orchestrator ?? makeFakeOrchestrator(),
    runs: options?.runs ?? makeFakeRunRepo(),
    runSteps: options?.runSteps ?? makeFakeRunStepRepo(),
    events: (options?.events ?? new InMemoryRunEventBus()) as RunEventStore,
    policy: options?.policy ?? permissivePolicyDecisionPoint
  });
}

const baseRequest: CreateConversationWithFirstRunRequest = {
  projectId: 'proj_1',
  identity: 'I',
  topic: { title: 'T' },
  submission: {
    kind: 'free_form',
    body: 'hello',
    workKind: 'feature'
  }
};

describe('DefaultControlPlaneService.createConversationWithFirstRun', () => {
  it('authorizes with conversation.create on the collection resource', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const service = makeService({ policy });
    await service.createConversationWithFirstRun({ principal, tenant: 'tenant_1', request: baseRequest });
    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'conversation.create',
      resource: { kind: 'conversation_collection', path: '/v1/conversations' }
    });
  });

  it('throws forbidden when policy denies', async () => {
    const service = makeService({ policy: makeDenyPolicy() });
    await expect(
      service.createConversationWithFirstRun({ principal, tenant: 'tenant_1', request: baseRequest })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('delegates to orchestrator and returns a valid response', async () => {
    const orchestrator = makeFakeOrchestrator();
    const service = makeService({ orchestrator });
    const result = await service.createConversationWithFirstRun({
      principal,
      tenant: 'tenant_1',
      request: baseRequest
    });
    expect(orchestrator.createConversationWithFirstRun).toHaveBeenCalledTimes(1);
    expect(result.run.id).toBe('run_1');
    expect(result.conversation.id).toBe('conv_1');
    expect(result.topic.id).toBe('topic_1');
    expect(result.runStep.id).toBe('step_1');
  });

  it('omits the message in the response when no message is returned', async () => {
    const orchestrator = makeFakeOrchestrator({
      createConversationWithFirstRun: vi.fn().mockResolvedValue(makeOrchestratedResult({ message: undefined }))
    });
    const service = makeService({ orchestrator });
    const result = await service.createConversationWithFirstRun({
      principal,
      tenant: 'tenant_1',
      request: baseRequest
    });
    expect(result.message).toBeUndefined();
  });

  it('maps unknown_work_kind from orchestrator to intake_routing_error', async () => {
    const orchestrator = makeFakeOrchestrator({
      createConversationWithFirstRun: vi
        .fn()
        .mockRejectedValue(new OrchestratorError('unknown_work_kind', "Unknown work kind 'foo'."))
    });
    const service = makeService({ orchestrator });
    await expect(
      service.createConversationWithFirstRun({ principal, tenant: 'tenant_1', request: baseRequest })
    ).rejects.toMatchObject({ code: 'intake_routing_error' });
  });

  it('maps active_run_conflict from orchestrator to service error with details', async () => {
    const orchestrator = makeFakeOrchestrator({
      createConversationWithFirstRun: vi.fn().mockRejectedValue(
        new OrchestratorError('active_run_conflict', 'conflict', {
          details: { topicId: 'topic_1', existingRunId: 'run_99' }
        })
      )
    });
    const service = makeService({ orchestrator });
    await expect(
      service.createConversationWithFirstRun({ principal, tenant: 'tenant_1', request: baseRequest })
    ).rejects.toMatchObject({
      code: 'active_run_conflict',
      details: { topicId: 'topic_1', existingRunId: 'run_99' }
    });
  });

  it('maps other orchestrator errors to persistence_failed', async () => {
    const orchestrator = makeFakeOrchestrator({
      createConversationWithFirstRun: vi
        .fn()
        .mockRejectedValue(new OrchestratorError('persistence_failed', 'boom'))
    });
    const service = makeService({ orchestrator });
    await expect(
      service.createConversationWithFirstRun({ principal, tenant: 'tenant_1', request: baseRequest })
    ).rejects.toMatchObject({ code: 'persistence_failed' });
  });
});

describe('DefaultControlPlaneService.getRun', () => {
  it('authorizes with run.read on the run resource', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const service = makeService({ policy });
    await service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'run.read',
      resource: { kind: 'run', id: 'run_1', path: '/v1/runs/:id' }
    });
  });

  it('returns the run on success', async () => {
    const service = makeService();
    const result = await service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.run.id).toBe('run_1');
  });

  it('throws not_found when the run is missing', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const service = makeService({ runs });
    await expect(
      service.getRun({ principal, tenant: 'tenant_1', runId: 'missing' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws forbidden on tenant mismatch', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } }))
    });
    const service = makeService({ runs });
    await expect(
      service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws forbidden when policy denies', async () => {
    const service = makeService({ policy: makeDenyPolicy() });
    await expect(
      service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('DefaultControlPlaneService.listRunSteps', () => {
  it('authorizes with run_steps.list on the steps resource', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const service = makeService({ policy });
    await service.listRunSteps({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'run_steps.list',
      resource: { kind: 'run_steps', id: 'run_1', path: '/v1/runs/:id/steps' }
    });
  });

  it('returns steps for the run', async () => {
    const step = makeRunStep();
    const runSteps = makeFakeRunStepRepo({ listByRun: vi.fn().mockResolvedValue([step]) });
    const service = makeService({ runSteps });
    const result = await service.listRunSteps({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.steps).toEqual([step]);
  });

  it('throws not_found when the run is missing', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const service = makeService({ runs });
    await expect(
      service.listRunSteps({ principal, tenant: 'tenant_1', runId: 'missing' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws forbidden on tenant mismatch', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } }))
    });
    const service = makeService({ runs });
    await expect(
      service.listRunSteps({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws forbidden when policy denies', async () => {
    const service = makeService({ policy: makeDenyPolicy() });
    await expect(
      service.listRunSteps({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('DefaultControlPlaneService.subscribeRunEvents', () => {
  it('authorizes with run_events.stream on the events resource', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const service = makeService({ policy });
    const sub = await service.subscribeRunEvents({ principal, tenant: 'tenant_1', runId: 'run_1' });
    sub.close();
    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'run_events.stream',
      resource: { kind: 'run_events', id: 'run_1', path: '/v1/runs/:id/events' }
    });
  });

  it('throws not_found before opening a subscription when the run is missing', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const subscribe = vi.fn();
    const events: RunEventSubscriber = { subscribe };
    const service = makeService({ runs, events });
    await expect(
      service.subscribeRunEvents({ principal, tenant: 'tenant_1', runId: 'missing' })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('throws forbidden on tenant mismatch', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } }))
    });
    const service = makeService({ runs });
    await expect(
      service.subscribeRunEvents({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws forbidden when policy denies', async () => {
    const service = makeService({ policy: makeDenyPolicy() });
    await expect(
      service.subscribeRunEvents({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('returns a live subscription (lastEventId is not passed to subscribe — it is replay-only)', async () => {
    const fakeSub: RunEventSubscription = {
      events: { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined as never, done: true }) }) },
      close: vi.fn()
    };
    const subscribe = vi.fn().mockReturnValue(fakeSub);
    const events = {
      subscribe,
      append: vi.fn(),
      replayAfter: vi.fn().mockResolvedValue({ status: 'ok', events: [] })
    } as unknown as RunEventSubscriber;
    const service = makeService({ events });
    const sub = await service.subscribeRunEvents({
      principal,
      tenant: 'tenant_1',
      runId: 'run_1',
      lastEventId: 'evt_42'
    });
    expect(subscribe).toHaveBeenCalledWith({ runId: 'run_1', tenant: 'tenant_1' });
    expect(sub).toBe(fakeSub);
  });
});

describe('DefaultControlPlaneService.tick', () => {
  it('authorizes with run.tick on the run resource when a runId is provided', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const orchestrator = makeFakeOrchestrator({
      tick: vi.fn().mockResolvedValue({ status: 'dispatched', runId: 'run_1' })
    });
    const service = makeService({ policy, orchestrator });
    await service.tick({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'run.tick',
      resource: { kind: 'run', id: 'run_1', path: '/v1/runs/:id' }
    });
  });

  it('authorizes against the conversation collection when no runId is provided', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const service = makeService({ policy });
    await service.tick({ principal, tenant: 'tenant_1' });
    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'run.tick',
      resource: { kind: 'conversation_collection', path: '/v1/conversations' }
    });
  });

  it('returns noop when no runId is provided', async () => {
    const service = makeService();
    const result = await service.tick({ principal, tenant: 'tenant_1' });
    expect(result).toEqual({ status: 'noop' });
  });

  it('returns dispatched for a specific run', async () => {
    const orchestrator = makeFakeOrchestrator({
      tick: vi.fn().mockResolvedValue({ status: 'dispatched', runId: 'run_1' })
    });
    const service = makeService({ orchestrator });
    const result = await service.tick({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result).toEqual({ status: 'dispatched', runId: 'run_1' });
  });

  it('throws forbidden when policy denies', async () => {
    const service = makeService({ policy: makeDenyPolicy() });
    await expect(
      service.tick({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toBeInstanceOf(ControlPlaneServiceError);
  });

  it('maps a cross-tenant OrchestratorError to a typed ControlPlaneServiceError forbidden', async () => {
    const orchestrator = makeFakeOrchestrator({
      tick: vi.fn().mockRejectedValue(
        new OrchestratorError('forbidden', "Run 'run_1' is not accessible to tenant 'tenant_1'.")
      )
    });
    const service = makeService({ orchestrator });
    const error = await service.tick({ principal, tenant: 'tenant_1', runId: 'run_1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ControlPlaneServiceError);
    expect((error as ControlPlaneServiceError).code).toBe('forbidden');
  });

  it('maps a missing-run OrchestratorError from tick to not_found', async () => {
    const orchestrator = makeFakeOrchestrator({
      tick: vi.fn().mockRejectedValue(new OrchestratorError('missing_run', "Run 'run_1' does not exist."))
    });
    const service = makeService({ orchestrator });
    const error = await service.tick({ principal, tenant: 'tenant_1', runId: 'run_1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ControlPlaneServiceError);
    expect((error as ControlPlaneServiceError).code).toBe('not_found');
  });
});
