import {
  WorkspaceProvisioningError,
  summarizeWorkspaceCause,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult
} from '../workspace.js';
import type { WorkspaceDriver } from './workspace-driver.js';
import type { WorkspacePruner } from './workspace-pruner.js';
import { deriveRunBranchName, resolveWorkspacePaths, selectWorkspaceProvisioningShape } from './workspace-paths.js';

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
  const runRootExists = await input.driver.pathExists(input.runRoot);
  if (runRootExists) {
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

export function createWorkspaceProvisioner(dependencies: WorkspaceProvisionerDependencies): WorkspaceProvisioner {
  const { driver, pruner } = dependencies;

  return {
    async provisionWorkspace(request) {
      const shape = selectWorkspaceProvisioningShape(request.runKind);
      const paths = resolveWorkspacePaths({ project: request.project, roots: request.roots, runId: request.runId });

      if (shape === 'none') {
        return { shape: 'none', runId: request.runId };
      }

      // Idempotent: if the run root already exists, return the resolved paths without re-provisioning.
      // This allows the same run to be dispatched across multiple steps (e.g. intake → spec.author)
      // without the second dispatch failing with run_workspace_exists.
      if (await runRootExists(driver, paths.runRoot)) {
        if (shape === 'scratch_only') {
          return {
            shape: 'scratch_only',
            runId: request.runId,
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
        const baseRef = request.defaultBranch !== undefined ? `origin/${request.defaultBranch}` : 'origin/main';
        await verifyBranch({ driver, repoRoot: paths.repoRoot, expectedBranch: branchName });
        return {
          shape: 'two_roots',
          runId: request.runId,
          workspaceRoot: paths.workspaceRoot,
          runRoot: paths.runRoot,
          repoRoot: paths.repoRoot,
          scratchRoot: paths.scratchRoot,
          hostRepositoryPath: paths.hostRepositoryPath,
          branchName,
          provisionedBaseRef: baseRef
        };
      }

      if (shape === 'scratch_only') {
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
      let worktreeCreated = false;

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

      return {
        shape: 'two_roots',
        runId: request.runId,
        workspaceRoot: paths.workspaceRoot,
        runRoot: paths.runRoot,
        repoRoot: paths.repoRoot,
        scratchRoot: paths.scratchRoot,
        hostRepositoryPath: paths.hostRepositoryPath,
        branchName,
        provisionedBaseRef: baseRef
      };
    }
  };
}
