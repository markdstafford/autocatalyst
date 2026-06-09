import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  WorkspaceProvisioningError,
  redactWorkspaceDiagnostic,
  summarizeWorkspaceCause,
  type WorkspaceProvisioningErrorCode
} from '../workspace.js';
import { assertPathInsideRoot } from './workspace-paths.js';

const execFileAsync = promisify(execFile);

/** Typed wrapper to avoid repeating the cast for `fs.realpath` at each call site. */
const nodeRealpath = (p: string): Promise<string> => fs.realpath(p);

export interface HostRepositoryInput {
  readonly reposRoot: string;
  readonly hostRepositoryPath: string;
  readonly remoteUrl: string;
}

export interface FetchHostRepositoryInput {
  readonly reposRoot: string;
  readonly hostRepositoryPath: string;
}

export interface ResolveDefaultBranchInput {
  readonly hostRepositoryPath: string;
  readonly defaultBranch?: string;
}

export interface AddWorktreeInput {
  readonly hostRepositoryPath: string;
  readonly repoRoot: string;
  readonly branchName: string;
  readonly baseRef: string;
}

export interface RemoveWorktreeInput {
  readonly hostRepositoryPath: string;
  readonly repoRoot: string;
}

export interface RemoveDirectoryInput {
  readonly workspaceRoot: string;
  readonly targetPath: string;
}

export interface WorkspaceDriver {
  ensureHostRepository(input: HostRepositoryInput): Promise<void>;
  fetchHostRepository(input: FetchHostRepositoryInput): Promise<void>;
  /** Returns the remote-tracking base ref (e.g. 'origin/main') for use as the worktree base. */
  resolveDefaultBranch(input: ResolveDefaultBranchInput): Promise<string>;
  addWorktree(input: AddWorktreeInput): Promise<void>;
  currentBranch(repoRoot: string): Promise<string | null>;
  removeWorktree(input: RemoveWorktreeInput): Promise<void>;
  mkdirp(targetPath: string): Promise<void>;
  pathExists(targetPath: string): Promise<boolean>;
  realpath(targetPath: string): Promise<string>;
  removeDirectory(input: RemoveDirectoryInput): Promise<void>;
}

interface RunGitOptions {
  readonly code: WorkspaceProvisioningErrorCode;
  readonly message: string;
  readonly targetPath?: string;
  readonly cwd?: string;
}

async function runGit(args: readonly string[], options: RunGitOptions): Promise<string> {
  try {
    const result = await execFileAsync('git', args as string[], {
      cwd: options.cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return result.stdout.trim();
  } catch (cause) {
    const summary = summarizeWorkspaceCause(cause);
    const targetPath = options.targetPath ?? options.cwd;
    throw new WorkspaceProvisioningError(options.code, options.message, {
      ...(targetPath !== undefined && { targetPath }),
      cause: {
        ...summary,
        message: redactWorkspaceDiagnostic(summary.message)
      }
    });
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function createNodeWorkspaceDriver(): WorkspaceDriver {
  return {
    async ensureHostRepository(input) {
      await assertPathInsideRoot(
        { root: input.reposRoot, rootKind: 'repos', targetPath: path.dirname(input.hostRepositoryPath), intent: 'write' },
        { pathExists: exists, realpath: nodeRealpath }
      );
      await assertPathInsideRoot(
        { root: input.reposRoot, rootKind: 'repos', targetPath: input.hostRepositoryPath, intent: 'git' },
        { pathExists: exists, realpath: nodeRealpath }
      );

      if (await exists(input.hostRepositoryPath)) {
        await runGit(['rev-parse', '--git-dir'], {
          cwd: input.hostRepositoryPath,
          code: 'host_clone_failed',
          message: 'Existing host repository path is not a git repository',
          targetPath: input.hostRepositoryPath
        });
        return;
      }

      await fs.mkdir(path.dirname(input.hostRepositoryPath), { recursive: true });
      await runGit(['clone', input.remoteUrl, input.hostRepositoryPath], {
        code: 'host_clone_failed',
        message: 'Failed to clone host repository',
        targetPath: input.hostRepositoryPath
      });
    },

    async fetchHostRepository(input) {
      await assertPathInsideRoot(
        { root: input.reposRoot, rootKind: 'repos', targetPath: input.hostRepositoryPath, intent: 'git' },
        { pathExists: exists, realpath: nodeRealpath }
      );
      await runGit(['fetch', '--prune', 'origin'], {
        cwd: input.hostRepositoryPath,
        code: 'fetch_failed',
        message: 'Failed to fetch host repository',
        targetPath: input.hostRepositoryPath
      });
    },

    // Returns the remote-tracking base ref (e.g. 'origin/main') for use as the worktree base.
    async resolveDefaultBranch(input) {
      const symbolicHead = await runGit(
        ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        {
          cwd: input.hostRepositoryPath,
          code: 'default_branch_resolution_failed',
          message: 'Failed to resolve default branch',
          targetPath: input.hostRepositoryPath
        }
      ).catch(() => null);

      if (symbolicHead?.startsWith('origin/')) {
        return symbolicHead;
      }

      if (input.defaultBranch && input.defaultBranch.length > 0) {
        return `origin/${input.defaultBranch}`;
      }

      throw new WorkspaceProvisioningError('default_branch_resolution_failed', 'Unable to resolve default branch', {
        targetPath: input.hostRepositoryPath
      });
    },

    async addWorktree(input) {
      await runGit(['worktree', 'add', '-b', input.branchName, input.repoRoot, input.baseRef], {
        cwd: input.hostRepositoryPath,
        code: 'worktree_creation_failed',
        message: 'Failed to create run worktree',
        targetPath: input.repoRoot
      });
    },

    async currentBranch(repoRoot) {
      try {
        const output = await runGit(['branch', '--show-current'], {
          cwd: repoRoot,
          code: 'branch_guard_failed',
          message: 'Failed to read worktree branch',
          targetPath: repoRoot
        });
        // Empty output means detached HEAD — not on a named branch.
        return output.length > 0 ? output : null;
      } catch {
        return null;
      }
    },

    async removeWorktree(input) {
      await runGit(['worktree', 'remove', '--force', input.repoRoot], {
        cwd: input.hostRepositoryPath,
        code: 'rollback_failed',
        message: 'Failed to remove run worktree during rollback',
        targetPath: input.repoRoot
      });
    },

    async mkdirp(targetPath) {
      await fs.mkdir(targetPath, { recursive: true });
    },

    async pathExists(targetPath) {
      return exists(targetPath);
    },

    async realpath(targetPath) {
      return fs.realpath(targetPath);
    },

    async removeDirectory(input) {
      const safeTargetPath = await assertPathInsideRoot(
        { root: input.workspaceRoot, rootKind: 'workspace', targetPath: input.targetPath, intent: 'delete' },
        { pathExists: exists, realpath: nodeRealpath }
      );
      await fs.rm(safeTargetPath, { recursive: true, force: true });
    }
  };
}
