import {
  WorkspaceProvisioningError,
  summarizeWorkspaceCause,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult,
  type WorkspaceProvisioningOutcome
} from '../workspace.js';
import type { WorkspaceDriver } from './workspace-driver.js';
import type { WorkspacePruner } from './workspace-pruner.js';
import { deriveRunBranchName, resolveWorkspacePaths, selectWorkspaceProvisioningShape, type ResolvedWorkspacePaths } from './workspace-paths.js';

export interface WorkspaceProvisionerDependencies {
  readonly driver: WorkspaceDriver;
  readonly pruner: WorkspacePruner;
}

export interface WorkspaceProvisioner {
  provisionWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionWorkspaceResult>;
}

function remoteUrlForRequest(request: ProvisionWorkspaceRequest): string {
  const remoteUrl = request.project.hostRepository.url ?? request.project.repoUrl;
  if (!remoteUrl) {
    throw new WorkspaceProvisioningError('invalid_project_repository', 'Project repository URL is required', {
      runId: request.runId
    });
  }
  return remoteUrl;
}

/**
 * The base ref recorded on a result when provisioning did not freshly fetch the default
 * branch (idempotent/present and run-branch materialization). Mirrors the request's
 * declared default branch so callers see a stable `origin/<default>` ref.
 */
function declaredBaseRef(request: ProvisionWorkspaceRequest): string {
  return request.defaultBranch !== undefined ? `origin/${request.defaultBranch}` : 'origin/main';
}

async function runRootExists(driver: WorkspaceDriver, runRoot: string): Promise<boolean> {
  return driver.pathExists(runRoot);
}

async function rollbackRunRoot(input: {
  readonly driver: WorkspaceDriver;
  readonly pruner: WorkspacePruner;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly hostRepositoryPath: string;
  readonly repoRoot: string;
  readonly worktreeCreated: boolean;
  readonly originalError: unknown;
}): Promise<never> {
  let rollbackCause: unknown;

  if (input.worktreeCreated) {
    const result = await input.pruner.pruneWorkspacePath({
      runId: input.runId,
      mode: 'worktree',
      workspaceRoot: input.workspaceRoot,
      targetPath: input.repoRoot,
      hostRepositoryPath: input.hostRepositoryPath
    });
    if (result.status === 'failed' || result.status === 'rejected') {
      rollbackCause = new WorkspaceProvisioningError('rollback_failed', 'Worktree rollback prune failed', {
        targetPath: input.repoRoot,
        cause: summarizeWorkspaceCause(result.errorCode ?? result.status)
      });
    }
  }

  // Only attempt directory removal if the run root was actually created. If it
  // was never created (e.g. mkdirp failed a containment check), there is nothing
  // to remove and calling removeDirectory would just produce a second error.
  const runRootStillExists = await input.driver.pathExists(input.runRoot);
  if (runRootStillExists) {
    const result = await input.pruner.pruneWorkspacePath({
      runId: input.runId,
      mode: 'directory',
      workspaceRoot: input.workspaceRoot,
      targetPath: input.runRoot
    });
    if (result.status === 'failed' || result.status === 'rejected') {
      rollbackCause ??= new WorkspaceProvisioningError('rollback_failed', 'Run root rollback prune failed', {
        targetPath: input.runRoot,
        cause: summarizeWorkspaceCause(result.errorCode ?? result.status)
      });
    }
  }

  if (rollbackCause !== undefined) {
    throw new WorkspaceProvisioningError('rollback_failed', 'Workspace provisioning failed and rollback also failed', {
      targetPath: input.runRoot,
      cause: summarizeWorkspaceCause(input.originalError),
      rollbackCause: summarizeWorkspaceCause(rollbackCause)
    });
  }

  throw input.originalError;
}

/**
 * Remove ONLY this run's own derived state before a start-over rebuild: the run's
 * git worktree, its canonical run root directory, and its derived branch. Every
 * removal is constrained by the pruner's containment checks and the derived branch
 * name, so no shared default branch, unrelated branch, or other run directory can
 * be touched.
 */
async function removeRunDerivedState(input: {
  readonly driver: WorkspaceDriver;
  readonly pruner: WorkspacePruner;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly repoRoot: string;
  readonly hostRepositoryPath: string;
  readonly branchName: string;
}): Promise<void> {
  if (await input.driver.pathExists(input.repoRoot)) {
    const result = await input.pruner.pruneWorkspacePath({
      runId: input.runId,
      mode: 'worktree',
      workspaceRoot: input.workspaceRoot,
      targetPath: input.repoRoot,
      hostRepositoryPath: input.hostRepositoryPath
    });
    if (result.status === 'failed' || result.status === 'rejected') {
      throw new WorkspaceProvisioningError('rollback_failed', 'Failed to remove existing run worktree before default-branch rebuild', {
        runId: input.runId,
        targetPath: input.repoRoot,
        cause: summarizeWorkspaceCause(result.errorCode ?? result.status)
      });
    }
  }

  // Clear any stale worktree administration state (e.g. after a manual directory delete)
  // so the derived branch can be removed and re-created without a "branch already checked
  // out" conflict. Best-effort: a prune failure here must not block the rebuild.
  try {
    await input.driver.pruneWorktreeAdminState({ hostRepositoryPath: input.hostRepositoryPath });
  } catch {
    // Intentionally ignored; the subsequent operations surface any real failure.
  }

  if (await input.driver.pathExists(input.runRoot)) {
    const result = await input.pruner.pruneWorkspacePath({
      runId: input.runId,
      mode: 'directory',
      workspaceRoot: input.workspaceRoot,
      targetPath: input.runRoot
    });
    if (result.status === 'failed' || result.status === 'rejected') {
      throw new WorkspaceProvisioningError('rollback_failed', 'Failed to remove existing run root before default-branch rebuild', {
        runId: input.runId,
        targetPath: input.runRoot,
        cause: summarizeWorkspaceCause(result.errorCode ?? result.status)
      });
    }
  }

  // Remove only this run's own derived branch, and only if it exists.
  if (await input.driver.branchExists({ hostRepositoryPath: input.hostRepositoryPath, branchName: input.branchName })) {
    await input.driver.deleteBranch({ hostRepositoryPath: input.hostRepositoryPath, branchName: input.branchName });
  }
}

async function verifyBranch(input: {
  readonly driver: WorkspaceDriver;
  readonly repoRoot: string;
  readonly expectedBranch: string;
}): Promise<void> {
  const actualBranch = await input.driver.currentBranch(input.repoRoot);
  if (actualBranch !== input.expectedBranch) {
    throw new WorkspaceProvisioningError('branch_guard_failed', 'Worktree is not on the expected branch', {
      targetPath: input.repoRoot,
      expectedBranch: input.expectedBranch,
      actualBranch
    });
  }
}

function twoRootsResult(
  request: ProvisionWorkspaceRequest,
  paths: ResolvedWorkspacePaths,
  branchName: string,
  provisionedBaseRef: string,
  outcome: WorkspaceProvisioningOutcome
): ProvisionWorkspaceResult {
  return {
    shape: 'two_roots',
    runId: request.runId,
    outcome,
    workspaceRoot: paths.workspaceRoot,
    runRoot: paths.runRoot,
    repoRoot: paths.repoRoot,
    scratchRoot: paths.scratchRoot,
    hostRepositoryPath: paths.hostRepositoryPath,
    branchName,
    provisionedBaseRef
  };
}

export function createWorkspaceProvisioner(dependencies: WorkspaceProvisionerDependencies): WorkspaceProvisioner {
  const { driver, pruner } = dependencies;

  /** Materialize a two-root workspace by checking out the already-existing run branch. */
  async function materializeFromRunBranch(
    request: ProvisionWorkspaceRequest,
    paths: ResolvedWorkspacePaths,
    branchName: string
  ): Promise<ProvisionWorkspaceResult> {
    // Ensure the host repository exists so we can inspect the branch. If the host
    // repository had to be freshly cloned, the local-only run branch will not be
    // present, and the branch-existence check below fails safely.
    await driver.ensureHostRepository({
      reposRoot: paths.reposRoot,
      hostRepositoryPath: paths.hostRepositoryPath,
      remoteUrl: remoteUrlForRequest(request)
    });

    const branchPresent = await driver.branchExists({ hostRepositoryPath: paths.hostRepositoryPath, branchName });
    if (!branchPresent) {
      // Create nothing: no run root, no worktree, no scratch directory.
      throw new WorkspaceProvisioningError('run_branch_missing', 'Run branch does not exist in host repository', {
        runId: request.runId,
        shape: 'two_roots',
        expectedBranch: branchName
      });
    }

    // Clear stale worktree administration state left behind by a manually-deleted
    // workspace so `git worktree add <existing-branch>` does not fail with a
    // "branch already checked out" conflict. Best-effort before we create anything.
    try {
      await driver.pruneWorktreeAdminState({ hostRepositoryPath: paths.hostRepositoryPath });
    } catch {
      // Intentionally ignored; addExistingBranchWorktree surfaces any real failure.
    }

    let worktreeCreated = false;
    try {
      await driver.mkdirp({ workspaceRoot: paths.workspaceRoot, targetPath: paths.runRoot });
      await driver.addExistingBranchWorktree({
        workspaceRoot: paths.workspaceRoot,
        hostRepositoryPath: paths.hostRepositoryPath,
        repoRoot: paths.repoRoot,
        branchName
      });
      worktreeCreated = true;
      // Fresh, empty scratch root — old scratch contents are intentionally not restored.
      await driver.mkdirp({ workspaceRoot: paths.workspaceRoot, targetPath: paths.scratchRoot });
      await verifyBranch({ driver, repoRoot: paths.repoRoot, expectedBranch: branchName });
    } catch (cause) {
      await rollbackRunRoot({
        driver,
        pruner,
        runId: request.runId,
        workspaceRoot: paths.workspaceRoot,
        runRoot: paths.runRoot,
        hostRepositoryPath: paths.hostRepositoryPath,
        repoRoot: paths.repoRoot,
        worktreeCreated,
        originalError: cause
      });
    }

    return twoRootsResult(request, paths, branchName, declaredBaseRef(request), 'materialized');
  }

  /**
   * Materialize a two-root workspace from the freshly fetched default branch. When
   * `removeExisting` is true (explicit start-over), this run's own derived branch and
   * run root are removed first so no prior run commits are carried forward.
   */
  async function materializeFromDefaultBranch(
    request: ProvisionWorkspaceRequest,
    paths: ResolvedWorkspacePaths,
    branchName: string,
    options: { readonly removeExisting: boolean }
  ): Promise<ProvisionWorkspaceResult> {
    await driver.ensureHostRepository({
      reposRoot: paths.reposRoot,
      hostRepositoryPath: paths.hostRepositoryPath,
      remoteUrl: remoteUrlForRequest(request)
    });
    await driver.fetchHostRepository({ reposRoot: paths.reposRoot, hostRepositoryPath: paths.hostRepositoryPath });
    const baseRef = await driver.resolveDefaultBranch({
      hostRepositoryPath: paths.hostRepositoryPath,
      ...(request.defaultBranch !== undefined && { defaultBranch: request.defaultBranch })
    });

    if (options.removeExisting) {
      await removeRunDerivedState({
        driver,
        pruner,
        runId: request.runId,
        workspaceRoot: paths.workspaceRoot,
        runRoot: paths.runRoot,
        repoRoot: paths.repoRoot,
        hostRepositoryPath: paths.hostRepositoryPath,
        branchName
      });
    }

    let worktreeCreated = false;
    try {
      await driver.mkdirp({ workspaceRoot: paths.workspaceRoot, targetPath: paths.runRoot });
      await driver.addWorktree({
        workspaceRoot: paths.workspaceRoot,
        hostRepositoryPath: paths.hostRepositoryPath,
        repoRoot: paths.repoRoot,
        branchName,
        baseRef
      });
      worktreeCreated = true;
      await driver.mkdirp({ workspaceRoot: paths.workspaceRoot, targetPath: paths.scratchRoot });
      await verifyBranch({ driver, repoRoot: paths.repoRoot, expectedBranch: branchName });
    } catch (cause) {
      await rollbackRunRoot({
        driver,
        pruner,
        runId: request.runId,
        workspaceRoot: paths.workspaceRoot,
        runRoot: paths.runRoot,
        hostRepositoryPath: paths.hostRepositoryPath,
        repoRoot: paths.repoRoot,
        worktreeCreated,
        originalError: cause
      });
    }

    // Default-branch rebuild updates the stored base to the newly fetched default.
    return twoRootsResult(request, paths, branchName, baseRef, 'materialized');
  }

  return {
    async provisionWorkspace(request) {
      const shape = selectWorkspaceProvisioningShape(request.runKind);
      const paths = resolveWorkspacePaths({ project: request.project, roots: request.roots, runId: request.runId });

      if (shape === 'none') {
        return { shape: 'none', runId: request.runId };
      }

      const runPresent = await runRootExists(driver, paths.runRoot);

      if (shape === 'scratch_only') {
        if (runPresent) {
          return {
            shape: 'scratch_only',
            runId: request.runId,
            outcome: 'present',
            workspaceRoot: paths.workspaceRoot,
            runRoot: paths.runRoot,
            scratchRoot: paths.scratchRoot
          };
        }

        try {
          await driver.mkdirp({ workspaceRoot: paths.workspaceRoot, targetPath: paths.runRoot });
          await driver.mkdirp({ workspaceRoot: paths.workspaceRoot, targetPath: paths.scratchRoot });
        } catch (cause) {
          await rollbackRunRoot({
            driver,
            pruner,
            runId: request.runId,
            workspaceRoot: paths.workspaceRoot,
            runRoot: paths.runRoot,
            hostRepositoryPath: paths.hostRepositoryPath,
            repoRoot: paths.repoRoot,
            worktreeCreated: false,
            originalError: cause
          });
        }

        return {
          shape: 'scratch_only',
          runId: request.runId,
          outcome: 'materialized',
          workspaceRoot: paths.workspaceRoot,
          runRoot: paths.runRoot,
          scratchRoot: paths.scratchRoot
        };
      }

      // shape === 'two_roots'
      const branchName = deriveRunBranchName({
        runKind: request.runKind,
        topicSlug: request.topicSlug,
        shortRunId: request.shortRunId
      });
      const base = request.materializationBase;

      // Already-present workspace behavior applies to EVERY provisioning base: if the run
      // root is already present on the expected branch, leave it in place, treat the match
      // as the branch guard, and report it as present. An explicit base must not wipe or
      // rebuild a healthy workspace (and must not discard its scratch).
      if (runPresent) {
        const actualBranch = await driver.currentBranch(paths.repoRoot);
        if (actualBranch === branchName) {
          return twoRootsResult(request, paths, branchName, declaredBaseRef(request), 'present');
        }

        // Present but not on the expected branch. The explicit `current_default_branch`
        // start-over is the sole path allowed to intentionally remove and rebuild the
        // run's own root; every other base keeps branch-guard failure as the safety
        // boundary rather than silently deleting or repairing the directory.
        if (base?.kind !== 'current_default_branch') {
          throw new WorkspaceProvisioningError('branch_guard_failed', 'Worktree is not on the expected branch', {
            targetPath: paths.repoRoot,
            expectedBranch: branchName,
            actualBranch
          });
        }
      }

      // Explicit start-over: rebuild from the fetched default branch. Reached only when the
      // workspace is missing or present on an unexpected branch — the run's own derived
      // branch/root are removed first so no prior run commits are carried forward.
      if (base?.kind === 'current_default_branch') {
        return materializeFromDefaultBranch(request, paths, branchName, { removeExisting: true });
      }

      // Missing workspace, explicit recovery from the existing run branch.
      if (base?.kind === 'run_branch') {
        return materializeFromRunBranch(request, paths, branchName);
      }

      // No explicit base, run root missing → today's default new-run behavior.
      return materializeFromDefaultBranch(request, paths, branchName, { removeExisting: false });
    }
  };
}
