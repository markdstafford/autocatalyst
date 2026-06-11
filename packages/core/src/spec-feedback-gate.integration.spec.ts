/**
 * Integration tests: feedback gate block/unblock/approve cycle
 *
 * Verifies that:
 *   - Artifact feedback with status 'open' or 'addressed' blocks advancing from spec.human_review
 *   - wont_fix → reopen leaves feedback blocking
 *   - Addressing feedback and then advancing resolves it and finalizes the spec approval
 *   - Dispatch at spec.human_review is rejected (human-waiting step)
 */

import { describe, expect, it } from 'vitest';

import type {
  Artifact,
  ArtifactCachedStatus,
  ArtifactKind,
  CreateArtifactInput,
  CreateFeedbackInput,
  Feedback,
  FeedbackStatus,
  NonModelPrincipal,
  Run,
  RunStep
} from '@autocatalyst/api-contract';

import type {
  ArtifactRepository,
  FeedbackRepository,
  FeedbackStatusTransitionPersistenceInput,
  LifecycleRunStepInput,
  RecordRunLifecycleStartInput,
  RecordRunLifecycleStartResult,
  RecordRunStepTransitionInput,
  RecordRunStepTransitionResult,
  RunRepository
} from './domain-repositories.js';
import { FeedbackConcurrentModificationError } from './domain-repositories.js';
import type { WorkspaceFileSystemPort, WorkspaceGitPort } from './spec-authoring-service.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import {
  addressFeedback,
  createArtifactFeedback,
  markFeedbackWontFix,
  reopenFeedback
} from './feedback-lifecycle.js';
import type { RunUnitOfWork } from './orchestrator.js';
import { DefaultOrchestrator } from './orchestrator.js';
import { resolveApproverAddressedFeedback } from './feedback-lifecycle.js';
import { assertSpecReviewGateCanAdvance } from './spec-review-gate.js';
import { finalizeSpecApproval } from './spec-approval-finalizer.js';
import { RunDispatchQueue } from './run-dispatch-queue.js';
import { InMemoryRunEventBus } from './run-events.js';
import { deriveRunTerminal } from './run-step-catalog.js';
import type { JsonValue, CreateRunInput } from '@autocatalyst/api-contract';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const timestamp = '2026-06-11T00:00:00.000Z';

let runIdCounter = 0;
let stepIdCounter = 0;
let artifactIdCounter = 0;
let feedbackIdCounter = 0;
let idCounter = 0;

function nextRunId(): string { return `run_${++runIdCounter}`; }
function nextStepId(): string { return `step_${++stepIdCounter}`; }
function nextArtifactId(): string { return `art_${++artifactIdCounter}`; }
function nextFeedbackId(): string { return `fb_${++feedbackIdCounter}`; }
function nextId(): string { return `id_${++idCounter}`; }

function principal(name: string): NonModelPrincipal {
  return { id: name, kind: 'human' as const, tenantId: 'tenant_1' };
}

// ---------------------------------------------------------------------------
// In-memory RunRepository (same pattern as spec-authoring integration test)
// ---------------------------------------------------------------------------

function makeRunFrom(input: CreateRunInput, id: string): Run {
  return {
    id,
    topicId: input.topicId,
    owner: input.owner,
    tenant: input.tenant,
    workKind: input.workKind,
    currentStep: input.currentStep,
    terminal: input.terminal,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.trackedIssue !== undefined ? { trackedIssue: input.trackedIssue } : {}),
    ...(input.testingGuideResult !== undefined ? { testingGuideResult: input.testingGuideResult } : {})
  };
}

function makeRunStepFrom(
  input: LifecycleRunStepInput,
  runId: string,
  id: string,
  occurrence: { index: number; attempt: number },
  checkpointResult?: JsonValue
): RunStep {
  return {
    id,
    runId,
    phase: input.phase,
    step: input.step,
    role: input.role,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    occurrence,
    checkpointResult: checkpointResult ?? null
  };
}

class InMemoryRunRepository implements RunRepository {
  readonly #runs = new Map<string, Run>();
  readonly #steps: RunStep[] = [];

  async create(input: CreateRunInput): Promise<Run> {
    const run = makeRunFrom(input, nextRunId());
    this.#runs.set(run.id, run);
    return run;
  }

  async findById(id: string): Promise<Run | null> {
    return this.#runs.get(id) ?? null;
  }

  async findActiveByTopic(topicId: string): Promise<Run | null> {
    for (const run of this.#runs.values()) {
      if (run.topicId === topicId && !run.terminal) return run;
    }
    return null;
  }

  async listByTopic(topicId: string): Promise<readonly Run[]> {
    return [...this.#runs.values()].filter((r) => r.topicId === topicId);
  }

  async listByTenant(tenant: string): Promise<readonly Run[]> {
    return [...this.#runs.values()].filter((r) => r.tenant === tenant);
  }

  async recordRunLifecycleStart(input: RecordRunLifecycleStartInput): Promise<RecordRunLifecycleStartResult> {
    const run = makeRunFrom(
      {
        ...input.run,
        terminal: deriveRunTerminal(input.run.currentStep as Parameters<typeof deriveRunTerminal>[0])
      },
      nextRunId()
    );
    this.#runs.set(run.id, run);
    const stepIndex = this.#steps.filter((s) => s.runId === run.id).length;
    const runStep = makeRunStepFrom(input.runStep, run.id, nextStepId(), {
      index: stepIndex,
      attempt: 1
    });
    this.#steps.push(runStep);
    return { run, runStep };
  }

  async recordRunStepTransition(input: RecordRunStepTransitionInput): Promise<RecordRunStepTransitionResult> {
    const existing = this.#runs.get(input.runId);
    if (existing === undefined) throw new Error(`Run '${input.runId}' not found.`);

    const updated: Run = {
      ...existing,
      currentStep: input.currentStep,
      terminal: input.terminal,
      updatedAt: timestamp
    };
    this.#runs.set(updated.id, updated);

    const runSteps = this.#steps.filter((s) => s.runId === input.runId);
    const stepIndex = runSteps.length;
    const priorAttempts = runSteps.filter((s) => s.step === input.currentStep).length;

    const runStep = makeRunStepFrom(
      input.runStep,
      input.runId,
      nextStepId(),
      { index: stepIndex, attempt: priorAttempts + 1 },
      input.checkpointResult
    );
    this.#steps.push(runStep);
    return { run: updated, runStep };
  }

  async findLatestOpenRunStep(input: { runId: string; step: string }): Promise<RunStep | null> {
    const matches = this.#steps
      .filter((s) => s.runId === input.runId && s.step === input.step)
      .reverse();
    return matches[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// In-memory ArtifactRepository
// ---------------------------------------------------------------------------

class InMemoryArtifactRepository implements ArtifactRepository {
  readonly #artifacts = new Map<string, Artifact>();

  async create(input: CreateArtifactInput): Promise<Artifact> {
    const artifact: Artifact = {
      id: nextArtifactId(),
      runId: input.runId,
      owner: input.owner,
      tenant: input.tenant,
      kind: input.kind,
      canonicalRecord: input.canonicalRecord,
      location: input.location,
      cachedStatus: input.cachedStatus,
      publicationRefs: [...(input.publicationRefs ?? [])],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.linkedIssue !== undefined ? { linkedIssue: input.linkedIssue } : {})
    };
    this.#artifacts.set(artifact.id, artifact);
    return artifact;
  }

  async findById(id: string): Promise<Artifact | null> {
    return this.#artifacts.get(id) ?? null;
  }

  async listByRun(runId: string): Promise<readonly Artifact[]> {
    return [...this.#artifacts.values()].filter((a) => a.runId === runId);
  }

  async findByRunAndKind(input: { readonly runId: string; readonly kind: ArtifactKind }): Promise<Artifact | null> {
    for (const artifact of this.#artifacts.values()) {
      if (artifact.runId === input.runId && artifact.kind === input.kind) return artifact;
    }
    return null;
  }

  async updateCachedStatus(input: {
    readonly artifactId: string;
    readonly cachedStatus: ArtifactCachedStatus;
    readonly updatedAt: string;
  }): Promise<Artifact> {
    const existing = this.#artifacts.get(input.artifactId);
    if (existing === undefined) throw new Error(`Artifact '${input.artifactId}' not found.`);
    const updated: Artifact = { ...existing, cachedStatus: input.cachedStatus, updatedAt: input.updatedAt };
    this.#artifacts.set(updated.id, updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// In-memory FeedbackRepository
// ---------------------------------------------------------------------------

class InMemoryFeedbackRepository implements FeedbackRepository {
  readonly #items = new Map<string, Feedback>();

  async create(input: CreateFeedbackInput): Promise<Feedback> {
    const feedback: Feedback = {
      id: nextFeedbackId(),
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
    this.#items.set(feedback.id, feedback);
    return feedback;
  }

  async findById(id: string): Promise<Feedback | null> {
    return this.#items.get(id) ?? null;
  }

  async listByRun(runId: string): Promise<readonly Feedback[]> {
    return [...this.#items.values()].filter((f) => f.runId === runId);
  }

  async updateStatusAndAppendThread(input: FeedbackStatusTransitionPersistenceInput): Promise<Feedback> {
    const existing = this.#items.get(input.feedbackId);
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
    this.#items.set(updated.id, updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Fake filesystem and git ports
// ---------------------------------------------------------------------------

interface CommitRecord {
  readonly workspaceRepoRoot: string;
  readonly relativePaths: readonly string[];
  readonly message: string;
}

function makeFakeFilesystem(): { port: WorkspaceFileSystemPort; files: Map<string, string> } {
  const files = new Map<string, string>();
  const port: WorkspaceFileSystemPort = {
    async writeFile(input) {
      files.set(`${input.workspaceRepoRoot}/${input.relativePath}`, input.contents);
    },
    async readFile(input) {
      const key = `${input.workspaceRepoRoot}/${input.relativePath}`;
      const contents = files.get(key);
      if (contents === undefined) throw new Error(`File not found: ${key}`);
      return contents;
    }
  };
  return { port, files };
}

function makeFakeGit(): { port: WorkspaceGitPort; commits: CommitRecord[] } {
  const commits: CommitRecord[] = [];
  const port: WorkspaceGitPort = {
    async commitFiles(input) {
      commits.push({ workspaceRepoRoot: input.workspaceRepoRoot, relativePaths: [...input.relativePaths], message: input.message });
      return { commitSha: `sha_${commits.length}` };
    }
  };
  return { port, commits };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeFiles {
  exists(path: string): boolean;
  get(path: string): string | undefined;
}

interface TestHarness {
  readonly orchestrator: DefaultOrchestrator;
  readonly run: Run;
  readonly repos: {
    readonly artifacts: InMemoryArtifactRepository;
    readonly feedback: InMemoryFeedbackRepository;
  };
  readonly feedbackDeps: FeedbackLifecycleDependencies;
  readonly files: FakeFiles;
  readonly workspaceRepoRoot: string;
}

const workspaceRepoRoot = '/tmp/test-repo';

function makeSpecAuthorResult() {
  return {
    kind: 'feature_spec',
    slug: 'artifact-feedback-gate',
    relativePath: 'context-human/specs/feature-artifact-feedback-gate.md',
    frontmatter: {
      created: '2026-06-11',
      last_updated: '2026-06-11',
      status: 'draft',
      issue: 39,
      specced_by: 'autocatalyst'
    },
    body: `# Feature: Artifact Feedback Gate\n\nThis is the spec body.\n`
  };
}

async function makeAuthoredSpecAtReviewHarness(): Promise<TestHarness> {
  const runRepository = new InMemoryRunRepository();
  const artifactRepository = new InMemoryArtifactRepository();
  const feedbackRepository = new InMemoryFeedbackRepository();
  const { port: filesystem, files } = makeFakeFilesystem();
  const { port: git } = makeFakeGit();

  const feedbackDeps: FeedbackLifecycleDependencies = {
    feedback: feedbackRepository,
    ids: nextId,
    clock: () => timestamp
  };

  const specAuthorResult = makeSpecAuthorResult();

  const unitOfWork: RunUnitOfWork = {
    async run() {
      return { directive: 'advance', result: specAuthorResult as unknown as Record<string, unknown> };
    }
  };

  const orchestrator = new DefaultOrchestrator({
    runs: runRepository,
    conversationIngress: {
      createConversationTopicMessageAndRun: async () => {
        throw new Error('not used in integration tests');
      }
    },
    events: new InMemoryRunEventBus(),
    dispatchQueue: new RunDispatchQueue({ maxConcurrent: 4 }),
    unitOfWork,
    clock: () => timestamp,
    specAuthoringDependencies: {
      artifacts: artifactRepository,
      filesystem,
      git,
      clock: () => timestamp
    },
    feedbackLifecycleDependencies: feedbackDeps,
    resolveApproverAddressedFeedback,
    assertSpecReviewGateCanAdvance,
    finalizeSpecApproval,
    specApprovalFinalizerDependencies: {
      artifacts: artifactRepository,
      filesystem,
      git,
      clock: () => timestamp
    },
    resolveWorkspaceContext: async () => ({
      workspaceRepoRoot,
      workspaceHandle: 'ws_1'
    })
  });

  // Create run at intake
  const owner = principal('phoebe');
  const { run: createdRun } = await orchestrator.createRun({
    topicId: 'topic_gate_1',
    owner,
    tenant: 'tenant_1',
    workKind: 'feature'
  });

  // Advance intake → spec.author
  const { run: specAuthorRun } = await orchestrator.applyDirective({
    runId: createdRun.id,
    directive: 'advance',
    tenant: 'tenant_1'
  });

  // Dispatch at spec.author → completes authoring → advances to spec.human_review
  const { run } = await orchestrator.dispatch({
    runId: specAuthorRun.id,
    tenant: 'tenant_1'
  });

  if (run.currentStep !== 'spec.human_review') {
    throw new Error(`Expected run at spec.human_review but got '${run.currentStep}'.`);
  }

  const fakeFiles: FakeFiles = {
    exists(path) { return files.has(path); },
    get(path) { return files.get(path); }
  };

  return {
    orchestrator,
    run,
    repos: {
      artifacts: artifactRepository,
      feedback: feedbackRepository
    },
    feedbackDeps,
    files: fakeFiles,
    workspaceRepoRoot
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('spec feedback gate integration', () => {
  it('blocks, unblocks, approves, and updates the committed spec status', async () => {
    const harness = await makeAuthoredSpecAtReviewHarness();
    const phoebe = principal('phoebe');

    // 1. Create artifact feedback
    const fb = await createArtifactFeedback({
      runId: harness.run.id,
      owner: phoebe,
      tenant: harness.run.tenant,
      principal: phoebe,
      title: 'Make acceptance criterion testable',
      body: 'Please make the acceptance criterion observable.'
    }, harness.feedbackDeps);

    // 2. Try to advance → should fail (feedback is blocking)
    await expect(harness.orchestrator.applyDirective({
      runId: harness.run.id,
      tenant: harness.run.tenant,
      directive: 'advance',
      principal: phoebe
    })).rejects.toMatchObject({ code: 'invalid_transition' });

    // 3. Mark won't fix → reopen → try to advance again → still blocked
    const enzo = principal('enzo');
    await markFeedbackWontFix({ feedbackId: fb.id, actor: enzo, body: 'Deferred until revise support exists.' }, harness.feedbackDeps);
    await reopenFeedback({ feedbackId: fb.id, actor: phoebe, body: 'Deferral is not acceptable for this gate.' }, harness.feedbackDeps);
    await expect(harness.orchestrator.applyDirective({ runId: harness.run.id, tenant: harness.run.tenant, directive: 'advance', principal: phoebe }))
      .rejects.toMatchObject({ code: 'invalid_transition' });

    // 4. Address the feedback → advance should succeed now
    await addressFeedback({ feedbackId: fb.id, actor: enzo, body: 'Disposition recorded.' }, harness.feedbackDeps);
    const approved = await harness.orchestrator.applyDirective({
      runId: harness.run.id,
      tenant: harness.run.tenant,
      directive: 'advance',
      principal: phoebe  // phoebe originated the feedback, so her advance resolves it
    });
    expect(approved.run.currentStep).toBe('implementation.plan');

    // The spec file should now have status: approved
    expect(harness.files.get(`${harness.workspaceRepoRoot}/context-human/specs/feature-artifact-feedback-gate.md`)).toContain('status: approved');

    // Artifact should have cachedStatus: 'approved'
    const artifacts = await harness.repos.artifacts.listByRun(harness.run.id);
    expect(artifacts[0]?.cachedStatus).toBe('approved');
  });

  it('does not allow runner dispatch at spec.human_review', async () => {
    const harness = await makeAuthoredSpecAtReviewHarness();
    await expect(harness.orchestrator.dispatch({ runId: harness.run.id, tenant: harness.run.tenant }))
      .rejects.toMatchObject({ code: 'invalid_transition' });
  });
});
