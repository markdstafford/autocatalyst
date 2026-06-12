import { describe, expect, it, vi } from 'vitest';
import type {
  Artifact,
  CreateConversationWithFirstRunRequest,
  Feedback,
  Principal,
  Run,
  RunStep
} from '@autocatalyst/api-contract';

import { ControlPlaneServiceError, DefaultControlPlaneService } from './control-plane-service.js';
import type { ArtifactRepository, FeedbackRepository, RunRepository, RunStepRepository, RunWorkspaceMetadata, RunWorkspaceMetadataRepository } from './domain-repositories.js';
import type { Orchestrator, OrchestratedConversationResult } from './orchestrator.js';
import { OrchestratorError } from './orchestrator.js';
import { permissivePolicyDecisionPoint, type PolicyDecisionPoint } from './policy.js';
import { InMemoryRunEventBus, type RunEventStore, type RunEventSubscriber, type RunEventSubscription } from './run-events.js';
import type { WorkspaceFileSystemPort } from './spec-authoring-service.js';

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

const validMarkdown = '---\ncreated: 2026-06-12\nlast_updated: 2026-06-12\nstatus: implementing\nissue: 41\nspecced_by: autocatalyst\n---\n# Spec Title\n';

const validArtifact: Artifact = {
  id: 'art_1',
  runId: 'run_1',
  owner,
  tenant: 'tenant_1',
  kind: 'feature_spec' as const,
  canonicalRecord: 'file' as const,
  location: 'context-human/specs/feature-spec.md',
  cachedStatus: 'draft' as const,
  publicationRefs: [],
  createdAt: timestamp,
  updatedAt: timestamp
};

const validWorkspaceMetadata: RunWorkspaceMetadata = {
  runId: 'run_1',
  workspaceHandle: 'handle_1',
  workspaceRepoRoot: '/tmp/workspace',
  createdAt: timestamp
};

function makeFakeArtifactRepository(artifact?: Artifact | null): ArtifactRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    listByRun: vi.fn(),
    findByRunAndKind: vi.fn().mockResolvedValue(artifact !== undefined ? artifact : validArtifact),
    updateCachedStatus: vi.fn()
  };
}

function makeFakeFeedbackRepository(): FeedbackRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    listByRun: vi.fn().mockResolvedValue([] as readonly Feedback[]),
    updateStatusAndAppendThread: vi.fn()
  };
}

function makeFakeRunWorkspaceMetadataRepository(metadata?: RunWorkspaceMetadata | null): RunWorkspaceMetadataRepository {
  return {
    upsert: vi.fn(),
    findByRunId: vi.fn().mockResolvedValue(metadata !== undefined ? metadata : validWorkspaceMetadata)
  };
}

function makeFakeWorkspaceFilesystem(content?: string): WorkspaceFileSystemPort {
  return {
    writeFile: vi.fn(),
    readFile: vi.fn().mockResolvedValue(content !== undefined ? content : validMarkdown)
  };
}

function makeService(options?: {
  orchestrator?: Orchestrator;
  runs?: RunRepository;
  runSteps?: RunStepRepository;
  events?: RunEventStore | RunEventSubscriber;
  policy?: PolicyDecisionPoint;
  artifacts?: ArtifactRepository;
  runWorkspaceMetadata?: RunWorkspaceMetadataRepository;
  workspaceFilesystem?: WorkspaceFileSystemPort;
}) {
  return new DefaultControlPlaneService({
    orchestrator: options?.orchestrator ?? makeFakeOrchestrator(),
    runs: options?.runs ?? makeFakeRunRepo(),
    runSteps: options?.runSteps ?? makeFakeRunStepRepo(),
    events: (options?.events ?? new InMemoryRunEventBus()) as RunEventStore,
    policy: options?.policy ?? permissivePolicyDecisionPoint,
    artifacts: options?.artifacts ?? makeFakeArtifactRepository(),
    feedback: makeFakeFeedbackRepository(),
    runWorkspaceMetadata: options?.runWorkspaceMetadata ?? makeFakeRunWorkspaceMetadataRepository(),
    workspaceFilesystem: options?.workspaceFilesystem ?? makeFakeWorkspaceFilesystem(),
    feedbackLifecycle: {
      feedback: makeFakeFeedbackRepository(),
      ids: () => 'id_1',
      clock: () => timestamp
    }
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

describe('DefaultControlPlaneService.listRuns', () => {
  it('authorizes with run.list on the run collection resource', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const runs = makeFakeRunRepo({ listByTenant: vi.fn().mockResolvedValue([]) });
    const service = makeService({ policy, runs });

    await service.listRuns({ principal, tenant: 'tenant_1' });

    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'run.list',
      resource: { kind: 'run_collection', path: '/v1/runs' }
    });
  });

  it('calls listByTenant with the input tenant and returns runs', async () => {
    const run = makeRun({ id: 'run_2' });
    const runs = makeFakeRunRepo({ listByTenant: vi.fn().mockResolvedValue([run]) });
    const service = makeService({ runs });

    const result = await service.listRuns({ principal, tenant: 'tenant_1' });

    expect(runs.listByTenant).toHaveBeenCalledWith('tenant_1');
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.id).toBe('run_2');
    expect(result.runs[0]?.waitingOn).toBe('system');
  });

  it('throws forbidden and does not read persistence when policy denies', async () => {
    const runs = makeFakeRunRepo({ listByTenant: vi.fn().mockResolvedValue([makeRun()]) });
    const service = makeService({ policy: makeDenyPolicy(), runs });

    await expect(service.listRuns({ principal, tenant: 'tenant_1' })).rejects.toMatchObject({
      code: 'forbidden'
    });
    expect(runs.listByTenant).not.toHaveBeenCalled();
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

describe('DefaultControlPlaneService.getRunSpec', () => {
  it('returns artifact, markdown, and parsed frontmatter for a valid feature run', async () => {
    const service = makeService();
    const result = await service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.artifact.id).toBe('art_1');
    expect(result.markdown).toBe(validMarkdown);
    expect(result.frontmatter.status).toBe('implementing');
  });

  it('selects enhancement_spec artifact kind for an enhancement run', async () => {
    const enhancementRun = makeRun({ workKind: 'enhancement', id: 'run_1' });
    const enhancementArtifact: Artifact = { ...validArtifact, kind: 'enhancement_spec' };
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(enhancementRun) });
    const artifacts = makeFakeArtifactRepository(enhancementArtifact);
    const service = makeService({ runs, artifacts });
    const result = await service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.artifact.kind).toBe('enhancement_spec');
    expect(artifacts.findByRunAndKind).toHaveBeenCalledWith({ runId: 'run_1', kind: 'enhancement_spec' });
  });

  it('throws not_found when the run is missing', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const service = makeService({ runs });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'missing' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found on cross-tenant run', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ tenant: 'tenant_2', owner: { ...owner, tenantId: 'tenant_2' } }))
    });
    const service = makeService({ runs });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found for unsupported work kind', async () => {
    const runs = makeFakeRunRepo({
      findById: vi.fn().mockResolvedValue(makeRun({ workKind: 'bug' }))
    });
    const service = makeService({ runs });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found when no spec artifact exists', async () => {
    const artifacts = makeFakeArtifactRepository(null);
    const service = makeService({ artifacts });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found when artifact is not file-canonical', async () => {
    const nonFileArtifact: Artifact = { ...validArtifact, canonicalRecord: 'issue' };
    const artifacts = makeFakeArtifactRepository(nonFileArtifact);
    const service = makeService({ artifacts });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws persistence_failed when workspace metadata is missing', async () => {
    const runWorkspaceMetadata = makeFakeRunWorkspaceMetadataRepository(null);
    const service = makeService({ runWorkspaceMetadata });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'persistence_failed' });
  });

  it('throws persistence_failed when workspace metadata lookup throws', async () => {
    const runWorkspaceMetadata: RunWorkspaceMetadataRepository = {
      upsert: vi.fn(),
      findByRunId: vi.fn().mockRejectedValue(new Error('DB error'))
    };
    const service = makeService({ runWorkspaceMetadata });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'persistence_failed' });
  });

  it('throws persistence_failed when file read throws', async () => {
    const workspaceFilesystem: WorkspaceFileSystemPort = {
      writeFile: vi.fn(),
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT'))
    };
    const service = makeService({ workspaceFilesystem });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'persistence_failed' });
  });

  it('throws persistence_failed when frontmatter is malformed', async () => {
    const workspaceFilesystem = makeFakeWorkspaceFilesystem('no frontmatter here\n');
    const service = makeService({ workspaceFilesystem });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'persistence_failed' });
  });

  it('throws forbidden when policy denies', async () => {
    const service = makeService({ policy: makeDenyPolicy() });
    await expect(
      service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('authorizes with run_spec.read on the run_spec resource', async () => {
    const policy: PolicyDecisionPoint = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const service = makeService({ policy });
    await service.getRunSpec({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(policy.authorize).toHaveBeenCalledWith({
      principal,
      action: 'run_spec.read',
      resource: { kind: 'run_spec', id: 'run_1', path: '/v1/runs/:id/spec' }
    });
  });
});

describe('DefaultControlPlaneService run waiting-state', () => {
  it('getRun returns waitingOn: human for spec.human_review step', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'spec.human_review', workKind: 'feature' })) });
    const service = makeService({ runs });
    const result = await service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.run.waitingOn).toBe('human');
  });

  it('getRun returns waitingOn: ai for spec.author step', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'spec.author' })) });
    const service = makeService({ runs });
    const result = await service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.run.waitingOn).toBe('ai');
  });

  it('getRun returns waitingOn: system for intake step', async () => {
    const service = makeService();
    const result = await service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.run.waitingOn).toBe('system');
  });

  it('getRun returns waitingOn: none for done step', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'done', terminal: true })) });
    const service = makeService({ runs });
    const result = await service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.run.waitingOn).toBe('none');
  });

  it('listRuns returns waitingOn for each run', async () => {
    const fakeRunsRepo = makeFakeRunRepo({
      listByTenant: vi.fn().mockResolvedValue([
        makeRun({ id: 'run_1', currentStep: 'spec.human_review', workKind: 'feature' }),
        makeRun({ id: 'run_2', currentStep: 'spec.author', workKind: 'enhancement' })
      ])
    });
    const service = makeService({ runs: fakeRunsRepo });
    const result = await service.listRuns({ principal, tenant: 'tenant_1' });
    expect(result.runs[0]?.waitingOn).toBe('human');
    expect(result.runs[1]?.waitingOn).toBe('ai');
  });

  it('getRun throws persistence_failed for unknown currentStep', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(makeRun({ currentStep: 'unknown.step.xyz' as never })) });
    const service = makeService({ runs });
    await expect(service.getRun({ principal, tenant: 'tenant_1', runId: 'run_1' }))
      .rejects.toMatchObject({ code: 'persistence_failed' });
  });

  it('createConversationWithFirstRun run does NOT include waitingOn', async () => {
    const service = makeService();
    const result = await service.createConversationWithFirstRun({
      principal,
      tenant: 'tenant_1',
      request: baseRequest
    });
    expect(result.run.waitingOn).toBeUndefined();
  });
});

function makeServiceWithFeedback(feedbackRepo: FeedbackRepository): DefaultControlPlaneService {
  return new DefaultControlPlaneService({
    orchestrator: makeFakeOrchestrator(),
    runs: makeFakeRunRepo(),
    runSteps: makeFakeRunStepRepo(),
    events: new InMemoryRunEventBus(),
    policy: permissivePolicyDecisionPoint,
    artifacts: makeFakeArtifactRepository(validArtifact),
    feedback: feedbackRepo,
    runWorkspaceMetadata: makeFakeRunWorkspaceMetadataRepository(validWorkspaceMetadata),
    workspaceFilesystem: makeFakeWorkspaceFilesystem(),
    feedbackLifecycle: {
      feedback: feedbackRepo,
      ids: () => 'id_1',
      clock: () => timestamp
    }
  });
}

describe('DefaultControlPlaneService.createRunFeedback', () => {
  it('creates artifact feedback and returns it', async () => {
    const feedbackRepo = makeFakeFeedbackRepository();
    const createdFeedback: Feedback = {
      id: 'fb_1',
      runId: 'run_1',
      owner,
      tenant: 'tenant_1',
      target: 'artifact' as const,
      status: 'open' as const,
      title: 'Scope unclear',
      body: 'Please clarify.',
      thread: [{ id: 'th_1', author: owner, body: 'Please clarify.', createdAt: timestamp }],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    vi.spyOn(feedbackRepo, 'create').mockResolvedValue(createdFeedback);
    const service = makeServiceWithFeedback(feedbackRepo);
    const result = await service.createRunFeedback({
      principal,
      tenant: 'tenant_1',
      runId: 'run_1',
      request: { target: 'artifact', title: 'Scope unclear', body: 'Please clarify.' }
    });
    expect(result.status).toBe('open');
    expect(result.target).toBe('artifact');
    expect(result.id).toBe('fb_1');
  });

  it('rejects model principals', async () => {
    const modelPrincipal = { kind: 'model' as const, id: 'model_1', tenantId: 'tenant_1' };
    const service = makeService();
    await expect(service.createRunFeedback({
      principal: modelPrincipal,
      tenant: 'tenant_1',
      runId: 'run_1',
      request: { target: 'artifact', title: 'Title', body: 'Body' }
    })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('returns not_found for missing run', async () => {
    const runs = makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) });
    const service = makeService({ runs });
    await expect(service.createRunFeedback({
      principal,
      tenant: 'tenant_1',
      runId: 'run_missing',
      request: { target: 'artifact', title: 'Title', body: 'Body' }
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns not_found for cross-tenant run', async () => {
    const service = makeService();
    await expect(service.createRunFeedback({
      principal,
      tenant: 'tenant_other',
      runId: 'run_1',
      request: { target: 'artifact', title: 'Title', body: 'Body' }
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps repository failures to persistence_failed', async () => {
    const feedbackRepo = makeFakeFeedbackRepository();
    vi.spyOn(feedbackRepo, 'create').mockRejectedValue(new Error('db failure'));
    const service = makeServiceWithFeedback(feedbackRepo);
    await expect(service.createRunFeedback({
      principal,
      tenant: 'tenant_1',
      runId: 'run_1',
      request: { target: 'artifact', title: 'Title', body: 'Body' }
    })).rejects.toMatchObject({ code: 'persistence_failed' });
  });
});

describe('DefaultControlPlaneService.listRunFeedback', () => {
  it('lists feedback for the tenant-verified run', async () => {
    const feedbackItem: Feedback = {
      id: 'fb_1', runId: 'run_1', owner, tenant: 'tenant_1',
      target: 'artifact' as const, status: 'open' as const,
      title: 'Scope unclear', body: 'Please clarify.',
      thread: [{ id: 'th_1', author: owner, body: 'Please clarify.', createdAt: timestamp }],
      createdAt: timestamp, updatedAt: timestamp
    };
    const feedbackRepo = makeFakeFeedbackRepository();
    vi.spyOn(feedbackRepo, 'listByRun').mockResolvedValue([feedbackItem]);
    const service = makeServiceWithFeedback(feedbackRepo);
    const result = await service.listRunFeedback({ principal, tenant: 'tenant_1', runId: 'run_1' });
    expect(result.feedback).toHaveLength(1);
    expect(result.feedback[0]?.id).toBe('fb_1');
  });

  it('returns not_found for missing run', async () => {
    const service = makeService({ runs: makeFakeRunRepo({ findById: vi.fn().mockResolvedValue(null) }) });
    await expect(service.listRunFeedback({ principal, tenant: 'tenant_1', runId: 'run_missing' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns not_found for cross-tenant run', async () => {
    const service = makeService();
    await expect(service.listRunFeedback({ principal, tenant: 'tenant_other', runId: 'run_1' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps repository failures to persistence_failed', async () => {
    const feedbackRepo = makeFakeFeedbackRepository();
    vi.spyOn(feedbackRepo, 'listByRun').mockRejectedValue(new Error('db failure'));
    const service = makeServiceWithFeedback(feedbackRepo);
    await expect(service.listRunFeedback({ principal, tenant: 'tenant_1', runId: 'run_1' }))
      .rejects.toMatchObject({ code: 'persistence_failed' });
  });
});
