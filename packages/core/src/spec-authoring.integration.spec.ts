/**
 * Integration tests: successful spec authoring workflows
 *
 * Verifies that dispatching a run at spec.author:
 *   - calls completeSpecAuthoring (writes file, commits, persists artifact)
 *   - advances the run to spec.human_review (non-terminal)
 *   - writes the spec file to the fake filesystem at the expected path
 *   - records a git commit containing the file
 *   - persists an Artifact with the right kind, canonicalRecord, location, and cachedStatus
 */

import { describe, expect, it } from 'vitest';

import type {
  Artifact,
  ArtifactCachedStatus,
  ArtifactKind,
  CreateArtifactInput,
  CreateRunInput,
  CreateRunStepInput,
  JsonValue,
  NonModelPrincipal,
  Run,
  RunStep
} from '@autocatalyst/api-contract';

import type {
  ArtifactRepository,
  LifecycleRunStepInput,
  RecordRunLifecycleStartInput,
  RecordRunLifecycleStartResult,
  RecordRunStepTransitionInput,
  RecordRunStepTransitionResult,
  RunRepository
} from './domain-repositories.js';
import type { WorkspaceFileSystemPort, WorkspaceGitPort } from './spec-authoring-service.js';
import type { RunUnitOfWork } from './orchestrator.js';
import { DefaultOrchestrator } from './orchestrator.js';
import { RunDispatchQueue } from './run-dispatch-queue.js';
import { InMemoryRunEventBus } from './run-events.js';
import { deriveRunTerminal } from './run-step-catalog.js';
import { nextWorkflowStep } from './run-transition.js';
import { getRunWorkflowForWorkKind } from './run-workflows.js';

// ---------------------------------------------------------------------------
// In-memory RunRepository
// ---------------------------------------------------------------------------

const owner: NonModelPrincipal = {
  id: 'user_1',
  kind: 'human',
  tenantId: 'tenant_1',
  displayName: 'Ada'
};

const timestamp = '2026-06-11T00:00:00.000Z';

let runIdCounter = 0;
let stepIdCounter = 0;

function nextRunId(): string {
  return `run_${++runIdCounter}`;
}

function nextStepId(): string {
  return `step_${++stepIdCounter}`;
}

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

    // Determine attempt count for this step
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

let artifactIdCounter = 0;

function nextArtifactId(): string {
  return `art_${++artifactIdCounter}`;
}

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
// Harness builder
// ---------------------------------------------------------------------------

interface TestHarness {
  readonly orchestrator: DefaultOrchestrator;
  readonly runRepository: InMemoryRunRepository;
  readonly artifactRepository: InMemoryArtifactRepository;
  readonly files: Map<string, string>;
  readonly commits: CommitRecord[];
  readonly workspaceRepoRoot: string;
}

function buildHarness(unitOfWork: RunUnitOfWork): TestHarness {
  const runRepository = new InMemoryRunRepository();
  const artifactRepository = new InMemoryArtifactRepository();
  const { port: filesystem, files } = makeFakeFilesystem();
  const { port: git, commits } = makeFakeGit();
  const workspaceRepoRoot = '/tmp/test-repo';

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
    resolveWorkspaceContext: async () => ({
      workspaceRepoRoot,
      workspaceHandle: 'ws_1'
    })
  });

  return { orchestrator, runRepository, artifactRepository, files, commits, workspaceRepoRoot };
}

// ---------------------------------------------------------------------------
// Spec author result builders
// ---------------------------------------------------------------------------

function makeSpecAuthorResult(workKind: 'feature' | 'enhancement') {
  const kindPrefix = workKind === 'feature' ? 'feature' : 'enhancement';
  const kind = workKind === 'feature' ? 'feature_spec' : 'enhancement_spec';
  const slug = 'artifact-feedback-gate';
  const relativePath = `context-human/specs/${kindPrefix}-${slug}.md`;

  return {
    kind,
    slug,
    relativePath,
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

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('spec authoring integration — successful workflows', () => {
  it.each([
    [
      'feature',
      'feature_spec',
      'context-human/specs/feature-artifact-feedback-gate.md'
    ] as const,
    [
      'enhancement',
      'enhancement_spec',
      'context-human/specs/enhancement-artifact-feedback-gate.md'
    ] as const
  ])(
    'authors %s specs and pauses at spec.human_review',
    async (workKind, kind, expectedRelativePath) => {
      const specAuthorResult = makeSpecAuthorResult(workKind);

      // Unit of work: returns the spec.author result when dispatched
      const unitOfWork: RunUnitOfWork = {
        async run() {
          return { directive: 'advance', result: specAuthorResult as unknown as Record<string, unknown> };
        }
      };

      const harness = buildHarness(unitOfWork);

      // Create a run at intake, then advance to spec.author manually so it's
      // at the right step before dispatch.
      const { run: createdRun } = await harness.orchestrator.createRun({
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_1',
        workKind
      });
      expect(createdRun.currentStep).toBe('intake');

      // Advance intake → spec.author
      const { run: specAuthorRun } = await harness.orchestrator.applyDirective({
        runId: createdRun.id,
        directive: 'advance',
        tenant: 'tenant_1'
      });
      expect(specAuthorRun.currentStep).toBe('spec.author');

      // Dispatch at spec.author — this should trigger completeSpecAuthoring and
      // then advance to spec.human_review
      const result = await harness.orchestrator.dispatch({
        runId: specAuthorRun.id,
        tenant: 'tenant_1'
      });

      // Run must be at spec.human_review, not terminal
      expect(result.run.currentStep).toBe('spec.human_review');
      expect(result.run.terminal).toBe(false);

      // File written to fake filesystem at the expected path
      const fileKey = `${harness.workspaceRepoRoot}/${expectedRelativePath}`;
      expect(harness.files.has(fileKey)).toBe(true);

      const writtenContents = harness.files.get(fileKey)!;
      // The file must contain a frontmatter block with status: draft
      expect(writtenContents).toContain('status: draft');
      expect(writtenContents).toContain('specced_by: autocatalyst');

      // Git commit recorded for the file
      expect(harness.commits).toHaveLength(1);
      expect(harness.commits[0]!.relativePaths).toContain(expectedRelativePath);

      // Artifact persisted with correct fields
      const artifacts = await harness.artifactRepository.listByRun(specAuthorRun.id);
      expect(artifacts).toHaveLength(1);

      const artifact = artifacts[0]!;
      expect(artifact.kind).toBe(kind);
      expect(artifact.canonicalRecord).toBe('file');
      expect(artifact.location).toBe(expectedRelativePath);
      expect(artifact.cachedStatus).toBe('draft');
    }
  );
});
