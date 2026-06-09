import {
  WorkspaceProvisioningError,
  summarizeWorkspaceCause,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult
} from '../workspace.js';
import type { WorkspaceDriver } from './workspace-driver.js';
import { deriveRunBranchName, resolveWorkspacePaths, selectWorkspaceProvisioningShape } from './workspace-paths.js';

export interface WorkspaceProvisionerDependencies {
  readonly driver: WorkspaceDriver;
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

async function ensureRunRootAbsent(driver: WorkspaceDriver, runRoot: string): Promise<void> {
  if (await driver.pathExists(runRoot)) {
    throw new WorkspaceProvisioningError('run_workspace_exists', 'Run workspace already exists', { targetPath: runRoot });
  }
}

async function rollbackRunRoot(input: {
  readonly driver: WorkspaceDriver;
  readonly workspaceRoot: string;
  readonly runRoot: string;
  readonly hostRepositoryPath: string;
  readonly repoRoot: string;
  readonly worktreeCreated: boolean;
  readonly originalError: unknown;
}): Promise<never> {
  let rollbackCause: unknown;

  try {
    if (input.worktreeCreated) {
      await input.driver.removeWorktree({ hostRepositoryPath: input.hostRepositoryPath, repoRoot: input.repoRoot });
    }
    await input.driver.removeDirectory({ workspaceRoot: input.workspaceRoot, targetPath: input.runRoot });
  } catch (cause) {
    rollbackCause = cause;
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
  const { driver } = dependencies;

  return {
    async provisionWorkspace(request) {
      const shape = selectWorkspaceProvisioningShape(request.runKind);
      const paths = resolveWorkspacePaths({ project: request.project, roots: request.roots, runId: request.runId });

      if (shape === 'none') {
        return { shape: 'none', runId: request.runId };
      }

      await ensureRunRootAbsent(driver, paths.runRoot);

      if (shape === 'scratch_only') {
        try {
          await driver.mkdirp(paths.runRoot);
          await driver.mkdirp(paths.scratchRoot);
        } catch (cause) {
          await rollbackRunRoot({
            driver,
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
        defaultBranch: request.defaultBranch
      });

      try {
        await driver.mkdirp(paths.runRoot);
        await driver.addWorktree({
          hostRepositoryPath: paths.hostRepositoryPath,
          repoRoot: paths.repoRoot,
          branchName,
          baseRef
        });
        worktreeCreated = true;
        await driver.mkdirp(paths.scratchRoot);
        await verifyBranch({ driver, repoRoot: paths.repoRoot, expectedBranch: branchName });
      } catch (cause) {
        await rollbackRunRoot({
          driver,
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
        branchName
      };
    }
  };
}
