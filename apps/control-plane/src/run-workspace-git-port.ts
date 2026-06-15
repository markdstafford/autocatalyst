import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import {
  defaultReviewerWorkspacePolicy,
  type CaptureCheckpointRefInput,
  type CaptureCheckpointRefResult,
  type CheckpointAltitude,
  type ListFilesAtRefInput,
  type ReadFileAtRefInput,
  type RunWorkspaceGitPort
} from '@autocatalyst/core';

const execFileAsync = promisify(execFile);

interface RunWorkspaceGitPortOptions {
  readonly workspacesRoot: string;
}

// Conservative allowlist for the runId path segment. The ref namespace embeds
// runId between slashes, so we disallow `/`, `..`, whitespace, and any shell or
// glob metacharacter.
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_ALTITUDES: ReadonlySet<CheckpointAltitude> = new Set(['layout', 'public_api', 'private_api']);

function validateRunId(runId: string): void {
  if (typeof runId !== 'string' || runId.length === 0 || !RUN_ID_PATTERN.test(runId)) {
    throw new Error('checkpoint_ref_invalid');
  }
}

function validateAltitude(altitude: CheckpointAltitude): void {
  if (!ALLOWED_ALTITUDES.has(altitude)) {
    throw new Error('checkpoint_ref_invalid');
  }
}

/** A commit SHA (4–64 hex chars) used as a ref, e.g. for git ls-tree or git show. */
const COMMIT_SHA_PATTERN = /^[a-f0-9]{4,64}$/i;

function validateRef(ref: string): void {
  if (typeof ref !== 'string') {
    throw new Error('checkpoint_ref_invalid');
  }
  // Accept both symbolic refs (refs/...) and raw commit SHAs.
  const isSymbolicRef = ref.startsWith('refs/');
  const isCommitSha = COMMIT_SHA_PATTERN.test(ref);
  if (!isSymbolicRef && !isCommitSha) {
    throw new Error('checkpoint_ref_invalid');
  }
  if (ref.includes('..') || ref.includes(' ') || ref.includes('\n')) {
    throw new Error('checkpoint_ref_invalid');
  }
}

function validatePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('checkpoint_path_invalid');
  }
  if (path.startsWith('/') || path.includes('..')) {
    throw new Error('checkpoint_path_invalid');
  }
}

async function assertContainment(workspacesRoot: string, workspaceRepoRoot: string): Promise<void> {
  const normalizedRoot = await realpath(workspacesRoot).catch(() => workspacesRoot);
  const normalizedRepo = await realpath(workspaceRepoRoot).catch(() => workspaceRepoRoot);
  if (!normalizedRepo.startsWith(normalizedRoot + '/') && normalizedRepo !== normalizedRoot) {
    throw new Error('workspace_containment_violation');
  }
}

export function createRunWorkspaceGitPort(options: RunWorkspaceGitPortOptions): RunWorkspaceGitPort {
  return {
    reviewerPolicy: defaultReviewerWorkspacePolicy,
    async commitFiles(input) {
      await assertContainment(options.workspacesRoot, input.workspaceRepoRoot);

      const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'], { cwd: input.workspaceRepoRoot });
      const changedFiles = statusOutput.trim().split('\n').filter(Boolean);
      const changedFileCount = changedFiles.length;

      if (changedFileCount === 0) {
        return { commitSha: null, changedFileCount: 0, changedFilePaths: [] };
      }

      await execFileAsync('git', ['add', '--all'], { cwd: input.workspaceRepoRoot });
      await execFileAsync('git', ['commit', '-m', input.message], { cwd: input.workspaceRepoRoot });
      const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: input.workspaceRepoRoot });
      const commitSha = sha.trim();

      // Use git diff-tree to get only the files added or modified in this specific commit
      // (excludes deletions, renames are captured as the new path via --diff-filter=ACMR).
      const { stdout: diffOutput } = await execFileAsync(
        'git',
        ['diff-tree', '--no-commit-id', '-r', '--name-only', '--diff-filter=ACMR', commitSha],
        { cwd: input.workspaceRepoRoot }
      );
      const changedFilePaths = diffOutput.trim().split('\n').filter(Boolean);

      return { commitSha, changedFileCount, changedFilePaths };
    },

    async captureCheckpointRef(input: CaptureCheckpointRefInput): Promise<CaptureCheckpointRefResult> {
      validateRunId(input.runId);
      validateAltitude(input.altitude);
      if (typeof input.commitSha !== 'string' || !/^[a-f0-9]{4,64}$/i.test(input.commitSha)) {
        throw new Error('checkpoint_ref_invalid');
      }
      await assertContainment(options.workspacesRoot, input.workspaceRepoRoot);
      const ref = `refs/autocatalyst/runs/${input.runId}/implementation.build/${input.altitude}`;
      await execFileAsync('git', ['update-ref', ref, input.commitSha], { cwd: input.workspaceRepoRoot });
      return { ref, commitSha: input.commitSha };
    },

    async readFileAtRef(input: ReadFileAtRefInput): Promise<string | null> {
      validateRef(input.ref);
      validatePath(input.path);
      await assertContainment(options.workspacesRoot, input.workspaceRepoRoot);
      try {
        const { stdout } = await execFileAsync('git', ['show', `${input.ref}:${input.path}`], { cwd: input.workspaceRepoRoot });
        return stdout;
      } catch {
        return null;
      }
    },

    async listFilesAtRef(input: ListFilesAtRefInput): Promise<readonly string[]> {
      validateRef(input.ref);
      await assertContainment(options.workspacesRoot, input.workspaceRepoRoot);
      const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', input.ref], { cwd: input.workspaceRepoRoot });
      return stdout.trim().split('\n').filter(Boolean);
    }
  };
}
