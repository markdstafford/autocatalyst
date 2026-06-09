import type { ProvisionWorkspaceRequest, ProvisionWorkspaceResult } from '../workspace.js';
import type { WorkspaceDriver } from './workspace-driver.js';

export interface WorkspaceProvisionerDependencies {
  readonly driver: WorkspaceDriver;
}

export interface WorkspaceProvisioner {
  provisionWorkspace(request: ProvisionWorkspaceRequest): Promise<ProvisionWorkspaceResult>;
}

export function createWorkspaceProvisioner(_dependencies: WorkspaceProvisionerDependencies): WorkspaceProvisioner {
  return {
    async provisionWorkspace(request) {
      return { shape: 'none', runId: request.runId };
    }
  };
}
