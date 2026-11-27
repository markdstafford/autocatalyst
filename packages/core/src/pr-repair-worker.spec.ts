import type { PullRequest, Run } from '@autocatalyst/api-contract';
import { describe, expect, it, vi } from 'vitest';

import type { RepairDecision } from './pr-ci-repair.js';
import type { PullRequestReadOutcome } from './pr-lifecycle.js';
import { recoverRepairAttempt, type RepairWorkerDependencies } from './pr-repair-worker.js';

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
    workspace: vi.fn(), diff: { getChangedFiles: vi.fn() }, transition: vi.fn(), build: vi.fn(), review: vi.fn(),
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
