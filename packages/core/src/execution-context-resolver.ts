import type { ExecutionContext, Project } from '@autocatalyst/api-contract';

import type { RunWorkInput } from './orchestrator.js';

// --- Error types ---

export type ExecutionContextResolutionErrorCode =
  | 'unsupported_work_kind'
  | 'unsupported_workspace_shape'
  | 'missing_project'
  | 'missing_workspace_settings'
  | 'invalid_secret_declaration'
  | 'resolver_unavailable';

export class ExecutionContextResolutionError extends Error {
  readonly code: ExecutionContextResolutionErrorCode;
  readonly details?: unknown;

  constructor(code: ExecutionContextResolutionErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ExecutionContextResolutionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// --- Resolver options ---

export interface WorkspaceResolverInput {
  readonly project?: Project;
  readonly roots?: { readonly reposRoot: string; readonly workspacesRoot: string };
  readonly topicSlug?: string;
  readonly shortRunId?: string;
  readonly defaultBranch?: string;
}

export interface CreateExecutionContextResolverOptions {
  readonly workspace?: WorkspaceResolverInput | ((input: RunWorkInput) => WorkspaceResolverInput);
  readonly secretBindings?: ReadonlyArray<{ readonly handle: string; readonly envName: string }>;
  readonly secretsAvailable?: boolean;
  readonly toolPolicy?: {
    readonly allowedTools?: readonly string[];
  };
  readonly skills?: {
    readonly requested?: readonly string[];
    readonly plugins?: readonly string[];
  };
  readonly capabilityRequirements?: {
    readonly shell?: { readonly required?: boolean };
    readonly paths?: { readonly canonicalWorkspacePaths?: boolean };
    readonly lsp?: { readonly requested?: boolean };
  };
  readonly prompt?: string | ((input: RunWorkInput) => string);
  readonly taskInputs?: Record<string, unknown> | ((input: RunWorkInput) => Record<string, unknown>);
}

export interface ExecutionContextResolver {
  resolve(input: RunWorkInput): Promise<ExecutionContext>;
}

// --- Work kind to workspace shape mapping ---

type WorkspaceShape = 'none' | 'scratch_only' | 'two_roots';

const WORK_KIND_SHAPE_MAP: Record<string, WorkspaceShape> = {
  feature: 'two_roots',
  enhancement: 'two_roots',
  bug: 'two_roots',
  chore: 'two_roots',
  question: 'none',
  file_issue: 'scratch_only'
};

// --- Core resolver logic ---

async function resolveContext(
  input: RunWorkInput,
  options: CreateExecutionContextResolverOptions
): Promise<ExecutionContext> {
  const { run } = input;

  // 1. Map work kind to workspace shape
  const shape = WORK_KIND_SHAPE_MAP[run.workKind];
  if (shape === undefined) {
    throw new ExecutionContextResolutionError(
      'unsupported_work_kind',
      `Unsupported work kind: '${run.workKind}'.`
    );
  }

  // 2. Build workspace intent
  let workspaceIntent: ExecutionContext['workspaceIntent'];
  if (shape === 'none') {
    workspaceIntent = { shape: 'none' };
  } else {
    // scratch_only or two_roots need workspace input
    const workspaceInput: WorkspaceResolverInput =
      typeof options.workspace === 'function'
        ? options.workspace(input)
        : (options.workspace ?? {});

    if (workspaceInput.project === undefined) {
      throw new ExecutionContextResolutionError(
        'missing_project',
        `Workspace shape '${shape}' requires a project but none was provided.`
      );
    }
    if (
      workspaceInput.roots === undefined ||
      workspaceInput.topicSlug === undefined ||
      workspaceInput.shortRunId === undefined
    ) {
      throw new ExecutionContextResolutionError(
        'missing_workspace_settings',
        `Workspace shape '${shape}' requires roots, topicSlug, and shortRunId.`
      );
    }

    const provisioning = {
      project: workspaceInput.project,
      roots: workspaceInput.roots,
      topicSlug: workspaceInput.topicSlug,
      shortRunId: workspaceInput.shortRunId,
      ...(workspaceInput.defaultBranch !== undefined ? { defaultBranch: workspaceInput.defaultBranch } : {})
    };

    workspaceIntent =
      shape === 'scratch_only'
        ? { shape: 'scratch_only', provisioning }
        : { shape: 'two_roots', provisioning };
  }

  // 3. Validate secret bindings
  const secretBindings = options.secretBindings ?? [];
  if (secretBindings.length > 0 && options.secretsAvailable !== true) {
    throw new ExecutionContextResolutionError(
      'invalid_secret_declaration',
      'Secret bindings declared but no secret resolver is available. Set secretsAvailable: true to enable secret bindings.'
    );
  }

  const envNamePattern = /^[A-Z_][A-Z0-9_]*$/u;
  for (const binding of secretBindings) {
    if (!envNamePattern.test(binding.envName)) {
      throw new ExecutionContextResolutionError(
        'invalid_secret_declaration',
        `Invalid envName '${binding.envName}': must match /^[A-Z_][A-Z0-9_]*$/u.`
      );
    }
  }

  const envNames = secretBindings.map((b) => b.envName);
  const uniqueEnvNames = new Set(envNames);
  if (uniqueEnvNames.size !== envNames.length) {
    throw new ExecutionContextResolutionError(
      'invalid_secret_declaration',
      'Duplicate envName values found in secret bindings.'
    );
  }

  // 4. Build tool policy
  const allowedTools = options.toolPolicy?.allowedTools
    ? [...options.toolPolicy.allowedTools]
    : ['bash', 'filesystem', 'lsp'];
  const toolPolicy: ExecutionContext['toolPolicy'] = {
    allowedTools,
    workspaceScope: 'declared_workspace'
  };

  // 5. Build skills
  const requestedSkills = options.skills?.requested
    ? [...options.skills.requested]
    : ['stub_runner'];
  const skills: ExecutionContext['skills'] = {
    requested: requestedSkills,
    ...(options.skills?.plugins !== undefined ? { plugins: [...options.skills.plugins] } : {})
  };

  // 6. Build capability requirements
  const capReqs = options.capabilityRequirements;
  const capabilityRequirements: ExecutionContext['capabilityRequirements'] = {
    shell: {
      kind: 'bash',
      required: capReqs?.shell?.required ?? false
    },
    paths: {
      canonicalWorkspacePaths: capReqs?.paths?.canonicalWorkspacePaths ?? true
    },
    lsp: {
      requested: capReqs?.lsp?.requested ?? true
    }
  };

  // 7. Build task prompt
  const prompt =
    typeof options.prompt === 'function'
      ? options.prompt(input)
      : (options.prompt ?? `Complete the ${run.currentStep} step.`);

  // 8. Build task inputs
  const taskInputsRaw = options.taskInputs;
  const taskInputs: Record<string, unknown> =
    typeof taskInputsRaw === 'function'
      ? taskInputsRaw(input)
      : (taskInputsRaw ?? {});

  // 9. Return declarative ExecutionContext
  return {
    run: {
      id: run.id,
      workKind: run.workKind,
      currentStep: run.currentStep,
      tenant: run.tenant
    },
    task: {
      prompt,
      inputs: taskInputs
    },
    workspaceIntent,
    secretBindings: secretBindings.map((b) => ({ handle: b.handle, envName: b.envName })),
    toolPolicy,
    skills,
    capabilityRequirements
  };
}

// --- Public factory ---

export function createExecutionContextResolver(
  options: CreateExecutionContextResolverOptions
): ExecutionContextResolver {
  return {
    resolve: async (input: RunWorkInput): Promise<ExecutionContext> => resolveContext(input, options)
  };
}
