import {
  WorkspaceTeardownError,
  type TeardownWorkspaceRequest,
  type WorkspaceBranchResult,
  type WorkspaceCheckpointResult,
  type WorkspaceTeardownPruneResult,
  type WorkspaceTeardownResult,
  type WorkspaceRunKind,
  type WorkspaceTerminalStep
} from '../workspace.js';
import { isImplementingRunKind } from './workspace-paths.js';
import type { WorkspaceDriver } from './workspace-driver.js';
import type { WorkspacePruner } from './workspace-pruner.js';
import { consoleWorkspaceLogger, type WorkspaceLogger } from './workspace-logger.js';

const terminalSteps = new Set<string>(['done', 'canceled', 'failed']);
const autocatalystCommitIdentity = { name: 'Autocatalyst', email: 'autocatalyst@example.invalid' } as const;

interface RequiredImplementingContext {
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly repoRoot: string;
  readonly hostRepositoryPath: string;
  readonly branchName: string;
}

function assertTerminalStep(step: string): asserts step is WorkspaceTerminalStep {
  if (!terminalSteps.has(step)) {
    throw new WorkspaceTeardownError('invalid_terminal_step', `Invalid terminal teardown step: ${step}`, {
      terminalStep: step
    });
  }
}

function requireImplementingContext(request: TeardownWorkspaceRequest): RequiredImplementingContext {
  const { workspaceRoot, runRoot, repoRoot, hostRepositoryPath, branchName } = request;
  if (!workspaceRoot || !runRoot || !repoRoot || !hostRepositoryPath || !branchName) {
    throw new WorkspaceTeardownError('missing_workspace_context', 'Implementing teardown requires workspace, repository, and branch context', {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      action: 'validate'
    });
  }
  return { workspaceRoot, runRoot, repoRoot, hostRepositoryPath, branchName };
}

function requireScratchContext(request: TeardownWorkspaceRequest): { workspaceRoot: string; runRoot: string } {
  if (!request.workspaceRoot || !request.runRoot) {
    throw new WorkspaceTeardownError('missing_workspace_context', 'Scratch-only teardown requires workspaceRoot and runRoot', {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      action: 'validate'
    });
  }
  return { workspaceRoot: request.workspaceRoot, runRoot: request.runRoot };
}

function checkpointPrefix(kind: WorkspaceRunKind): 'feat' | 'fix' | 'chore' {
  if (kind === 'feature' || kind === 'enhancement') return 'feat';
  if (kind === 'bug') return 'fix';
  return 'chore';
}

function normalizeCheckpointSubject(subject: string | undefined): string {
  if (subject === undefined) return 'final checkpoint';
  if (/[\r\n]/.test(subject) || /\b(?:feat|fix|chore):/iu.test(subject)) {
    throw new WorkspaceTeardownError('invalid_checkpoint_subject', 'Checkpoint subject must not include line breaks or a conventional prefix');
  }
  const normalized = subject.trim().replace(/[\t ]+/g, ' ').replace(/\.+$/g, '').toLowerCase();
  return normalized.length > 0 ? normalized : 'final checkpoint';
}

function buildCheckpointMessage(request: TeardownWorkspaceRequest): string {
  return `${checkpointPrefix(request.runKind)}: ${normalizeCheckpointSubject(request.checkpointSubject)}`;
}

function finishTeardown(logger: WorkspaceLogger, result: WorkspaceTeardownResult): WorkspaceTeardownResult {
  logger.emit(result.outcome === 'failed' || result.outcome === 'partial_failure' ? 'warn' : 'info', {
    component: 'workspace-lifecycle',
    event: result.outcome === 'partial_failure' ? 'workspace.teardown.partial_failure' : 'workspace.teardown.completed',
    runId: result.runId,
    runKind: result.runKind,
    terminalStep: result.terminalStep,
    outcome: result.outcome,
    branchAction: result.branch?.action,
    checkpointAction: result.checkpoint?.action,
    pruneStatuses: result.prunes.map((prune) => ({ purpose: prune.purpose, status: prune.status, errorCode: prune.errorCode }))
  });
  return result;
}

async function teardownDone(input: {
  readonly request: TeardownWorkspaceRequest;
  readonly context: RequiredImplementingContext;
  readonly driver: WorkspaceDriver;
  readonly pruner: WorkspacePruner;
  readonly logger: WorkspaceLogger;
}): Promise<WorkspaceTeardownResult> {
  const { request, context, driver, pruner, logger } = input;
  const prunes: WorkspaceTeardownPruneResult[] = [];

  const worktreePrune = await pruner.pruneWorkspacePath({
    runId: request.runId,
    mode: 'worktree',
    workspaceRoot: context.workspaceRoot,
    targetPath: context.repoRoot,
    hostRepositoryPath: context.hostRepositoryPath
  });
  prunes.push({ ...worktreePrune, purpose: 'worktree' });

  if (worktreePrune.status === 'failed' || worktreePrune.status === 'rejected') {
    return finishTeardown(logger, {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      outcome: 'failed',
      prunes,
      branch: { name: context.branchName, action: 'retained' },
      checkpoint: { action: 'not_applicable' }
    });
  }

  const runRootPrune = await pruner.pruneWorkspacePath({
    runId: request.runId,
    mode: 'directory',
    workspaceRoot: context.workspaceRoot,
    targetPath: context.runRoot
  });
  prunes.push({ ...runRootPrune, purpose: 'run_directory' });

  let branchAction: WorkspaceBranchResult = { name: context.branchName, action: 'deleted' };
  try {
    await driver.deleteBranch({ hostRepositoryPath: context.hostRepositoryPath, branchName: context.branchName });
  } catch {
    branchAction = { name: context.branchName, action: 'failed', errorCode: 'branch_delete_failed' };
  }

  const pruneFailed = prunes.some((p) => p.status === 'failed' || p.status === 'rejected');
  const outcome = branchAction.action === 'failed' || pruneFailed ? 'partial_failure' : 'completed';
  return finishTeardown(logger, {
    runId: request.runId,
    runKind: request.runKind,
    terminalStep: request.terminalStep,
    outcome,
    prunes,
    branch: branchAction,
    checkpoint: { action: 'not_applicable' }
  });
}

async function teardownCanceled(input: {
  readonly request: TeardownWorkspaceRequest;
  readonly context: RequiredImplementingContext;
  readonly driver: WorkspaceDriver;
  readonly pruner: WorkspacePruner;
  readonly logger: WorkspaceLogger;
}): Promise<WorkspaceTeardownResult> {
  const { request, context, driver, pruner, logger } = input;

  // Validate checkpoint subject BEFORE any git operations — throws WorkspaceTeardownError with invalid_checkpoint_subject
  const message = buildCheckpointMessage(request);

  const actualBranch = await driver.currentBranch(context.repoRoot);

  if (actualBranch === null) {
    let repoStat: Awaited<ReturnType<typeof driver.statPath>>;
    try {
      repoStat = await driver.statPath(context.repoRoot);
    } catch {
      repoStat = 'directory';
    }

    if (repoStat !== 'missing') {
      return finishTeardown(logger, {
        runId: request.runId,
        runKind: request.runKind,
        terminalStep: request.terminalStep,
        outcome: 'failed',
        prunes: [],
        branch: { name: context.branchName, action: 'retained' },
        checkpoint: { action: 'failed', errorCode: 'worktree_branch_mismatch' }
      });
    }

    const missingPrune = await pruner.pruneWorkspacePath({
      runId: request.runId,
      mode: 'worktree',
      workspaceRoot: context.workspaceRoot,
      targetPath: context.repoRoot,
      hostRepositoryPath: context.hostRepositoryPath
    });
    return finishTeardown(logger, {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      outcome: missingPrune.status === 'failed' || missingPrune.status === 'rejected' ? 'failed' : 'retained',
      prunes: [{ ...missingPrune, purpose: 'worktree' }],
      branch: { name: context.branchName, action: 'retained' },
      checkpoint: { action: 'not_applicable' }
    });
  }

  if (actualBranch !== context.branchName) {
    return finishTeardown(logger, {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      outcome: 'failed',
      prunes: [],
      branch: { name: context.branchName, action: 'retained' },
      checkpoint: { action: 'failed', errorCode: 'worktree_branch_mismatch' }
    });
  }

  let checkpoint: WorkspaceCheckpointResult = { action: 'no_changes' };
  try {
    if (await driver.hasUncommittedChanges(context.repoRoot)) {
      await driver.stageAll(context.repoRoot);
      const commitSha = await driver.commit({
        repoRoot: context.repoRoot,
        message,
        identity: autocatalystCommitIdentity
      });
      checkpoint = { action: 'committed', commitSha, message };
    }
  } catch {
    return finishTeardown(logger, {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      outcome: 'failed',
      prunes: [],
      branch: { name: context.branchName, action: 'retained' },
      checkpoint: { action: 'failed', errorCode: 'checkpoint_commit_failed' }
    });
  }

  const prunes: WorkspaceTeardownPruneResult[] = [];
  const worktreePrune = await pruner.pruneWorkspacePath({
    runId: request.runId,
    mode: 'worktree',
    workspaceRoot: context.workspaceRoot,
    targetPath: context.repoRoot,
    hostRepositoryPath: context.hostRepositoryPath
  });
  prunes.push({ ...worktreePrune, purpose: 'worktree' });

  if (worktreePrune.status === 'failed' || worktreePrune.status === 'rejected') {
    return finishTeardown(logger, {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      outcome: 'failed',
      prunes,
      branch: { name: context.branchName, action: 'retained' },
      checkpoint
    });
  }

  const runRootPrune = await pruner.pruneWorkspacePath({
    runId: request.runId,
    mode: 'directory',
    workspaceRoot: context.workspaceRoot,
    targetPath: context.runRoot
  });
  prunes.push({ ...runRootPrune, purpose: 'run_directory' });

  const pruneFailed = prunes.some((p) => p.status === 'failed' || p.status === 'rejected');
  return finishTeardown(logger, {
    runId: request.runId,
    runKind: request.runKind,
    terminalStep: request.terminalStep,
    outcome: pruneFailed ? 'partial_failure' : 'completed',
    prunes,
    branch: { name: context.branchName, action: 'retained' },
    checkpoint
  });
}

async function teardownScratchOnly(input: {
  readonly request: TeardownWorkspaceRequest;
  readonly context: { readonly workspaceRoot: string; readonly runRoot: string };
  readonly pruner: WorkspacePruner;
  readonly logger: WorkspaceLogger;
}): Promise<WorkspaceTeardownResult> {
  const prune = await input.pruner.pruneWorkspacePath({
    runId: input.request.runId,
    mode: 'directory',
    workspaceRoot: input.context.workspaceRoot,
    targetPath: input.context.runRoot
  });
  const outcome = prune.status === 'deleted' || prune.status === 'missing' ? 'completed' : 'failed';
  return finishTeardown(input.logger, {
    runId: input.request.runId,
    runKind: input.request.runKind,
    terminalStep: input.request.terminalStep,
    outcome,
    prunes: [{ ...prune, purpose: 'run_directory' }],
    branch: { action: 'not_applicable' },
    checkpoint: { action: 'not_applicable' }
  });
}

export interface WorkspaceTeardownDependencies {
  readonly driver: WorkspaceDriver;
  readonly pruner: WorkspacePruner;
  readonly logger?: WorkspaceLogger;
}

export interface WorkspaceTeardown {
  teardownWorkspace(request: TeardownWorkspaceRequest): Promise<WorkspaceTeardownResult>;
}

export function createWorkspaceTeardown(dependencies: WorkspaceTeardownDependencies): WorkspaceTeardown {
  const { driver, pruner } = dependencies;
  const logger = dependencies.logger ?? consoleWorkspaceLogger;

  return {
    async teardownWorkspace(request) {
      assertTerminalStep(request.terminalStep);
      logger.emit('info', {
        component: 'workspace-lifecycle',
        event: 'workspace.teardown.started',
        runId: request.runId,
        runKind: request.runKind,
        terminalStep: request.terminalStep
      });

      if (isImplementingRunKind(request.runKind)) {
        const context = requireImplementingContext(request);
        if (request.terminalStep === 'done') {
          return teardownDone({ request, context, driver, pruner, logger });
        }
        if (request.terminalStep === 'canceled') {
          return teardownCanceled({ request, context, driver, pruner, logger });
        }
        // failed
        return finishTeardown(logger, {
          runId: request.runId,
          runKind: request.runKind,
          terminalStep: request.terminalStep,
          outcome: 'retained',
          prunes: [],
          branch: { name: context.branchName, action: 'retained' },
          checkpoint: { action: 'not_applicable' }
        });
      }

      if (request.runKind === 'file_issue') {
        const context = requireScratchContext(request);
        return teardownScratchOnly({ request, context, pruner, logger });
      }

      if (request.runKind === 'question') {
        return finishTeardown(logger, {
          runId: request.runId,
          runKind: request.runKind,
          terminalStep: request.terminalStep,
          outcome: 'skipped',
          prunes: []
        });
      }

      throw new WorkspaceTeardownError('unsupported_run_kind', `Unsupported run kind: ${request.runKind}`, {
        runId: request.runId,
        runKind: request.runKind,
        terminalStep: request.terminalStep,
        action: 'validate'
      });
    }
  };
}
