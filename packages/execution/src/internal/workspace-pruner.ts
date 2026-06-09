import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  WorkspacePruneError,
  type PruneWorkspacePathRequest,
  type WorkspacePruneErrorCode,
  type WorkspacePruneResult
} from '../workspace.js';
import type { WorkspaceDriver } from './workspace-driver.js';
import { consoleWorkspaceLogger, type WorkspaceLogger } from './workspace-logger.js';
import { assertPathInsideRootWithoutFinalSymlinkResolution } from './workspace-paths.js';

export interface WorkspacePrunerDependencies {
  readonly driver: WorkspaceDriver;
  readonly now?: () => number;
  readonly logger?: WorkspaceLogger;
}

export interface WorkspacePruner {
  pruneWorkspacePath(request: PruneWorkspacePathRequest): Promise<WorkspacePruneResult>;
}

// This module is the single policy-level gateway for workspace filesystem deletion.
// Teardown and rollback code must call this pruner instead of calling driver.removeDirectory
// or driver.removeWorktree directly.

const roundDuration = (durationMs: number): number => Math.max(0, Math.round(durationMs));

export function createWorkspacePruner(dependencies: WorkspacePrunerDependencies): WorkspacePruner {
  const { driver } = dependencies;
  const now = dependencies.now ?? (() => performance.now());
  const logger = dependencies.logger ?? consoleWorkspaceLogger;

  async function finish(
    request: PruneWorkspacePathRequest,
    startedAt: number,
    status: WorkspacePruneResult['status'],
    errorCode?: WorkspacePruneErrorCode
  ): Promise<WorkspacePruneResult> {
    const result: WorkspacePruneResult = {
      runId: request.runId,
      mode: request.mode,
      status,
      root: path.resolve(request.workspaceRoot),
      targetPath: path.resolve(request.targetPath),
      durationMs: roundDuration(now() - startedAt),
      ...(errorCode !== undefined && { errorCode })
    };
    logger.emit(status === 'failed' ? 'error' : status === 'rejected' ? 'warn' : 'info', {
      component: 'workspace-lifecycle',
      event: 'workspace.prune.completed',
      runId: result.runId,
      mode: result.mode,
      rootKind: 'workspace',
      root: result.root,
      targetPath: result.targetPath,
      status: result.status,
      ...(result.errorCode !== undefined && { errorCode: result.errorCode }),
      durationMs: result.durationMs
    });
    return result;
  }

  return {
    async pruneWorkspacePath(request) {
      const startedAt = now();
      logger.emit('info', {
        component: 'workspace-lifecycle',
        event: 'workspace.prune.started',
        runId: request.runId,
        mode: request.mode,
        rootKind: 'workspace',
        root: path.resolve(request.workspaceRoot),
        targetPath: path.resolve(request.targetPath)
      });

      if (request.mode !== 'directory' && request.mode !== 'worktree') {
        throw new WorkspacePruneError(
          'unsupported_prune_mode',
          `Unsupported workspace prune mode: ${String(request.mode)}`,
          { runId: request.runId, mode: request.mode as never }
        );
      }

      try {
        await assertPathInsideRootWithoutFinalSymlinkResolution(
          { root: request.workspaceRoot, rootKind: 'workspace', targetPath: request.targetPath, intent: 'delete' },
          { pathExists: (p) => driver.pathExists(p), realpath: (p) => driver.realpath(p) }
        );
      } catch {
        return finish(request, startedAt, 'rejected', 'out_of_root_path');
      }

      let stat: Awaited<ReturnType<WorkspaceDriver['statPath']>>;
      try {
        stat = await driver.statPath(path.resolve(request.targetPath));
      } catch {
        return finish(request, startedAt, 'failed', 'target_stat_failed');
      }

      if (stat === 'missing') {
        if (request.mode === 'worktree') {
          if (request.hostRepositoryPath === undefined) {
            return finish(request, startedAt, 'failed', 'missing_host_repository');
          }
          try {
            await driver.pruneWorktreeAdminState({ hostRepositoryPath: request.hostRepositoryPath });
          } catch {
            return finish(request, startedAt, 'failed', 'worktree_admin_prune_failed');
          }
        }
        return finish(request, startedAt, 'missing');
      }

      if (stat !== 'directory') {
        return finish(request, startedAt, 'rejected', 'target_not_directory');
      }

      if (request.mode === 'directory') {
        try {
          await driver.removeDirectory({ workspaceRoot: request.workspaceRoot, targetPath: request.targetPath });
          return finish(request, startedAt, 'deleted');
        } catch {
          return finish(request, startedAt, 'failed', 'directory_remove_failed');
        }
      }

      // mode === 'worktree'
      if (request.hostRepositoryPath === undefined) {
        return finish(request, startedAt, 'failed', 'missing_host_repository');
      }
      try {
        await driver.removeWorktree({ hostRepositoryPath: request.hostRepositoryPath, repoRoot: request.targetPath });
        return finish(request, startedAt, 'deleted');
      } catch {
        return finish(request, startedAt, 'failed', 'worktree_remove_failed');
      }
    }
  };
}
