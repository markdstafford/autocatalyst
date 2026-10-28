import { describe, expect, it, vi } from 'vitest';

import type { Run } from '@autocatalyst/api-contract';
import {
  WorkspaceProvisioningError,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult
} from '@autocatalyst/execution';

import { reconcileStartupWorkspaces, RUN_BRANCH_MISSING_FAILURE_REASON } from './startup-workspace-reconciler.js';

function makeRun(overrides: Partial<Run> & { id: string }): Run {
  return {
    id: overrides.id,
    topicId: 'topic_1',
    owner: { kind: 'user', id: 'user_1', tenant: 'tenant_1' },
    tenant: 'tenant_1',
    workKind: 'feature',
    currentStep: 'implementation.build',
    terminal: false,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...overrides
  } as Run;
}

function makeRequest(runId: string): ProvisionWorkspaceRequest {
  return {
    runId,
    runKind: 'feature',
    topicSlug: 'topic',
    shortRunId: runId.slice(0, 8),
    project: {} as never,
    roots: { reposRoot: '/tmp/repos', workspacesRoot: '/tmp/workspaces' }
  };
}

function twoRootsResult(runId: string, outcome: 'present' | 'materialized'): ProvisionWorkspaceResult {
  return {
    shape: 'two_roots',
    runId,
    outcome,
    workspaceRoot: '/w',
    runRoot: `/w/${runId}`,
    repoRoot: `/w/${runId}/repo`,
    scratchRoot: `/w/${runId}/scratch`,
    hostRepositoryPath: '/repos/acme/widgets',
    branchName: 'feature/topic-x',
    provisionedBaseRef: 'origin/main'
  };
}

describe('reconcileStartupWorkspaces', () => {
  it('leaves present workspaces alone, recreates missing ones, and forces the run_branch base', async () => {
    const present = makeRun({ id: 'run_present' });
    const missing = makeRun({ id: 'run_missing' });
    const provisionWorkspace = vi.fn(async (request: ProvisionWorkspaceRequest) =>
      request.runId === 'run_present' ? twoRootsResult(request.runId, 'present') : twoRootsResult(request.runId, 'materialized')
    );
    const applyDirective = vi.fn();

    const summary = await reconcileStartupWorkspaces({
      listNonTerminalRuns: async () => [present, missing],
      buildProvisionRequest: async (run) => makeRequest(run.id),
      provisionWorkspace,
      orchestrator: { applyDirective }
    });

    expect(summary).toMatchObject({ total: 2, skipped: 0, present: 1, recreated: 1, failedMissingBranch: 0, errored: 0 });
    // Startup never dispatches or advances a run; the only orchestrator seam used is fail,
    // and it is not used when nothing is missing-branch.
    expect(applyDirective).not.toHaveBeenCalled();
    for (const call of provisionWorkspace.mock.calls) {
      expect(call[0].materializationBase).toEqual({ kind: 'run_branch' });
    }
  });

  it('fails a run through the orchestrator with the safe reason when the branch is missing', async () => {
    const run = makeRun({ id: 'run_mb' });
    const provisionWorkspace = vi.fn(async () => {
      throw new WorkspaceProvisioningError('run_branch_missing', 'Run branch does not exist', { runId: 'run_mb' });
    });
    const applyDirective = vi.fn(async () => ({}));

    const summary = await reconcileStartupWorkspaces({
      listNonTerminalRuns: async () => [run],
      buildProvisionRequest: async (r) => makeRequest(r.id),
      provisionWorkspace,
      orchestrator: { applyDirective }
    });

    expect(summary).toMatchObject({ failedMissingBranch: 1, recreated: 0, errored: 0 });
    expect(applyDirective).toHaveBeenCalledTimes(1);
    expect(applyDirective).toHaveBeenCalledWith({
      runId: 'run_mb',
      tenant: 'tenant_1',
      directive: 'fail',
      reason: RUN_BRANCH_MISSING_FAILURE_REASON,
      origin: 'system'
    });
  });

  it('continues after a non-missing-branch provisioning error without failing or advancing the run', async () => {
    const bad = makeRun({ id: 'run_bad' });
    const good = makeRun({ id: 'run_good' });
    const provisionWorkspace = vi.fn(async (request: ProvisionWorkspaceRequest) => {
      if (request.runId === 'run_bad') {
        throw new WorkspaceProvisioningError('worktree_creation_failed', 'boom', { runId: 'run_bad' });
      }
      return twoRootsResult(request.runId, 'materialized');
    });
    const applyDirective = vi.fn();

    const summary = await reconcileStartupWorkspaces({
      listNonTerminalRuns: async () => [bad, good],
      buildProvisionRequest: async (run) => makeRequest(run.id),
      provisionWorkspace,
      orchestrator: { applyDirective }
    });

    expect(summary).toMatchObject({ total: 2, recreated: 1, errored: 1, failedMissingBranch: 0 });
    expect(applyDirective).not.toHaveBeenCalled();
  });

  it('skips runs whose provisioning request cannot be built', async () => {
    const skip = makeRun({ id: 'run_skip', workKind: 'question' });
    const keep = makeRun({ id: 'run_keep' });
    const provisionWorkspace = vi.fn(async (request: ProvisionWorkspaceRequest) =>
      twoRootsResult(request.runId, 'materialized')
    );

    const summary = await reconcileStartupWorkspaces({
      listNonTerminalRuns: async () => [skip, keep],
      buildProvisionRequest: async (run) => (run.id === 'run_skip' ? null : makeRequest(run.id)),
      provisionWorkspace,
      orchestrator: { applyDirective: vi.fn() }
    });

    expect(summary).toMatchObject({ total: 2, skipped: 1, recreated: 1 });
    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
  });

  it('records but survives an orchestrator failure while failing a missing-branch run', async () => {
    const missingBranch = makeRun({ id: 'run_mb' });
    const good = makeRun({ id: 'run_good' });
    const provisionWorkspace = vi.fn(async (request: ProvisionWorkspaceRequest) => {
      if (request.runId === 'run_mb') {
        throw new WorkspaceProvisioningError('run_branch_missing', 'missing', { runId: 'run_mb' });
      }
      return twoRootsResult(request.runId, 'materialized');
    });
    const applyDirective = vi.fn(async (input: { runId: string }) => {
      if (input.runId === 'run_mb') {
        throw new Error('orchestrator unavailable');
      }
      return {};
    });

    const summary = await reconcileStartupWorkspaces({
      listNonTerminalRuns: async () => [missingBranch, good],
      buildProvisionRequest: async (run) => makeRequest(run.id),
      provisionWorkspace,
      orchestrator: { applyDirective }
    });

    expect(summary).toMatchObject({ total: 2, recreated: 1, failedMissingBranch: 0, errored: 1 });
  });
});
