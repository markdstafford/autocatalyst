import type { JsonValue, PullRequest, Run, RunStep } from '@autocatalyst/api-contract';
import type { ConvergenceEngineResult } from './convergence-engine.js';
import { buildConvergenceEscalationPause } from './convergence-checkpoint.js';
import { buildPullRequestFinalizeCheckpoint, type PublicationReviewSnapshot } from './pr-finalize.js';
import { validatePullRequestFinalizeResult } from './pr-finalize-result-validation.js';
import type { OrchestratedRunResult, RunWorkResult } from './orchestrator.js';
import { exactRepairBinding, findCurrentRepair, type RepairDecision, type RepairMove, type RepairRepository } from './pr-ci-repair.js';
import type { PullRequestReadOutcome } from './pr-lifecycle.js';
import { safePublicationText, publicationRefreshLimit, type PublicationGitPort, type PublicationWorkspace } from './pr-publication.js';
import type { RunWorkspaceGitPort } from './run-workspace-git.js';

export interface RepairWorkerDependencies {
  readonly repository: RepairRepository;
  readonly epoch: string;
  readonly git: PublicationGitPort;
  readonly diff: Pick<RunWorkspaceGitPort, 'getChangedFiles'>;
  readonly clock: () => string;
  readonly pullRequest: (run: Run) => Promise<PullRequest | null>;
  readonly workspace: (run: Run) => Promise<PublicationWorkspace>;
  readonly observe: (run: Run, pr: PullRequest, ci: boolean) => Promise<PullRequestReadOutcome>;
  readonly transition: (input: RepairMove) => ReturnType<RepairRepository['move']>;
  readonly build: (run: Run, step: RunStep, repair: RepairDecision, stillOwns: () => Promise<boolean>,
    binding: NonNullable<import('./reviewed-role-dispatcher.js').RepairTurnEvidence['prBinding']>) => Promise<ConvergenceEngineResult>;
  readonly review: (run: Run, snapshot: PublicationReviewSnapshot) => Promise<RunWorkResult>;
  readonly onWorkspaceDrained?: (run: Run) => Promise<void>;
}

export function repairTerminalMove(attempt: RepairDecision, state: 'merged' | 'closed', now: string): RepairMove {
  return {
    from: attempt, state: 'superseded', now, prTerminal: state,
    nextStep: state === 'merged' ? 'done' : 'failed', stopCode: state === 'merged' ? 'repair_pr_merged' : 'repair_pr_closed',
    ...(attempt.state === 'running' || attempt.state === 'publishing' ? { hold: true } : {})
  };
}

function inspect(observation: PullRequestReadOutcome, pr: PullRequest, attempt: RepairDecision, expectedHead: string) {
  if (observation.kind !== 'observed') return { kind: 'unknown' } as const;
  const { facts, repository } = observation;
  if (!exactRepairBinding(facts, pr, repository)) return { kind: 'changed' } as const;
  if (facts.state !== 'open') return { kind: 'terminal', state: facts.state } as const;
  if (facts.headSha === undefined || facts.baseBranch === undefined || facts.headRepository === undefined) return { kind: 'unknown' } as const;
  if (facts.headSha !== expectedHead || facts.baseBranch !== attempt.baseRef || facts.branch !== pr.branch ||
      facts.headRepository.toLowerCase() !== repository.toLowerCase()) return { kind: 'changed' } as const;
  return { kind: 'open', failures: observation.failures, requiredPending: observation.requiredPending, repository } as const;
}

export async function recoverRepairAttempt(run: Run, attempt: RepairDecision, deps: RepairWorkerDependencies): Promise<void> {
  if (attempt.state !== 'running' && attempt.state !== 'publishing') return;
  const pr = await deps.pullRequest(run);
  const observation = pr === null ? null : await deps.observe(run, pr, false).catch(() => null);
  const expected = attempt.publishHeadSha ?? attempt.headSha;
  const match = observation !== null && pr !== null ? inspect(observation, pr, attempt, expected) : { kind: 'unknown' } as const;
  if (match.kind === 'terminal') {
    await deps.transition(repairTerminalMove(attempt, match.state, deps.clock()));
    return;
  }
  if (attempt.state === 'publishing' && match.kind === 'open' && pr !== null &&
      attempt.pushReceipt?.headSha === expected && attempt.pushReceipt.branch === pr.branch &&
      attempt.pushReceipt.repository === match.repository && attempt.pushReceipt.runId === run.id) {
    await deps.transition({ from: attempt, state: 'pushed', now: deps.clock(), nextStep: 'pr.human_review' });
    return;
  }
  const prior = observation !== null && pr !== null ? inspect(observation, pr, attempt, attempt.headSha) : { kind: 'unknown' } as const;
  const stopCode = attempt.state === 'running' ? 'repair_interrupted' :
    match.kind === 'changed' && prior.kind !== 'open' ? 'repair_remote_changed' : 'repair_push_unverified';
  await deps.transition({ from: attempt, state: 'stopped', now: deps.clock(), nextStep: 'pr.human_review', stopCode, hold: true });
}

export async function executeRepair(
  start: OrchestratedRunResult, attempt: RepairDecision, deps: RepairWorkerDependencies
): Promise<OrchestratedRunResult> {
  let active = attempt;
  let result = start;
  let owned = false;
  const move = async (input: Omit<RepairMove, 'from' | 'now'>) => {
    const moved = await deps.transition({ ...input, from: active, now: deps.clock() });
    if (moved === null) return false;
    active = moved.decision;
    if (moved.transition !== undefined) result = moved.transition;
    return true;
  };
  const stop = async (stopCode: string, checkpoint?: JsonValue, hold = false) => {
    await move({ state: 'stopped', nextStep: 'pr.human_review', stopCode,
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      ...(hold ? { hold: true } : {}) });
    return result;
  };
  const stillOwns = async () => {
    const current = findCurrentRepair(await deps.repository.listByRun(result.run.id, result.run.tenant));
    return current?.ownerEpoch === deps.epoch && current.state === active.state && current.currentStepId === active.currentStepId;
  };
  const pr = await deps.pullRequest(result.run);
  if (pr === null || pr.id !== attempt.pullRequestId || pr.state !== 'open') return result;
  const observe = async (ci: boolean, head = attempt.headSha) =>
    inspect(await deps.observe(result.run, pr, ci), pr, attempt, head);
  const terminal = async (state: 'merged' | 'closed') => {
    const { from: _from, now: _now, ...next } = repairTerminalMove(active, state, deps.clock());
    const previous = active;
    const didMove = await move(next);
    if (didMove && owned) {
      await deps.repository.clearDrainedHold(previous);
      await deps.onWorkspaceDrained?.(result.run);
    }
    return result;
  };
  const initial = await observe(true);
  if (initial.kind === 'terminal') return terminal(initial.state);
  if (initial.kind === 'changed') return stop('repair_remote_changed');
  if (initial.kind === 'unknown' || initial.failures === null) return result;
  if (initial.failures.length === 0) return stop('repair_failure_cleared', { requiredPending: initial.requiredPending });
  if (!await move({ state: 'running', ownerEpoch: deps.epoch })) return result;
  owned = true;

  try {
    const workspace = { ...await deps.workspace(result.run), base: attempt.baseRef };
    if (workspace.repository.toLowerCase() !== initial.repository.toLowerCase() || workspace.branch !== pr.branch) return await stop('repair_remote_changed');
    const expectedCandidate = active.candidateSha ?? attempt.headSha;
    if (await deps.git.readCandidate(workspace) !== expectedCandidate) return await stop('repair_workspace_not_ready');
    if (!await stillOwns()) return result;
    const build = await deps.build(result.run, result.runStep, { ...active, failures: initial.failures }, stillOwns, {
      repository: workspace.repository.toLowerCase(), id: pr.id, number: pr.number, branch: workspace.branch
    });
    if (!await stillOwns()) return result;
    const built = await deps.git.readCandidate(workspace);
    if (built === null) return await stop('repair_workspace_not_ready');
    const authoredFiles = await deps.diff.getChangedFiles({
      workspaceRepoRoot: workspace.workspaceRepoRoot, baseRef: attempt.headSha, headRef: built
    });
    if (authoredFiles.some(file => [file.path, file.previousPath].some(path => path === 'context-human' || path?.startsWith('context-human/')))) {
      return await stop('repair_human_docs_changed');
    }
    if (build.workResult.directive === 'fail') return await stop('repair_implementation_failed');
    if (build.workResult.directive === 'needs_input') {
      const pause = buildConvergenceEscalationPause(build.checkpointResult) ?? {
        pause: {
          kind: 'convergence_escalation', producingStep: 'implementation.build',
          question: safePublicationText(build.workResult.question ?? '') ?? 'What guidance should the repair implementer follow?'
        }
      };
      await move({ state: 'awaiting_human', nextStep: 'implementation.awaiting_input',
        checkpoint: build.checkpointResult as unknown as JsonValue, initialCheckpoint: pause, candidateSha: built });
      return result;
    }
    if (!await move({ state: 'running', nextStep: 'pr.finalize', checkpoint: build.checkpointResult as unknown as JsonValue })) return result;

    for (;;) {
      if (!await stillOwns()) return result;
      const integration = await deps.git.integrate(workspace);
      if (integration.kind === 'target_unverified') return await stop('repair_target_verification_failed');
      if (integration.kind === 'workspace_unavailable') return await stop('repair_workspace_not_ready');
      if (integration.kind === 'conflict') {
        return await stop('repair_integration_conflict', {
          paths: [...integration.paths], cleanup: integration.cleanup, sourceSha: integration.sourceSha, targetSha: integration.targetSha
        });
      }
      if (await deps.git.sameTree(workspace, attempt.headSha, integration.headSha)) return await stop('repair_no_change');
      const treeSha = await deps.git.readTree?.(workspace, integration.headSha);
      if (treeSha === null || !await stillOwns()) return await stop('repair_workspace_not_ready');
      const review = await deps.review(result.run, {
        occurrenceId: result.runStep.id, candidateSha: integration.headSha, targetSha: integration.targetSha,
        ...(treeSha ? { treeSha } : {})
      });
      if (!await stillOwns()) return result;
      if (review.directive === 'needs_input') return await stop('repair_final_review_blocked');
      if (review.directive !== 'advance') return await stop('repair_final_review_failed');
      const parsed = await validatePullRequestFinalizeResult({ runId: result.run.id, rawResult: review.result });
      if (parsed.status !== 'valid') return await stop('repair_final_review_failed');
      if (parsed.value.directive === 'revise' || parsed.value.findings.some(finding => finding.severity === 'blocker')) {
        return await stop('repair_final_review_blocked', { findings: parsed.value.findings.slice(0, 20).map(finding => ({
          severity: finding.severity,
          // Reviewer text is untrusted and may contain host paths or credentials.
          summary: safePublicationText(finding.summary) ?? 'Final review reported a blocking or advisory finding.'
        })) });
      }
      const remote = await observe(false);
      if (remote.kind === 'terminal') return await terminal(remote.state);
      if (remote.kind !== 'open') return await stop(remote.kind === 'changed' ? 'repair_remote_changed' : 'repair_remote_unverified');
      const target = await deps.git.readTarget(workspace);
      if (target === null) return await stop('repair_target_verification_failed');
      const candidate = await deps.git.readCandidate(workspace);
      if (target !== integration.targetSha || candidate !== integration.headSha) {
        if (active.refreshCount >= publicationRefreshLimit) return await stop('repair_publication_refresh_exhausted');
        if (!await move({ state: 'running', nextStep: 'pr.finalize', incrementRefresh: true, checkpoint: {
          kind: 'repair_publication_refreshed', targetSha: integration.targetSha, observedTargetSha: target,
          reason: target !== integration.targetSha ? 'target_changed' : 'candidate_changed'
        } })) return result;
        continue;
      }

      const head = integration.headSha;
      const attestedCheckpoint = {
        ...buildPullRequestFinalizeCheckpoint({
          directive: 'advance', findings: parsed.value.findings.slice(0, 20).flatMap(finding => {
            const summary = safePublicationText(finding.summary);
            return summary === null ? [] : [{ severity: finding.severity, summary }];
          })
        }, { clock: deps.clock }) as Record<string, JsonValue>,
        attestation: { repository: workspace.repository, branch: workspace.branch, base: workspace.base,
          targetSha: target, reviewedSha: head, publishSha: head,
          ...(treeSha ? { reviewedTree: treeSha, reviewOccurrenceId: result.runStep.id } : {}) }
      };
      if (!await move({ state: 'publishing', publishHeadSha: head, checkpoint: attestedCheckpoint }) ||
          !await stillOwns()) return result;
      const pushed = await deps.git.pushCandidate(workspace, head, attempt.headSha, stillOwns);
      const verified = await observe(false, head);
      if (verified.kind === 'terminal') return await terminal(verified.state);
      if (!await stillOwns()) return result;
      if (pushed !== 'pushed' || verified.kind !== 'open') {
        const unchanged = await observe(false);
        if (unchanged.kind === 'terminal') return await terminal(unchanged.state);
        if (unchanged.kind === 'changed' && verified.kind === 'changed') return await stop('repair_remote_changed');
        return await stop('repair_push_unverified', undefined, pushed === 'unverified');
      }
      if (!await move({ state: 'publishing', pushReceipt: {
        kind: 'publication_push_receipt', runId: result.run.id, repository: workspace.repository, branch: pr.branch, headSha: head
      } })) return result;
      await move({ state: 'pushed', nextStep: 'pr.human_review' });
      return result;
    }
  } catch {
    if (await stillOwns()) {
      const publishing = active.state === 'publishing';
      return await stop(publishing ? 'repair_push_unverified' : 'repair_execution_failed', undefined, publishing);
    }
    return result;
  } finally {
    if (owned) {
      const rows = await deps.repository.listByRun(active.runId, active.tenant);
      if (rows.some(row => row.workspaceHold && row.outcomeStepId === active.currentStepId && row.ownerEpoch === deps.epoch)) {
        await deps.repository.clearDrainedHold(active);
        await deps.onWorkspaceDrained?.(result.run);
      }
    }
  }
}
