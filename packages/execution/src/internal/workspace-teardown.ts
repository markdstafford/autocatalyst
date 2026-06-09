import type { TeardownWorkspaceRequest, WorkspaceTeardownResult } from '../workspace.js';
import type { WorkspaceDriver } from './workspace-driver.js';
import type { WorkspacePruner } from './workspace-pruner.js';

export interface WorkspaceTeardownDependencies {
  readonly driver: WorkspaceDriver;
  readonly pruner: WorkspacePruner;
}

export interface WorkspaceTeardown {
  teardownWorkspace(request: TeardownWorkspaceRequest): Promise<WorkspaceTeardownResult>;
}

export function createWorkspaceTeardown(_dependencies: WorkspaceTeardownDependencies): WorkspaceTeardown {
  return {
    async teardownWorkspace(request) {
      return {
        runId: request.runId,
        runKind: request.runKind,
        terminalStep: request.terminalStep,
        outcome: 'skipped',
        prunes: []
      };
    }
  };
}
