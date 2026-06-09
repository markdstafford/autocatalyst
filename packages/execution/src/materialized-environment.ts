import type { ExecutionContext } from '@autocatalyst/api-contract';

export type MaterializedWorkspace =
  | { readonly shape: 'none'; readonly workspaceRoots: readonly string[] }
  | { readonly shape: 'scratch_only'; readonly scratchRoot: string; readonly workspaceRoots: readonly string[] }
  | { readonly shape: 'two_roots'; readonly repoRoot: string; readonly scratchRoot: string; readonly branchName: string; readonly workspaceRoots: readonly string[] };

export interface MaterializedExecutionEnvironment {
  readonly context: ExecutionContext;
  readonly workspace: MaterializedWorkspace;
  readonly environment: {
    readonly variables: Readonly<Record<string, string>>;
    readonly secretVariableNames: readonly string[];
  };
  readonly toolPolicy: {
    readonly allowedTools: readonly string[];
    readonly workspaceRoots: readonly string[];
  };
  readonly skills: {
    readonly requested: readonly string[];
    readonly plugins?: readonly string[];
  };
  readonly capabilities: {
    readonly shell: { readonly kind: 'bash'; readonly available: boolean };
    readonly paths: { readonly repoRoot?: string; readonly scratchRoot?: string };
    readonly lsp: { readonly requested: boolean; readonly available: boolean };
  };
}

export type ExecutionMaterializationErrorCode =
  | 'missing_workspace_settings'
  | 'workspace_provisioning_failed'
  | 'secret_resolution_failed'
  | 'unsupported_workspace_shape'
  | 'capability_materialization_failed';

export class ExecutionMaterializationError extends Error {
  readonly code: ExecutionMaterializationErrorCode;
  readonly details?: unknown;

  constructor(code: ExecutionMaterializationErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ExecutionMaterializationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
