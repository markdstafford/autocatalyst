/**
 * Service-level tests for spec feedback anchors, reconciliation, and the resolve/reopen PATCH
 * operation (ADR-033 / ADR-018). Uses a self-contained in-memory harness that shares ONE feedback
 * repository between the service and its feedback-lifecycle dependencies.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  Artifact,
  CreateFeedbackInput,
  Feedback,
  FeedbackAnchor,
  FeedbackStatus,
  NonModelPrincipal,
  Principal,
  Run,
  RunStep
} from '@autocatalyst/api-contract';

import { DefaultControlPlaneService } from './control-plane-service.js';
import type {
  ArtifactRepository,
  FeedbackAnchorOffsetsPersistenceInput,
  FeedbackRepository,
  FeedbackStatusTransitionPersistenceInput,
  FeedbackThreadAppendPersistenceInput,
  RunRepository,
  RunWorkspaceMetadata,
  RunWorkspaceMetadataRepository
} from './domain-repositories.js';
import { FeedbackConcurrentModificationError } from './domain-repositories.js';
import type { Orchestrator } from './orchestrator.js';
import { permissivePolicyDecisionPoint, type PolicyDecisionPoint } from './policy.js';
import { InMemoryRunEventBus } from './run-events.js';
import type { WorkspaceFileSystemPort } from './spec-authoring-service.js';

const timestamp = '2026-06-11T00:00:00.000Z';
// A committed spec with valid frontmatter (the shared spec reader parses frontmatter). ASCII-only,
// so code-point offsets equal string indices here; the emoji/code-point guard lives in the
// validator and reconciler unit tests.
const markdown = '---\ncreated: 2026-06-11\nlast_updated: 2026-06-11\nstatus: draft\nissue: 41\nspecced_by: autocatalyst\n---\n# Scope\n\nThe scope section is ambiguous.';
const scopeFrom = markdown.indexOf('Scope');
const workspaceRepoRoot = '/tmp/workspace';

function human(id: string): NonModelPrincipal {
  return { id, kind: 'human', tenantId: 'tenant_1' };
}

const modelPrincipal: Principal = { id: 'model_1', kind: 'model', tenantId: 'tenant_1', provider: 'anthropic', model: 'x' } as unknown as Principal;

function makeRun(overrides?: Partial<Run>): Run {
  return {
    id: 'run_1',
    topicId: 'topic_1',
    owner: human('alice'),
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'spec.human_review',
    terminal: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

const specArtifact: Artifact = {
  id: 'art_1',
  runId: 'run_1',
  owner: human('alice'),
  tenant: 'tenant_1',
  kind: 'feature_spec',
  canonicalRecord: 'file',
  location: 'context-human/specs/feature-spec.md',
  cachedStatus: 'draft',
  publicationRefs: [],
  createdAt: timestamp,
  updatedAt: timestamp
};

const workspaceMetadata: RunWorkspaceMetadata = {
  runId: 'run_1',
  workspaceHandle: 'handle_1',
  workspaceRepoRoot,
  createdAt: timestamp
};

class InMemoryFeedbackRepository implements FeedbackRepository {
  readonly items = new Map<string, Feedback>();
  #counter = 0;

  seed(item: Feedback): void {
    this.items.set(item.id, item);
  }

  async create(input: CreateFeedbackInput): Promise<Feedback> {
    const id = `fb_${++this.#counter}`;
    const item: Feedback = {
      id,
      runId: input.runId,
      owner: input.owner,
      tenant: input.tenant,
      target: input.target,
      status: input.status,
      title: input.title,
      body: input.body,
      thread: [...input.thread],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.anchor !== undefined ? { anchor: input.anchor } : {})
    };
    this.items.set(id, item);
    return item;
  }

  async findById(id: string): Promise<Feedback | null> {
    return this.items.get(id) ?? null;
  }

  async listByRun(runId: string): Promise<readonly Feedback[]> {
    return [...this.items.values()].filter((f) => f.runId === runId);
  }

  async updateStatusAndAppendThread(input: FeedbackStatusTransitionPersistenceInput): Promise<Feedback> {
    const existing = this.items.get(input.feedbackId);
    if (existing === undefined) throw new Error(`Feedback '${input.feedbackId}' not found.`);
    if (existing.status !== input.expectedStatus) {
      throw new FeedbackConcurrentModificationError(input.feedbackId, input.expectedStatus, existing.status as FeedbackStatus);
    }
    const updated: Feedback = {
      ...existing,
      status: input.nextStatus,
      thread: [...existing.thread, input.threadEntry],
      updatedAt: input.updatedAt
    };
    this.items.set(updated.id, updated);
    return updated;
  }

  async appendThreadEntry(input: FeedbackThreadAppendPersistenceInput): Promise<Feedback> {
    const existing = this.items.get(input.feedbackId);
    if (existing === undefined) throw new Error(`Feedback '${input.feedbackId}' not found.`);
    const updated: Feedback = { ...existing, thread: [...existing.thread, input.threadEntry], updatedAt: input.updatedAt };
    this.items.set(updated.id, updated);
    return updated;
  }

  updateAnchorOffsets = vi.fn(async (input: FeedbackAnchorOffsetsPersistenceInput): Promise<Feedback> => {
    const existing = this.items.get(input.feedbackId);
    if (existing === undefined) throw new Error(`Feedback '${input.feedbackId}' not found.`);
    if (existing.anchor === undefined || existing.anchor.kind !== 'artifact_range') {
      throw new Error('No artifact_range anchor to repair.');
    }
    const updated: Feedback = { ...existing, anchor: { ...existing.anchor, from: input.from, to: input.to } };
    this.items.set(updated.id, updated);
    return updated;
  });
}

interface HarnessOptions {
  readonly run?: Run;
  readonly artifact?: Artifact | null;
  readonly readFile?: () => Promise<string>;
  readonly policy?: PolicyDecisionPoint;
  readonly applyDirective?: Orchestrator['applyDirective'];
}

function makeHarness(options: HarnessOptions = {}) {
  const run = options.run ?? makeRun();
  const feedback = new InMemoryFeedbackRepository();

  const runs: RunRepository = {
    create: vi.fn(),
    findById: vi.fn(async (id: string) => (id === run.id ? run : null)),
    findActiveByTopic: vi.fn(),
    listByTopic: vi.fn(),
    listByTenant: vi.fn(),
    recordRunLifecycleStart: vi.fn(),
    recordRunStepTransition: vi.fn()
  } as unknown as RunRepository;

  const artifacts: ArtifactRepository = {
    create: vi.fn(),
    findById: vi.fn(),
    listByRun: vi.fn(),
    findByRunAndKind: vi.fn(async () => (options.artifact === undefined ? specArtifact : options.artifact)),
    updateCachedStatus: vi.fn()
  };

  const runWorkspaceMetadata: RunWorkspaceMetadataRepository = {
    upsert: vi.fn(),
    findByRunId: vi.fn(async () => workspaceMetadata)
  };

  const readFile = options.readFile ?? (async () => markdown);
  const workspaceFilesystem: WorkspaceFileSystemPort = {
    writeFile: vi.fn(),
    readFile: vi.fn(readFile)
  };

  const applyDirective = options.applyDirective ?? vi.fn(async () => ({
    run: makeRun({ currentStep: 'spec.author' }),
    runStep: { id: 'step_1', runId: run.id, phase: 'spec', step: 'spec.author', role: 'none', startedAt: timestamp, endedAt: null, durationMs: null, occurrence: { index: 1, attempt: 1 }, checkpointResult: null } as RunStep
  }));

  const orchestrator = {
    createRun: vi.fn(),
    createConversationWithFirstRun: vi.fn(),
    applyDirective,
    dispatch: vi.fn(),
    tick: vi.fn(),
    replyToRun: vi.fn(),
    detectMerges: vi.fn(),
    admitForDispatch: vi.fn()
  } as unknown as Orchestrator;

  const service = new DefaultControlPlaneService({
    orchestrator,
    runs,
    runSteps: { create: vi.fn(), findById: vi.fn(), listByRun: vi.fn(async () => []) } as never,
    events: new InMemoryRunEventBus(),
    policy: options.policy ?? permissivePolicyDecisionPoint,
    artifacts,
    feedback,
    runWorkspaceMetadata,
    workspaceFilesystem,
    feedbackLifecycle: { feedback, ids: (() => { let n = 0; return () => `tid_${++n}`; })(), clock: () => timestamp },
    projects: { create: vi.fn(), findById: vi.fn(), list: vi.fn(), update: vi.fn() } as never,
    issueReferenceIntakeResolver: { resolve: vi.fn() } as never,
    pullRequests: { create: vi.fn(), findById: vi.fn(), findByRun: vi.fn(), updateState: vi.fn(), listOpen: vi.fn() } as never,
    sessions: { create: vi.fn(), findById: vi.fn(), listByRun: vi.fn() } as never
  });

  return { service, feedback, runs, artifacts, workspaceFilesystem, applyDirective, run };
}

function anchor(from: number, to: number, quotedText?: string, artifactId = 'art_1'): FeedbackAnchor {
  return { kind: 'artifact_range', artifactId, from, to, ...(quotedText !== undefined ? { quotedText } : {}) } as FeedbackAnchor;
}

function seededItem(repo: InMemoryFeedbackRepository, partial: Partial<Feedback> & { id: string; status: FeedbackStatus; originator: string }): Feedback {
  const originator = partial.originator;
  const item: Feedback = {
    id: partial.id,
    runId: 'run_1',
    owner: human(originator),
    tenant: 'tenant_1',
    target: 'artifact',
    status: partial.status,
    title: 'Comment',
    body: 'Body',
    thread: partial.thread ?? [{ id: 't1', author: human(originator), body: 'Body', createdAt: timestamp }],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(partial.anchor !== undefined ? { anchor: partial.anchor } : {})
  } as Feedback;
  repo.seed(item);
  return item;
}

// ---------------------------------------------------------------------------
// createRunFeedback anchor validation
// ---------------------------------------------------------------------------

describe('createRunFeedback spec anchor validation', () => {
  it('accepts unanchored artifact feedback without reading the spec', async () => {
    const { service, workspaceFilesystem } = makeHarness();
    const fb = await service.createRunFeedback({
      principal: human('alice'),
      tenant: 'tenant_1',
      runId: 'run_1',
      request: { target: 'artifact', title: 'T', body: 'B' }
    });
    expect(fb.status).toBe('open');
    expect(workspaceFilesystem.readFile).not.toHaveBeenCalled();
  });

  it('accepts a valid spec anchor that reproduces the quote', async () => {
    const { service } = makeHarness();
    const fb = await service.createRunFeedback({
      principal: human('alice'),
      tenant: 'tenant_1',
      runId: 'run_1',
      request: { target: 'artifact', title: 'T', body: 'B', anchor: anchor(scopeFrom, scopeFrom + 5, 'Scope') }
    });
    expect(fb.anchor).toMatchObject({ from: scopeFrom, to: scopeFrom + 5, quotedText: 'Scope' });
  });

  it('rejects an invalid spec anchor with invalid_feedback_anchor and a typed reason', async () => {
    const { service } = makeHarness();
    await expect(service.createRunFeedback({
      principal: human('alice'),
      tenant: 'tenant_1',
      runId: 'run_1',
      request: { target: 'artifact', title: 'T', body: 'B', anchor: anchor(0, 1, 'Scope') }
    })).rejects.toMatchObject({ code: 'invalid_feedback_anchor', details: { reason: 'text_mismatch' } });
  });

  it('returns not_found (→404) for anchored spec feedback when the run has no spec artifact', async () => {
    const { service } = makeHarness({ artifact: null });
    await expect(service.createRunFeedback({
      principal: human('alice'),
      tenant: 'tenant_1',
      runId: 'run_1',
      request: { target: 'artifact', title: 'T', body: 'B', anchor: anchor(2, 7, 'Scope') }
    })).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// listRunFeedback reconciliation
// ---------------------------------------------------------------------------

describe('listRunFeedback reconciliation', () => {
  it('repairs moved anchors, persists offsets, and returns the repaired anchor', async () => {
    const { service, feedback } = makeHarness();
    // Stored offsets no longer slice "ambiguous"; it lives at a later code-point index.
    seededItem(feedback, { id: 'fb_1', status: 'open', originator: 'alice', anchor: anchor(0, 9, 'ambiguous') });
    const result = await service.listRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1' });
    const idx = Array.from(markdown).join('').indexOf('ambiguous');
    expect(result.feedback[0]?.anchor).toMatchObject({ from: idx, to: idx + 'ambiguous'.length });
    expect(feedback.updateAnchorOffsets).toHaveBeenCalledWith({ feedbackId: 'fb_1', from: idx, to: idx + 'ambiguous'.length });
  });

  it('marks a missing quote stale without persisting', async () => {
    const { service, feedback } = makeHarness();
    seededItem(feedback, { id: 'fb_1', status: 'open', originator: 'alice', anchor: anchor(0, 7, 'Missing') });
    const result = await service.listRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1' });
    expect(result.feedback[0]?.anchor).toMatchObject({ stale: true });
    expect(feedback.updateAnchorOffsets).not.toHaveBeenCalled();
  });

  it('degrades to unreconciled stored anchors when the spec cannot be read', async () => {
    const { service, feedback } = makeHarness({ readFile: async () => { throw new Error('missing file'); } });
    seededItem(feedback, { id: 'fb_1', status: 'open', originator: 'alice', anchor: anchor(0, 9, 'ambiguous') });
    const result = await service.listRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1' });
    expect(result.feedback[0]?.anchor).toEqual(anchor(0, 9, 'ambiguous'));
    expect(result.feedback[0]?.anchor && 'stale' in result.feedback[0].anchor).toBe(false);
    expect(feedback.updateAnchorOffsets).not.toHaveBeenCalled();
  });

  it('does not read the spec when only unanchored feedback exists', async () => {
    const { service, workspaceFilesystem, feedback } = makeHarness();
    seededItem(feedback, { id: 'fb_1', status: 'open', originator: 'alice' });
    await service.listRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1' });
    expect(workspaceFilesystem.readFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateRunFeedback resolve / reopen
// ---------------------------------------------------------------------------

describe('updateRunFeedback resolve', () => {
  it('resolves an addressed item for the originator', async () => {
    const { service, feedback } = makeHarness();
    seededItem(feedback, { id: 'fb_1', status: 'addressed', originator: 'alice' });
    const updated = await service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'resolved' } });
    expect(updated.status).toBe('resolved');
  });

  it('rejects a non-originator resolving with forbidden (403)', async () => {
    const { service, feedback } = makeHarness();
    seededItem(feedback, { id: 'fb_1', status: 'addressed', originator: 'alice' });
    await expect(service.updateRunFeedback({ principal: human('bob'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'resolved' } }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(feedback.items.get('fb_1')?.status).toBe('addressed');
  });

  it('rejects resolving from a non-addressed status with conflict (409)', async () => {
    const { service, feedback } = makeHarness();
    seededItem(feedback, { id: 'fb_1', status: 'open', originator: 'alice' });
    await expect(service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'resolved' } }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects a model principal with unauthorized (→403)', async () => {
    const { service, feedback } = makeHarness();
    seededItem(feedback, { id: 'fb_1', status: 'addressed', originator: 'alice' });
    await expect(service.updateRunFeedback({ principal: modelPrincipal, tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'resolved' } }))
      .rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('returns not_found for a missing item and for an item from another run', async () => {
    const { service, feedback } = makeHarness();
    await expect(service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'nope', request: { status: 'resolved' } }))
      .rejects.toMatchObject({ code: 'not_found' });
    const other = seededItem(feedback, { id: 'fb_other', status: 'addressed', originator: 'alice' });
    feedback.items.set('fb_other', { ...other, runId: 'run_2' });
    await expect(service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_other', request: { status: 'resolved' } }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('calls the policy point before loading or mutating feedback', async () => {
    const authorize = vi.fn(async () => ({ allowed: false }));
    const { service, feedback } = makeHarness({ policy: { authorize } });
    const findById = vi.spyOn(feedback, 'findById');
    seededItem(feedback, { id: 'fb_1', status: 'addressed', originator: 'alice' });
    await expect(service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'resolved' } }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'run_feedback.update', resource: expect.objectContaining({ kind: 'run_feedback_item' }) }));
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('updateRunFeedback reopen', () => {
  it('reopens a wont_fix item at the matching gate and applies the revise directive', async () => {
    const applyDirective = vi.fn(async () => ({
      run: makeRun({ currentStep: 'spec.author' }),
      runStep: { id: 's', runId: 'run_1', phase: 'spec', step: 'spec.author', role: 'none', startedAt: timestamp, endedAt: null, durationMs: null, occurrence: { index: 1, attempt: 1 }, checkpointResult: null } as RunStep
    }));
    const { service, feedback } = makeHarness({ applyDirective });
    seededItem(feedback, { id: 'fb_1', status: 'wont_fix', originator: 'alice' });
    const updated = await service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'open', body: 'Not acceptable.' } });
    expect(updated.status).toBe('open');
    expect(applyDirective).toHaveBeenCalledWith(expect.objectContaining({ directive: 'revise', origin: 'human' }));
  });

  it('requires a body to reopen (→400)', async () => {
    const { service, feedback } = makeHarness();
    seededItem(feedback, { id: 'fb_1', status: 'wont_fix', originator: 'alice' });
    await expect(service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'open' } }))
      .rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('returns conflict (409) and changes nothing when the run is not at the matching gate', async () => {
    const applyDirective = vi.fn();
    const { service, feedback } = makeHarness({ run: makeRun({ currentStep: 'implementation.build' }), applyDirective: applyDirective as never });
    seededItem(feedback, { id: 'fb_1', status: 'wont_fix', originator: 'alice' });
    await expect(service.updateRunFeedback({ principal: human('alice'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'open', body: 'Reopen.' } }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(applyDirective).not.toHaveBeenCalled();
    expect(feedback.items.get('fb_1')?.status).toBe('wont_fix');
  });

  it('rejects a non-originator reopening with forbidden (403) and changes nothing', async () => {
    const applyDirective = vi.fn();
    const { service, feedback } = makeHarness({ applyDirective: applyDirective as never });
    const seeded = seededItem(feedback, { id: 'fb_1', status: 'wont_fix', originator: 'alice' });
    await expect(service.updateRunFeedback({ principal: human('bob'), tenant: 'tenant_1', runId: 'run_1', feedbackId: 'fb_1', request: { status: 'open', body: 'Reopen.' } }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(applyDirective).not.toHaveBeenCalled();
    expect(feedback.items.get('fb_1')).toEqual(seeded);
  });
});
