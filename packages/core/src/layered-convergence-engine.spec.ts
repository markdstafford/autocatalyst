import { describe, it, expect, vi } from 'vitest';
import { createLayeredConvergenceEngine } from './layered-convergence-engine.js';
import { ConvergenceEngineConfigurationError } from './convergence-engine.js';
import type {
  AltitudeCheckpointRef,
  CreateFeedbackInput,
  Feedback,
  FindingDisposition,
  ReviewerFinding,
  ReviewerResult,
  Run,
  RunStep
} from '@autocatalyst/api-contract';
import type {
  ModelRoutingResolver,
  ModelRoutingResolution
} from './model-routing-resolver.js';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';
import type {
  FeedbackRepository,
  RunStepRepository,
  UpdateRunStepCheckpointInput
} from './domain-repositories.js';
import type {
  ReviewedRoleDispatcher,
  RunRoleWorkInput,
  ReviewedRoleDispatchResult
} from './reviewed-role-dispatcher.js';
import type {
  RunWorkspaceGitPort,
  RunWorkspaceCommitFilesInput,
  RunWorkspaceCommitResult,
  CaptureCheckpointRefInput,
  CaptureCheckpointRefResult,
  ReadFileAtRefInput,
  ListFilesAtRefInput
} from './run-workspace-git.js';
import type { RunStepDefinition } from './run-step-catalog.js';
import type { RunWorkflowDefinition } from './run-workflows.js';
import type { ResolvedStepConvergencePolicy } from './convergence-policy.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class InMemoryFeedbackRepo implements FeedbackRepository {
  readonly created: Feedback[] = [];
  private seq = 0;
  async create(input: CreateFeedbackInput): Promise<Feedback> {
    this.seq += 1;
    const now = '2025-01-01T00:00:00.000Z';
    const fb: Feedback = {
      id: `fb_${this.seq}`,
      runId: input.runId,
      owner: input.owner,
      tenant: input.tenant,
      target: input.target,
      status: input.status,
      title: input.title,
      body: input.body,
      ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
      thread: input.thread,
      createdAt: now,
      updatedAt: now
    };
    this.created.push(fb);
    return fb;
  }
  async findById(): Promise<Feedback | null> { return null; }
  async listByRun(): Promise<readonly Feedback[]> { return this.created; }
  async updateStatusAndAppendThread(): Promise<Feedback> { throw new Error('not implemented'); }
  async appendThreadEntry(): Promise<Feedback> { throw new Error('not implemented'); }
}

class StubRunStepRepo implements RunStepRepository {
  readonly checkpoints: UpdateRunStepCheckpointInput[] = [];
  async create(): Promise<RunStep> { throw new Error('not implemented'); }
  async findById(): Promise<RunStep | null> { return null; }
  async listByRun(): Promise<readonly RunStep[]> { return []; }
  async updateCheckpoint(input: UpdateRunStepCheckpointInput): Promise<RunStep> {
    this.checkpoints.push(input);
    return {
      id: input.runStepId,
      runId: input.runId,
      phase: 'implementation',
      step: 'implementation.build',
      role: 'implementer',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: null,
      durationMs: null,
      occurrence: { index: 0, attempt: 1 },
      checkpointResult: input.checkpointResult
    };
  }
}

class StubGit implements RunWorkspaceGitPort {
  readonly commits: RunWorkspaceCommitFilesInput[] = [];
  readonly captures: CaptureCheckpointRefInput[] = [];
  changedFileCount = 1;
  captureShouldThrow = false;
  filesAtRef: readonly string[] = [];
  fileContentByPath: Record<string, string | null> = {};
  reviewerPolicy = {
    fileAccess: 'read_only' as const,
    gitAccess: 'read_only' as const,
    forbiddenGitActions: ['commit'] as const
  };
  async commitFiles(input: RunWorkspaceCommitFilesInput): Promise<RunWorkspaceCommitResult> {
    this.commits.push(input);
    return { commitSha: `sha_${this.commits.length}`, changedFileCount: this.changedFileCount };
  }
  async captureCheckpointRef(input: CaptureCheckpointRefInput): Promise<CaptureCheckpointRefResult> {
    this.captures.push(input);
    if (this.captureShouldThrow) {
      throw new Error('capture ref failed');
    }
    return {
      ref: `refs/autocatalyst/runs/${input.runId}/${input.altitude}`,
      commitSha: input.commitSha
    };
  }
  async readFileAtRef(input: ReadFileAtRefInput): Promise<string | null> {
    return this.fileContentByPath[input.path] ?? null;
  }
  async listFilesAtRef(_input: ListFilesAtRefInput): Promise<readonly string[]> {
    return this.filesAtRef;
  }
}

interface ScriptedDispatch {
  readonly role: 'implementer' | 'reviewer';
  readonly round: number;
  readonly altitude?: string;
  readonly result: ReviewedRoleDispatchResult;
}

class ScriptedDispatcher implements ReviewedRoleDispatcher {
  readonly calls: RunRoleWorkInput[] = [];
  constructor(private readonly script: ScriptedDispatch[]) {}
  async runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult> {
    this.calls.push(input);
    const altitude = input.reviewContext?.altitudeContext?.altitude;
    const match = this.script.find(
      (s) =>
        s.role === input.role &&
        s.round === input.round &&
        (s.altitude === undefined || s.altitude === altitude)
    );
    if (match === undefined) {
      throw new Error(
        `No scripted response for role=${input.role} round=${input.round} altitude=${altitude ?? 'none'}`
      );
    }
    return match.result;
  }
}

function makeResolution(profileId: string): ModelRoutingResolution {
  return {
    routeId: `route-${profileId}`,
    profileId,
    routingTableId: 'table-1',
    profile: {
      mode: 'agent',
      providerKind: 'anthropic',
      adapterId: 'claude-code',
      configurationRecordId: profileId,
      model: { model: `model-${profileId}` },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'process_environment'
    },
    credentialReference: {
      required: true,
      secretHandle: 'handle',
      authTarget: 'process_environment'
    }
  };
}

function makeRouting(distinct: boolean): ModelRoutingResolver {
  const implResolution = makeResolution('impl');
  const revResolution = makeResolution('rev');
  if (distinct) {
    return {
      resolveAgentRoute: vi.fn(),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockResolvedValue({
        step: 'implementation.build',
        distinctBy: 'model',
        resolutionsByRole: { implementer: implResolution, reviewer: revResolution }
      })
    };
  }
  return {
    resolveAgentRoute: vi
      .fn()
      .mockResolvedValueOnce(implResolution)
      .mockResolvedValueOnce(revResolution),
    resolveDirectRoute: vi.fn(),
    resolveDistinctAgentRoutes: vi
      .fn()
      .mockRejectedValue(
        new ModelRoutingConfigurationError('role_distinct_unsatisfied', 'collision', {
          distinctBy: 'model'
        })
      )
  };
}

const stepDefBoth: RunStepDefinition = {
  id: 'implementation.build',
  phase: 'implementation',
  waitingOn: 'ai',
  roles: ['implementer', 'reviewer']
};

const stepDefImplementerOnly: RunStepDefinition = {
  id: 'implementation.plan',
  phase: 'implementation',
  waitingOn: 'ai',
  roles: ['implementer']
};

const fakeRun: Run = {
  id: 'run-1',
  topicId: 'topic-1',
  owner: { id: 'owner-1', kind: 'human', tenantId: 'tenant-1' },
  tenant: 'tenant-1',
  workKind: 'feature',
  currentStep: 'implementation.build',
  terminal: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z'
};

const fakeRunStep: RunStep = {
  id: 'run-step-1',
  runId: 'run-1',
  phase: 'implementation',
  step: 'implementation.build',
  role: 'implementer',
  startedAt: '2025-01-01T00:00:00.000Z',
  endedAt: null,
  durationMs: null,
  occurrence: { index: 0, attempt: 1 },
  checkpointResult: null
};

const fakeWorkflow: RunWorkflowDefinition = {
  id: 'feature',
  workKind: 'feature',
  steps: ['implementation.build', 'done'],
  transitions: {
    'implementation.build': { advance: 'done', needs_input: 'implementation.awaiting_input' }
  }
};

function implResultAdvance(
  round: number,
  altitude: string,
  dispositions: FindingDisposition[] = []
): ScriptedDispatch {
  return {
    role: 'implementer',
    round,
    altitude,
    result: {
      workResult: { directive: 'advance', result: {} },
      dispositions,
      sessionId: `impl-${altitude}-${round}`,
      lastPosition: `impl-pos-${altitude}-${round}`
    }
  };
}

function reviewerResultDispatch(
  round: number,
  altitude: string,
  result: ReviewerResult
): ScriptedDispatch {
  return {
    role: 'reviewer',
    round,
    altitude,
    result: {
      workResult: { directive: 'advance', result: result as unknown as Readonly<Record<string, unknown>> },
      reviewerResult: result,
      sessionId: `rev-${altitude}-${round}`,
      lastPosition: `rev-pos-${altitude}-${round}`
    }
  };
}

function policyOf(
  depth: ResolvedStepConvergencePolicy['depth'],
  maxRounds = 3
): ResolvedStepConvergencePolicy {
  return { maxRounds, depth };
}

const workspace = { workspaceRepoRoot: '/tmp/repo', workspaceHandle: 'h' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLayeredConvergenceEngine', () => {
  it('rejects when step lacks both implementer and reviewer roles', async () => {
    const engine = createLayeredConvergenceEngine({
      dispatcher: new ScriptedDispatcher([]),
      git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('build_only')
    });
    await expect(
      engine.run({
        runId: 'run-1',
        run: fakeRun,
        tenant: 'tenant-1',
        runStep: fakeRunStep,
        stepDefinition: stepDefImplementerOnly,
        workflow: fakeWorkflow
      })
    ).rejects.toBeInstanceOf(ConvergenceEngineConfigurationError);
  });

  it('build_only depth: runs single altitude with no checkpoint refs captured', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const git = new StubGit();
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('build_only')
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    expect(out.workResult.directive).toBe('advance');
    expect(out.checkpointResult.outcome).toBe('converged');
    expect(git.captures).toHaveLength(0);
    expect(out.checkpointResult.acceptedCheckpoints).toEqual([]);
    expect(out.checkpointResult.depth).toBe('build_only');
    expect(out.checkpointResult.currentAltitude).toBe('build');
    expect(out.checkpointResult.rounds.every((r) => r.altitude === 'build')).toBe(true);
  });

  it('layout depth: layout converges, captures ref, build converges, advances', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' }),
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const git = new StubGit();
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout')
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    expect(out.workResult.directive).toBe('advance');
    expect(git.captures).toHaveLength(1);
    expect(git.captures[0]?.altitude).toBe('layout');
    expect(out.checkpointResult.acceptedCheckpoints?.length).toBe(1);
    expect(out.checkpointResult.acceptedCheckpoints?.[0]?.altitude).toBe('layout');
    expect(out.checkpointResult.rounds.find((r) => r.altitude === 'layout')).toBeDefined();
    expect(out.checkpointResult.rounds.find((r) => r.altitude === 'build')).toBeDefined();
    // Both implementer and reviewer receive altitude context for each altitude.
    expect(dispatcher.calls[0]?.reviewContext?.altitudeContext?.altitude).toBe('layout');
    expect(dispatcher.calls[1]?.reviewContext?.altitudeContext?.altitude).toBe('layout');
    expect(dispatcher.calls[2]?.reviewContext?.altitudeContext?.altitude).toBe('build');
    expect(dispatcher.calls[3]?.reviewContext?.altitudeContext?.altitude).toBe('build');
  });

  it('full depth: all four altitudes converge, captures three refs, advances', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' }),
      implResultAdvance(1, 'public_api'),
      reviewerResultDispatch(1, 'public_api', { status: 'satisfied' }),
      implResultAdvance(1, 'private_api'),
      reviewerResultDispatch(1, 'private_api', { status: 'satisfied' }),
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const git = new StubGit();
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('full')
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    expect(out.workResult.directive).toBe('advance');
    expect(git.captures.map((c) => c.altitude)).toEqual(['layout', 'public_api', 'private_api']);
    expect(out.checkpointResult.acceptedCheckpoints?.length).toBe(3);
    expect(out.checkpointResult.depth).toBe('full');
    expect(
      out.checkpointResult.rounds.map((round) => `${round.altitude}:${round.round}`)
    ).toEqual(['layout:1', 'public_api:1', 'private_api:1', 'build:1']);
  });

  it('escalates with needs_input when early altitude exhausts max rounds before descending', async () => {
    const layoutBlocker: ReviewerFinding = {
      title: 'Layout missing',
      body: 'add module',
      severity: 'blocker'
    };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', {
        status: 'findings',
        findings: [layoutBlocker]
      })
    ]);
    // Make the layout file a test file so the deterministic altitude validator emits a blocker.
    const git = new StubGit();
    git.filesAtRef = ['src/foo.spec.ts'];
    git.fileContentByPath = { 'src/foo.spec.ts': 'export const x = 1;' };
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout', 1)
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    expect(out.workResult.directive).toBe('needs_input');
    expect(out.checkpointResult.outcome).toBe('max_rounds');
    expect(out.checkpointResult.currentAltitude).toBe('layout');
    // Build altitude should never have been touched.
    expect(out.checkpointResult.rounds.every((r) => r.altitude === 'layout')).toBe(true);
    expect(git.captures).toHaveLength(0);
  });

  it('round numbers reset per altitude', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' }),
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout')
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    expect(out.workResult.directive).toBe('advance');
    const layoutRound = out.checkpointResult.rounds.find((r) => r.altitude === 'layout');
    const buildRound = out.checkpointResult.rounds.find((r) => r.altitude === 'build');
    expect(layoutRound?.round).toBe(1);
    expect(buildRound?.round).toBe(1);
  });

  it('captureCheckpointRef failure returns needs_input', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' })
    ]);
    const git = new StubGit();
    git.captureShouldThrow = true;
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout')
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    expect(out.workResult.directive).toBe('needs_input');
    expect(out.checkpointResult.outcome).toBe('needs_input');
  });

  it('passes altitudeContext to dispatcher', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' }),
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout')
    });
    await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    const layoutImpl = dispatcher.calls.find(
      (c) => c.role === 'implementer' && c.reviewContext?.altitudeContext?.altitude === 'layout'
    );
    expect(layoutImpl).toBeDefined();
    const buildImpl = dispatcher.calls.find(
      (c) => c.role === 'implementer' && c.reviewContext?.altitudeContext?.altitude === 'build'
    );
    expect(buildImpl?.reviewContext?.altitudeContext?.acceptedCheckpoints?.length).toBe(1);
  });

  it('persists checkpoint after each round', async () => {
    const runSteps = new StubRunStepRepo();
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' }),
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps,
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout')
    });
    await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    // 1 round for layout + 1 round for build = 2 checkpoints minimum
    expect(runSteps.checkpoints.length).toBeGreaterThanOrEqual(2);
  });

  it('escalation without needs_input edge returns fail', async () => {
    const workflowNoEscalation: RunWorkflowDefinition = {
      id: 'feature',
      workKind: 'feature',
      steps: ['implementation.build', 'done'],
      transitions: {
        'implementation.build': { advance: 'done' }
      }
    };
    const blocker: ReviewerFinding = { title: 'X', body: 'Y', severity: 'blocker' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'findings', findings: [blocker] })
    ]);
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('build_only', 1)
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: workflowNoEscalation,
      workspace
    });
    expect(out.workResult.directive).toBe('fail');
    expect((out.workResult as { directive: 'fail'; reason: string }).reason).toBe(
      'workflow_escalation_edge_missing'
    );
  });

  it('deterministic altitude_contract findings cannot be cleared by implementer decline dispositions', async () => {
    // The implementer attempts to 'decline' an altitude_contract finding.
    // Deterministic findings bypass findingsByFeedbackId tracking so they are
    // not tracked as reviewer findings — dispositions targeting their feedbackId
    // are simply ignored, and the finding re-emits on every round.
    const git = new StubGit();
    // Spec file triggers altitude_contract violation at layout altitude
    git.filesAtRef = ['src/widget.spec.ts'];
    git.fileContentByPath = { 'src/widget.spec.ts': 'export const x = 1;' };

    const dispatcher = new ScriptedDispatcher([
      // Round 1 — implementer advances with no dispositions
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' }),
      // Round 2 — implementer tries to 'decline' the deterministic finding
      {
        role: 'implementer',
        round: 2,
        altitude: 'layout',
        result: {
          workResult: { directive: 'advance', result: {} },
          // The feedbackId used by deterministic findings is their deterministicKey
          dispositions: [
            {
              feedbackId: 'altitude_contract:layout:src/widget.spec.ts:is_test_file',
              disposition: 'declined' as const,
              reason: 'not relevant'
            }
          ],
          sessionId: 'impl-layout-2',
          lastPosition: 'impl-pos-layout-2'
        }
      },
      reviewerResultDispatch(2, 'layout', { status: 'satisfied' })
    ]);

    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      // maxRounds=2 so round 2 exhausts the budget
      getPolicy: () => policyOf('layout', 2)
    });

    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });

    // Max rounds exhausted at layout altitude due to deterministic blocker re-emitting
    expect(out.workResult.directive).toBe('needs_input');
    // The layout altitude must still be blocking (not cleared by the decline)
    const lastRound = out.checkpointResult.rounds[out.checkpointResult.rounds.length - 1];
    expect(lastRound?.altitude).toBe('layout');
    const altitudeContractFinding = lastRound?.findings.find(
      (f) => f.source === 'altitude_contract' && f.blocking === true
    );
    expect(altitudeContractFinding).toBeDefined();
    expect(altitudeContractFinding?.source).toBe('altitude_contract');
    expect(altitudeContractFinding?.blocking).toBe(true);
    // openFeedbackIds tracks the blocking deterministic finding across rounds.
    expect(out.checkpointResult.openFeedbackIds.length).toBeGreaterThanOrEqual(1);
  });

  it('persists reviewer findings as feedback at early altitude', async () => {
    const feedback = new InMemoryFeedbackRepo();
    const layoutFinding: ReviewerFinding = {
      title: 'Layout suggestion',
      body: 'Consider X.',
      severity: 'warning'
    };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', {
        status: 'findings',
        findings: [layoutFinding]
      }),
      implResultAdvance(2, 'layout', [
        { feedbackId: 'fb_1', disposition: 'declined', reason: 'out of scope' }
      ]),
      reviewerResultDispatch(2, 'layout', { status: 'satisfied' }),
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git: new StubGit(),
      feedback,
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout', 3)
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    expect(feedback.created.length).toBeGreaterThan(0);
    expect(out.workResult.directive).toBe('advance');
  });
});

describe('createLayeredConvergenceEngine - acceptedCheckpoints semantics', () => {
  it('acceptedCheckpoints contain ref, commitSha, acceptedAt', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1, 'layout'),
      reviewerResultDispatch(1, 'layout', { status: 'satisfied' }),
      implResultAdvance(1, 'build'),
      reviewerResultDispatch(1, 'build', { status: 'satisfied' })
    ]);
    const engine = createLayeredConvergenceEngine({
      dispatcher,
      git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => policyOf('layout'),
      clock: () => '2025-06-01T12:00:00.000Z'
    });
    const out = await engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefBoth,
      workflow: fakeWorkflow,
      workspace
    });
    const checkpoint: AltitudeCheckpointRef = out.checkpointResult.acceptedCheckpoints![0]!;
    expect(checkpoint.altitude).toBe('layout');
    expect(checkpoint.ref).toContain('layout');
    expect(checkpoint.commitSha).toMatch(/^sha_/);
    expect(checkpoint.acceptedAt).toBe('2025-06-01T12:00:00.000Z');
  });
});
