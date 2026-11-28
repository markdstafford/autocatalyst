import type { PullRequest, Run, RunStep } from '@autocatalyst/api-contract';
import { describe, expect, it, vi } from 'vitest';

import type { RepairDecision } from './pr-ci-repair.js';
import type { PullRequestReadOutcome } from './pr-lifecycle.js';
import { executeRepair, recoverRepairAttempt, type RepairWorkerDependencies } from './pr-repair-worker.js';

const now = '2026-11-25T00:00:00.000Z';
const owner = { kind: 'human', id: 'user', tenantId: 'tenant' } as const;
const branch = 'feature/run';
const repository = 'org/repo';
const priorHead = 'a'.repeat(40);
const publishHead = 'b'.repeat(40);
const run: Run = {
  id: 'run', topicId: 'topic', tenant: owner.tenantId, owner, currentStep: 'pr.finalize',
  workKind: 'feature', terminal: false, updatedAt: now, createdAt: now
};
const pr: PullRequest = {
  id: 'pr', runId: run.id, tenant: run.tenant, owner, provider: 'github', branch, number: 12,
  url: 'https://github.com/org/repo/pull/12', state: 'open', createdAt: now, updatedAt: now
};
const publishing: RepairDecision = {
  pullRequestId: pr.id, runId: run.id, tenant: run.tenant, gateStepId: 'gate', repairStepId: 'build',
  state: 'publishing', currentStepId: 'final', outcomeStepId: null, ownerEpoch: 'retired', headSha: priorHead,
  publishHeadSha: publishHead, pushReceipt: null, candidateSha: null, baseRef: 'main',
  ordinal: 1, limitAtDecision: 2, admittedCount: 0, refreshCount: 0, stopCode: null, workspaceHold: false,
  createdAt: now, updatedAt: now, failures: []
};

function dependencies(state: PullRequest['state'], headSha: string | undefined) {
  const observation: PullRequestReadOutcome = {
    kind: 'observed', repository, failures: null, requiredPending: false,
    facts: {
      provider: pr.provider, number: pr.number, url: pr.url, branch, state,
      baseBranch: 'main', headRepository: repository, ...(headSha !== undefined ? { headSha } : {})
    }
  };
  return {
    repository: { admit: vi.fn(), listByRun: vi.fn(), listRecoverable: vi.fn(), move: vi.fn(), clearDrainedHold: vi.fn() },
    epoch: 'successor', clock: () => now, pullRequest: vi.fn(async () => pr), observe: vi.fn(async () => observation),
    workspace: vi.fn(), diff: { getChangedFiles: vi.fn() }, transition: vi.fn<RepairWorkerDependencies['transition']>(), build: vi.fn<RepairWorkerDependencies['build']>(), review: vi.fn(),
    git: { integrate: vi.fn(), readTarget: vi.fn(), readSource: vi.fn(), readCandidate: vi.fn(),
      verifyFreeze: vi.fn(), sameTree: vi.fn(), pushCandidate: vi.fn() }
  } satisfies RepairWorkerDependencies;
}

describe('repair ownership recovery', () => {
  it('neither replays a push nor advances provenance from an intent with a matching provider head', async () => {
    const deps = dependencies('open', publishHead);
    await recoverRepairAttempt(run, publishing, deps);
    expect(deps.transition).toHaveBeenCalledExactlyOnceWith({
      from: publishing, state: 'stopped', nextStep: 'pr.human_review', stopCode: 'repair_push_unverified', now, hold: true
    });
    expect(deps.git.pushCandidate).not.toHaveBeenCalled();
    expect(deps.build).not.toHaveBeenCalled();
  });

  it('finishes an already verified push without writing to the remote again', async () => {
    const deps = dependencies('open', publishHead);
    const attempt = { ...publishing, pushReceipt: {
      kind: 'publication_push_receipt' as const, runId: run.id, repository, branch, headSha: publishHead
    } };
    await recoverRepairAttempt(run, attempt, deps);
    expect(deps.transition).toHaveBeenCalledExactlyOnceWith({ from: attempt, state: 'pushed', nextStep: 'pr.human_review', now });
    expect(deps.git.pushCandidate).not.toHaveBeenCalled();
  });

  it('gives independently verified terminal state precedence over an uncertain push', async () => {
    const deps = dependencies('merged', undefined);
    await recoverRepairAttempt(run, publishing, deps);
    expect(deps.transition).toHaveBeenCalledExactlyOnceWith({
      from: publishing, state: 'superseded', nextStep: 'done', prTerminal: 'merged', stopCode: 'repair_pr_merged',
      now, hold: true
    });
    expect(deps.git.pushCandidate).not.toHaveBeenCalled();
  });
});

describe('repair conversation binding', () => {
  it.each(['exact', 'wrong-repository', 'wrong-branch', 'lost-ownership'] as const)(
    'passes continuity binding to build only for the verified current repair (%s)', async mode => {
      const start = {
        run: { ...run, currentStep: 'implementation.build' },
        runStep: { id: 'repair-build', runId: run.id, step: 'implementation.build' } as RunStep
      };
      const attempt: RepairDecision = { ...publishing, state: 'queued', headSha: priorHead, currentStepId: start.runStep.id };
      const deps = dependencies('open', priorHead);
      const initial = await deps.observe();
      if (initial.kind !== 'observed') throw new Error('Expected a PR observation.');
      deps.observe.mockResolvedValue({ ...initial, failures: [{ id: 'check', name: 'test', kind: 'check_run', conclusion: 'failure' }] });
      deps.workspace.mockResolvedValue({
        workspaceRepoRoot: '/fixture', base: 'main', remote: 'origin', token: 'fixture',
        repository: mode === 'wrong-repository' ? 'other/repo' : repository,
        branch: mode === 'wrong-branch' ? 'feature/changed' : branch
      });
      deps.git.readCandidate.mockResolvedValue(priorHead);
      deps.diff.getChangedFiles.mockResolvedValue([]);
      const claimed: RepairDecision = { ...attempt, state: 'running', ownerEpoch: deps.epoch };
      deps.transition.mockResolvedValueOnce({ decision: claimed }).mockResolvedValue(null);
      deps.repository.listByRun.mockResolvedValue(mode === 'lost-ownership' ? [] : [claimed]);
      deps.build.mockRejectedValue(new Error('fixture'));
      await executeRepair(start, attempt, deps);
      if (mode === 'exact') {
        expect(deps.build).toHaveBeenCalledExactlyOnceWith(start.run, start.runStep, expect.objectContaining({ state: 'running' }),
          expect.any(Function), { repository, branch, id: pr.id, number: pr.number });
        const owns = deps.build.mock.calls[0]![3];
        expect(await owns()).toBe(true);
        deps.repository.listByRun.mockResolvedValue([]);
        expect(await owns()).toBe(false);
      } else expect(deps.build).not.toHaveBeenCalled();
      expect(deps.git.pushCandidate).not.toHaveBeenCalled();
    }
  );
});
