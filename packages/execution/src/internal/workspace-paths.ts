import fsPath from 'node:path';

import type { Project } from '@autocatalyst/api-contract';

import {
  WorkspaceProvisioningError,
  type ImplementingWorkspaceRunKind,
  type ProvisionWorkspaceRequest,
  type WorkspaceProvisioningRoots,
  type WorkspaceProvisioningShape,
  type WorkspaceRunKind
} from '../workspace.js';

export interface ResolvedWorkspacePaths {
  readonly reposRoot: string;
  readonly workspaceRoot: string;
  readonly hostRepositoryPath: string;
  readonly runRoot: string;
  readonly repoRoot: string;
  readonly scratchRoot: string;
}

export interface ResolveWorkspacePathsInput {
  readonly project: Project;
  readonly roots: WorkspaceProvisioningRoots;
  readonly runId: string;
}

export interface ContainmentDependencies {
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly realpath: (path: string) => Promise<string>;
}

const implementingRunKinds = new Set<string>(['feature', 'enhancement', 'bug', 'chore']);
const shortRunIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/;

export function isImplementingRunKind(runKind: WorkspaceRunKind): runKind is ImplementingWorkspaceRunKind {
  return implementingRunKinds.has(runKind);
}

export function selectWorkspaceProvisioningShape(runKind: string): WorkspaceProvisioningShape {
  if (runKind === 'question') {
    return 'none';
  }

  if (runKind === 'file_issue') {
    return 'scratch_only';
  }

  if (implementingRunKinds.has(runKind)) {
    return 'two_roots';
  }

  throw new WorkspaceProvisioningError('unsupported_run_kind', `Unsupported run kind: ${runKind}`);
}

function assertSafePathSegment(value: string, code: 'invalid_run_id' | 'invalid_project_repository', label: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes(' ')
  ) {
    throw new WorkspaceProvisioningError(code, `Invalid ${label}: value must be one safe path segment`);
  }

  return value;
}

export function validateRunIdSegment(runId: string): string {
  return assertSafePathSegment(runId, 'invalid_run_id', 'run id');
}

export function validateRepositoryPathSegment(value: string, label: 'owner' | 'name'): string {
  return assertSafePathSegment(value, 'invalid_project_repository', `repository ${label}`);
}

export function resolveWorkspacePaths(input: ResolveWorkspacePathsInput): ResolvedWorkspacePaths {
  const owner = validateRepositoryPathSegment(input.project.hostRepository.owner, 'owner');
  const name = validateRepositoryPathSegment(input.project.hostRepository.name, 'name');
  const runId = validateRunIdSegment(input.runId);
  const reposRoot = fsPath.resolve(input.roots.reposRoot);
  const workspaceRoot = fsPath.resolve(input.project.workspaceRootOverride ?? input.roots.workspacesRoot);
  const hostRepositoryPath = fsPath.resolve(reposRoot, owner, name);
  const runRoot = fsPath.resolve(workspaceRoot, owner, name, runId);

  return {
    reposRoot,
    workspaceRoot,
    hostRepositoryPath,
    runRoot,
    repoRoot: fsPath.resolve(runRoot, 'repo'),
    scratchRoot: fsPath.resolve(runRoot, 'scratch')
  };
}

function isPathInsideOrEqual(root: string, target: string): boolean {
  const relative = fsPath.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !fsPath.isAbsolute(relative));
}

async function nearestExistingParent(targetPath: string, deps: ContainmentDependencies): Promise<string> {
  let current = targetPath;

  while (!(await deps.pathExists(current))) {
    const parent = fsPath.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }

  return current;
}

export async function assertPathInsideRoot(
  input: {
    readonly root: string;
    readonly rootKind: 'workspace' | 'repos';
    readonly targetPath: string;
    readonly intent: 'write' | 'delete' | 'git';
  },
  deps: ContainmentDependencies
): Promise<string> {
  const resolvedRoot = fsPath.resolve(input.root);
  const resolvedTarget = fsPath.resolve(input.targetPath);
  const canonicalRoot = await deps.realpath(resolvedRoot);

  let canonicalTarget: string;
  if (await deps.pathExists(resolvedTarget)) {
    canonicalTarget = await deps.realpath(resolvedTarget);
  } else {
    const existingParent = await nearestExistingParent(resolvedTarget, deps);
    const canonicalParent = await deps.realpath(existingParent);
    canonicalTarget = fsPath.resolve(canonicalParent, fsPath.relative(existingParent, resolvedTarget));
  }

  if (!isPathInsideOrEqual(canonicalRoot, canonicalTarget)) {
    throw new WorkspaceProvisioningError('out_of_root_path', `${input.intent} path escapes ${input.rootKind} root`, {
      root: canonicalRoot,
      rootKind: input.rootKind,
      targetPath: canonicalTarget,
      intent: input.intent
    });
  }

  return canonicalTarget;
}

function sanitizeTopicSegment(topicSlug: string): string {
  let segment = topicSlug
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[^a-z0-9._-]/gu, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  while (segment.endsWith('.lock')) {
    segment = segment.slice(0, -'.lock'.length).replace(/^[._-]+|[._-]+$/g, '');
  }

  return segment.length > 0 ? segment : 'run';
}

export function deriveRunBranchName(input: Pick<ProvisionWorkspaceRequest, 'runKind' | 'topicSlug' | 'shortRunId'>): string {
  if (!isImplementingRunKind(input.runKind)) {
    throw new WorkspaceProvisioningError('unsupported_run_kind', `Run kind does not create a branch: ${input.runKind}`);
  }

  if (!shortRunIdPattern.test(input.shortRunId)) {
    throw new WorkspaceProvisioningError('invalid_run_id', 'Invalid short run id for branch name');
  }

  let topicSegment = sanitizeTopicSegment(input.topicSlug);
  const overheadLength = `${input.runKind}/`.length + `-${input.shortRunId}`.length;
  const maxTopicLength = 240 - overheadLength;

  if (topicSegment.length > maxTopicLength) {
    topicSegment = sanitizeTopicSegment(topicSegment.slice(0, maxTopicLength));
  }

  return `${input.runKind}/${topicSegment}-${input.shortRunId}`;
}
