import type { PruneWorkspacePathRequest, WorkspacePruneResult } from '../workspace.js';
import type { WorkspaceDriver } from './workspace-driver.js';

export interface WorkspacePrunerDependencies {
  readonly driver: WorkspaceDriver;
}

export interface WorkspacePruner {
  pruneWorkspacePath(request: PruneWorkspacePathRequest): Promise<WorkspacePruneResult>;
}

export function createWorkspacePruner(_dependencies: WorkspacePrunerDependencies): WorkspacePruner {
  return {
    async pruneWorkspacePath(request) {
      return {
        runId: request.runId,
        mode: request.mode,
        status: 'skipped',
        root: request.workspaceRoot,
        targetPath: request.targetPath,
        durationMs: 0
      };
    }
  };
}
