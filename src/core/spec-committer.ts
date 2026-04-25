export type SpecLifecycleStatus = 'implementing' | 'complete';

export interface SpecCommitter {
  commit(
    workspace_path: string,
    publication_ref: string,
    artifact_path: string,
  ): Promise<void>;

  updateStatus(
    workspace_path: string,
    artifact_path: string,
    update: { status: SpecLifecycleStatus; last_updated: string },
  ): Promise<void>;
}
