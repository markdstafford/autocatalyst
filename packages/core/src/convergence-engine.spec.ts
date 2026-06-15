import { describe, it, expect, vi } from 'vitest';
import {
  findingSignature,
  isBlockingFinding,
  computeCurrentBlockingSet,
  detectOscillation,
  resolveReviewedRoutes,
  createConvergenceEngine,
  ConvergenceEngineConfigurationError
} from './convergence-engine.js';
import type {
  ConvergenceCheckpoint,
  CreateFeedbackInput,
  Feedback,
  FindingDisposition,
  JsonValue,
  ReviewerFinding,
  ReviewerResult,
  Run,
  RunStep
} from '@autocatalyst/api-contract';
import type { ModelRoutingResolver, ModelRoutingResolution } from './model-routing-resolver.js';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';
import type { FeedbackRepository, RunStepRepository, UpdateRunStepCheckpointInput } from './domain-repositories.js';
import type { ReviewedRoleDispatcher, RunRoleWorkInput, ReviewedRoleDispatchResult } from './reviewed-role-dispatcher.js';
import type { RunWorkspaceGitPort, RunWorkspaceCommitFilesInput, RunWorkspaceCommitResult } from './run-workspace-git.js';
import type { RunStepDefinition } from './run-step-catalog.js';
import type { RunWorkflowDefinition } from './run-workflows.js';

const warnFinding: ReviewerFinding = { title: 'Missing test', body: 'Add coverage for edge case.', severity: 'warning' };
const blockerFinding: ReviewerFinding = { title: 'Security hole', body: 'SQL injection risk.', severity: 'blocker' };
const infoFinding: ReviewerFinding = { title: 'Style note', body: 'Consider renaming.', severity: 'info' };

describe('findingSignature', () => {
  it('produces stable signature for same finding', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature(warnFinding);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different severities', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature({ ...warnFinding, severity: 'blocker' });
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different titles', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature({ ...warnFinding, title: 'Different title' });
    expect(sig1).not.toBe(sig2);
  });
});

describe('isBlockingFinding', () => {
  it('info is never blocking', () => {
    expect(isBlockingFinding(infoFinding, [])).toBe(false);
  });

  it('warning is blocking when not declined', () => {
    expect(isBlockingFinding(warnFinding, [])).toBe(true);
  });

  it('blocker is blocking when not declined', () => {
    expect(isBlockingFinding(blockerFinding, [])).toBe(true);
  });

  it('warning is non-blocking when its signature is in declined set', () => {
    const sig = findingSignature(warnFinding);
    expect(isBlockingFinding(warnFinding, [sig])).toBe(false);
  });
});

describe('detectOscillation', () => {
  it('returns false with no previous rounds', () => {
    expect(detectOscillation([], ['sig-1'])).toBe(false);
  });

  it('detects repeated blocking signature after implementer had chance to respond', () => {
    // Round 1 had a finding with same signature, implementer had a chance
    const previousRounds = [{
      round: 1,
      changedFileCount: 0,
      findings: [{ feedbackId: 'fb-1', title: 'Missing test', body: 'Add coverage for edge case.', severity: 'warning' as const, blocking: true, signature: 'sig-1' }],
      dispositions: [],
      outcome: 'continue' as const
    }];
    expect(detectOscillation(previousRounds, ['sig-1'])).toBe(true);
  });

  it('detects non-decreasing blocking count when implementer had at least one chance', () => {
    const previousRounds = [
      { round: 1, changedFileCount: 0, findings: [
        { feedbackId: 'fb-1', title: 'A', body: 'B', severity: 'warning' as const, blocking: true, signature: 'sig-1' },
        { feedbackId: 'fb-2', title: 'C', body: 'D', severity: 'blocker' as const, blocking: true, signature: 'sig-2' }
      ], dispositions: [], outcome: 'continue' as const }
    ];
    // Current blocking set has 2 or more items (non-decreasing from round 1's 2)
    expect(detectOscillation(previousRounds, ['sig-1', 'sig-2', 'sig-3'])).toBe(true);
  });

  it('does not trigger oscillation on first round', () => {
    // No previous rounds = no oscillation possible
    expect(detectOscillation([], ['sig-1', 'sig-2'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveReviewedRoutes
// ---------------------------------------------------------------------------

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

describe('resolveReviewedRoutes', () => {
  it('calls resolveDistinctAgentRoutes with implementer and reviewer roles', async () => {
    const implementerResolution = makeResolution('profile-impl');
    const reviewerResolution = makeResolution('profile-rev');

    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn(),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockResolvedValue({
        step: 'produce',
        distinctBy: 'model',
        resolutionsByRole: {
          implementer: implementerResolution,
          reviewer: reviewerResolution
        }
      })
    };

    const result = await resolveReviewedRoutes({
      tenant: 'tenant-1',
      runId: 'run-1',
      step: 'produce',
      routing
    });

    expect(routing.resolveDistinctAgentRoutes).toHaveBeenCalledWith({
      tenant: 'tenant-1',
      runId: 'run-1',
      step: 'produce',
      roles: ['implementer', 'reviewer']
    });
    expect(result.implementerRoute).toBe(implementerResolution);
    expect(result.reviewerRoute).toBe(reviewerResolution);
    expect(result.routingInfo.distinct).toBe(true);
  });

  it('falls back to single-route when distinctness fails and logs a sanitized warning', async () => {
    const implementerResolution = makeResolution('profile-same');
    const reviewerResolution = makeResolution('profile-same');

    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn()
        .mockResolvedValueOnce(implementerResolution)
        .mockResolvedValueOnce(reviewerResolution),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError(
          'role_distinct_unsatisfied',
          'Resolved roles do not satisfy the distinct-model requirement.',
          { tenant: 'tenant-1', runId: 'run-1', step: 'produce', roles: ['implementer', 'reviewer'], distinctBy: 'model' }
        )
      )
    };

    const logger = { warn: vi.fn() };

    const result = await resolveReviewedRoutes({
      tenant: 'tenant-1',
      runId: 'run-1',
      step: 'produce',
      routing,
      logger
    });

    expect(result.implementerRoute).toBe(implementerResolution);
    expect(result.reviewerRoute).toBe(reviewerResolution);
    expect(result.routingInfo.distinct).toBe(false);
    expect(result.routingInfo.warningCode).toBe('role_distinct_unsatisfied');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('warning does not include credential data or raw prompts', async () => {
    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn()
        .mockResolvedValueOnce(makeResolution('profile-a'))
        .mockResolvedValueOnce(makeResolution('profile-b')),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError(
          'role_distinct_unsatisfied',
          'Resolved roles do not satisfy the distinct-model requirement.',
          { tenant: 'tenant-1', runId: 'run-2', step: 'produce', roles: ['implementer', 'reviewer'], distinctBy: 'model' }
        )
      )
    };

    const warnCalls: Array<[string, Record<string, unknown>]> = [];
    const logger = {
      warn: (msg: string, details: Record<string, unknown>) => {
        warnCalls.push([msg, details]);
      }
    };

    await resolveReviewedRoutes({
      tenant: 'tenant-1',
      runId: 'run-2',
      step: 'produce',
      routing,
      logger
    });

    expect(warnCalls.length).toBeGreaterThan(0);

    for (const [msg, details] of warnCalls) {
      const serialized = JSON.stringify({ msg, details });
      // Must not contain credential patterns
      expect(serialized).not.toMatch(/sk-/);
      expect(serialized).not.toMatch(/password/i);
      expect(serialized).not.toMatch(/secret/i);
      expect(serialized).not.toMatch(/credential/i);
      // Must contain safe fields
      expect(details['runId']).toBe('run-2');
      expect(details['step']).toBe('produce');
      expect(details['warningCode']).toBe('role_distinct_unsatisfied');
    }
  });

  it('fails safely when no route is available at all', async () => {
    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError('route_not_found', 'No route found for the requested key.')
      ),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError('route_not_found', 'No route found for the requested key.')
      )
    };

    await expect(
      resolveReviewedRoutes({
        tenant: 'tenant-1',
        runId: 'run-3',
        step: 'produce',
        routing
      })
    ).rejects.toThrow(ModelRoutingConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// createConvergenceEngine
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
  changedFileCount = 1;
  reviewerPolicy = {
    fileAccess: 'read_only' as const,
    gitAccess: 'read_only' as const,
    forbiddenGitActions: ['commit'] as const
  };
  async commitFiles(input: RunWorkspaceCommitFilesInput): Promise<RunWorkspaceCommitResult> {
    this.commits.push(input);
    return { commitSha: `sha_${this.commits.length}`, changedFileCount: this.changedFileCount };
  }
}

interface ScriptedDispatch {
  readonly role: 'implementer' | 'reviewer';
  readonly round: number;
  readonly result: ReviewedRoleDispatchResult;
}

class ScriptedDispatcher implements ReviewedRoleDispatcher {
  readonly calls: RunRoleWorkInput[] = [];
  constructor(private readonly script: ScriptedDispatch[]) {}
  async runRole(input: RunRoleWorkInput): Promise<ReviewedRoleDispatchResult> {
    this.calls.push(input);
    const match = this.script.find(s => s.role === input.role && s.round === input.round);
    if (match === undefined) {
      throw new Error(`No scripted response for role=${input.role} round=${input.round}`);
    }
    return match.result;
  }
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
    resolveAgentRoute: vi.fn().mockResolvedValueOnce(implResolution).mockResolvedValueOnce(revResolution),
    resolveDirectRoute: vi.fn(),
    resolveDistinctAgentRoutes: vi.fn().mockRejectedValue(
      new ModelRoutingConfigurationError('role_distinct_unsatisfied', 'collision', { distinctBy: 'model' })
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

function implResultAdvance(round: number, dispositions: FindingDisposition[] = []): ScriptedDispatch {
  return {
    role: 'implementer',
    round,
    result: {
      workResult: { directive: 'advance', result: {} },
      dispositions,
      sessionId: `impl-session-${round}`,
      lastPosition: `impl-pos-${round}`
    }
  };
}

function reviewerResultDispatch(round: number, result: ReviewerResult): ScriptedDispatch {
  return {
    role: 'reviewer',
    round,
    result: {
      workResult: { directive: 'advance', result: result as unknown as Readonly<Record<string, unknown>> },
      reviewerResult: result,
      sessionId: `rev-session-${round}`,
      lastPosition: `rev-pos-${round}`
    }
  };
}

describe('createConvergenceEngine', () => {
  it('rejects when step lacks both implementer and reviewer roles', async () => {
    const engine = createConvergenceEngine({
      dispatcher: new ScriptedDispatcher([]),
      git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    await expect(engine.run({
      runId: 'run-1',
      run: fakeRun,
      tenant: 'tenant-1',
      runStep: fakeRunStep,
      stepDefinition: stepDefImplementerOnly,
      workflow: fakeWorkflow
    })).rejects.toBeInstanceOf(ConvergenceEngineConfigurationError);
  });

  it('runs implementer BEFORE commit and commit BEFORE reviewer', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'satisfied' })
    ]);
    const git = new StubGit();
    const engine = createConvergenceEngine({
      dispatcher, git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    // Order: implementer call, then commit, then reviewer call.
    expect(dispatcher.calls[0]?.role).toBe('implementer');
    expect(git.commits.length).toBe(1);
    expect(dispatcher.calls[1]?.role).toBe('reviewer');
  });

  it('host commits changed files after implementer execution', async () => {
    const git = new StubGit();
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow,
      workspace: { workspaceRepoRoot: '/tmp/repo', workspaceHandle: 'h' }
    });
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]?.workspaceRepoRoot).toBe('/tmp/repo');
    expect(git.commits[0]?.runId).toBe('run-1');
  });

  it('returns fail when reviewer output does not validate against schema', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      {
        role: 'reviewer',
        round: 1,
        result: {
          workResult: { directive: 'advance', result: { wrong: 'shape' } },
          sessionId: 'rev-1'
        }
      }
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('fail');
  });

  it('persists reviewer findings as Feedback BEFORE convergence decision', async () => {
    const feedback = new InMemoryFeedbackRepo();
    const runSteps = new StubRunStepRepo();
    const blocker: ReviewerFinding = { title: 'Missing test', body: 'Add coverage.', severity: 'blocker' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blocker] }),
      // Round 2: implementer fixes, reviewer satisfied
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'added' }]),
      reviewerResultDispatch(2, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback, runSteps,
      routing: makeRouting(true)
    });
    await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    // Feedback persisted before first checkpoint write.
    expect(feedback.created.length).toBeGreaterThan(0);
    expect(runSteps.checkpoints.length).toBeGreaterThan(0);
  });

  it('passes unresolved findings as required dispositions to next implementer round', async () => {
    const blocker: ReviewerFinding = { title: 'Bug', body: 'Fix this.', severity: 'blocker' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blocker] }),
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'ok' }]),
      reviewerResultDispatch(2, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    const round2Impl = dispatcher.calls.find(c => c.role === 'implementer' && c.round === 2);
    expect(round2Impl?.reviewContext?.requiredDispositions?.length).toBe(1);
    expect(round2Impl?.reviewContext?.requiredDispositions?.[0]?.feedbackId).toBe('fb_1');
  });

  it('writes convergence checkpoint after each reviewer pass', async () => {
    const runSteps = new StubRunStepRepo();
    const blocker: ReviewerFinding = { title: 'X', body: 'Y', severity: 'blocker' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blocker] }),
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'ok' }]),
      reviewerResultDispatch(2, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps,
      routing: makeRouting(true)
    });
    await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(runSteps.checkpoints).toHaveLength(2);
  });

  it('returns advance directive when no blocking findings remain', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('advance');
    expect(out.checkpointResult.outcome).toBe('converged');
  });

  it('fresh latest-pass blocker does NOT advance even after implementer claims to fix', async () => {
    const blocker: ReviewerFinding = { title: 'New issue', body: 'New body', severity: 'blocker' };
    // Round 1: produces blocker. Round 2: implementer "fixes" prior, reviewer reports a FRESH blocker.
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [{ title: 'Old', body: 'Old', severity: 'blocker' }] }),
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'ok' }]),
      reviewerResultDispatch(2, { status: 'findings', findings: [blocker] }),
      implResultAdvance(3, [{ feedbackId: 'fb_2', disposition: 'fixed', summary: 'ok' }]),
      reviewerResultDispatch(3, { status: 'findings', findings: [blocker] })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).not.toBe('advance');
  });

  it('fails when implementer returns invalid dispositions', async () => {
    // Set up a scenario where there are previous blocking findings
    const blocker: ReviewerFinding = { title: 'Security hole', body: 'SQL injection risk.', severity: 'blocker' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blocker] }),
      // Round 2: implementer returns a 'declined' disposition with an empty reason — invalid per schema
      {
        role: 'implementer',
        round: 2,
        result: {
          workResult: { directive: 'advance', result: {} },
          dispositions: [{ feedbackId: 'fb_1', disposition: 'declined', reason: '' }],
          sessionId: 'impl-session-2',
          lastPosition: 'impl-pos-2'
        }
      },
      reviewerResultDispatch(2, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('fail');
    expect((out.workResult as { directive: 'fail'; reason: string }).reason).toBe('disposition_invalid');
  });

  it('commit failure prevents reviewer dispatch', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1)
      // No reviewer script entry — reviewer must NOT be called
    ]);
    const failingGit: RunWorkspaceGitPort = {
      reviewerPolicy: new StubGit().reviewerPolicy,
      async commitFiles() { throw new Error('git commit failed'); }
    };
    const engine = createConvergenceEngine({
      dispatcher, git: failingGit,
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    // Commit failure propagates as a thrown error (not a structured fail result)
    await expect(engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    })).rejects.toThrow('git commit failed');
    // Reviewer was never dispatched
    expect(dispatcher.calls.every(c => c.role === 'implementer')).toBe(true);
  });

  it('persisted feedback thread author matches the reviewer model principal', async () => {
    const feedback = new InMemoryFeedbackRepo();
    const customPrincipal: import('@autocatalyst/api-contract').Principal = {
      id: 'custom-reviewer',
      kind: 'model',
      tenantId: 'tenant-1'
    };
    const blocker: ReviewerFinding = { title: 'Issue', body: 'Fix it.', severity: 'blocker' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blocker] }),
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'done' }]),
      reviewerResultDispatch(2, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback,
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      reviewerPrincipal: customPrincipal
    });
    await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(feedback.created.length).toBeGreaterThan(0);
    const firstFeedback = feedback.created[0]!;
    expect(firstFeedback.thread[0]?.author).toEqual(customPrincipal);
  });

  it('declined findings with valid reason are non-blocking for future rounds', async () => {
    const f: ReviewerFinding = { title: 'Style', body: 'consider renaming', severity: 'warning' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [f] }),
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'declined', reason: 'out of scope' }]),
      reviewerResultDispatch(2, { status: 'findings', findings: [f] })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    // Round 2 reviewer reports same finding, but it's been declined → not blocking → advance.
    expect(out.workResult.directive).toBe('advance');
  });

  it('fails when implementer omits all dispositions for required blocking findings in round 2', async () => {
    const blocker: ReviewerFinding = { title: 'Auth bypass', body: 'Missing auth check.', severity: 'blocker' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blocker] }),
      // Round 2: no dispositions at all — should fail with disposition_missing
      implResultAdvance(2, []),
      reviewerResultDispatch(2, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('fail');
    expect((out.workResult as { directive: 'fail'; reason: string }).reason).toBe('disposition_missing');
  });

  it('fails when implementer provides partial dispositions missing one required finding', async () => {
    const b1: ReviewerFinding = { title: 'Bug A', body: 'Fix A.', severity: 'blocker' };
    const b2: ReviewerFinding = { title: 'Bug B', body: 'Fix B.', severity: 'warning' };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [b1, b2] }),
      // Round 2: only disposes fb_1, not fb_2
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'fixed A' }]),
      reviewerResultDispatch(2, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('fail');
    expect((out.workResult as { directive: 'fail'; reason: string }).reason).toBe('disposition_missing');
  });

  it('does not require dispositions in round 1 when there are no prior blocking findings', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'satisfied' })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true)
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('advance');
  });
});

describe('escalation', () => {
  const blockerFindingA: ReviewerFinding = { title: 'Security hole', body: 'SQL injection risk.', severity: 'blocker' };

  it('returns needs_input with max_rounds outcome when max rounds exhausted', async () => {
    // maxRounds: 1 via getPolicy override
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blockerFindingA] })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => ({ maxRounds: 1 })
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('needs_input');
    expect(out.checkpointResult.outcome).toBe('max_rounds');
    expect(out.checkpointResult.openFeedbackIds.length).toBeGreaterThan(0);
    // lastPositions should be populated from the last sessions
    expect(out.checkpointResult.lastPositions.implementer).toBe('impl-pos-1');
    expect(out.checkpointResult.lastPositions.reviewer).toBe('rev-pos-1');
  });

  it('returns needs_input with oscillation outcome when blocking set does not decrease', async () => {
    // maxRounds: 3, same finding in both rounds triggers oscillation after round 2.
    // Round 2 implementer must provide a disposition for the round-1 blocking finding.
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blockerFindingA] }),
      implResultAdvance(2, [{ feedbackId: 'fb_1', disposition: 'fixed', summary: 'attempted fix' }]),
      reviewerResultDispatch(2, { status: 'findings', findings: [blockerFindingA] })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => ({ maxRounds: 3 })
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).toBe('needs_input');
    expect(out.checkpointResult.outcome).toBe('oscillation');
  });

  it('returns fail with workflow_escalation_edge_missing when needs_input edge not in workflow', async () => {
    // A workflow with no needs_input edge from implementation.build
    const workflowNoEscalation: RunWorkflowDefinition = {
      id: 'feature',
      workKind: 'feature',
      steps: ['implementation.build', 'done'],
      transitions: {
        'implementation.build': { advance: 'done' }
        // Note: no needs_input edge
      }
    };
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blockerFindingA] })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => ({ maxRounds: 1 })
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: workflowNoEscalation
    });
    expect(out.workResult.directive).toBe('fail');
    expect((out.workResult as { directive: 'fail'; reason: string }).reason).toBe('workflow_escalation_edge_missing');
  });

  it('max-round escalation does not return advance or fail the run normally', async () => {
    const dispatcher = new ScriptedDispatcher([
      implResultAdvance(1),
      reviewerResultDispatch(1, { status: 'findings', findings: [blockerFindingA] })
    ]);
    const engine = createConvergenceEngine({
      dispatcher, git: new StubGit(),
      feedback: new InMemoryFeedbackRepo(),
      runSteps: new StubRunStepRepo(),
      routing: makeRouting(true),
      getPolicy: () => ({ maxRounds: 1 })
    });
    const out = await engine.run({
      runId: 'run-1', run: fakeRun, tenant: 'tenant-1', runStep: fakeRunStep,
      stepDefinition: stepDefBoth, workflow: fakeWorkflow
    });
    expect(out.workResult.directive).not.toBe('advance');
    expect(out.workResult.directive).not.toBe('fail');
    expect(out.workResult.directive).toBe('needs_input');
  });
});
