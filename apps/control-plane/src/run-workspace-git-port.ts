import { TESTING_GUIDE_DIFF_MAX_BYTES } from '@autocatalyst/api-contract';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import {
  defaultReviewerWorkspacePolicy,
  type CaptureCheckpointRefInput,
  type CaptureCheckpointRefResult,
  type ChangedFileEntry,
  type CheckpointAltitude,
  type GetChangedFilesInput,
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

// Broader ref pattern for diffs: allows branch names, remote-tracking refs, and SHAs.
const DIFF_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

function validateDiffRef(ref: string | undefined): void {
  if (ref === undefined) return;
  if (typeof ref !== 'string' || ref.length === 0) throw new Error('changed_files_ref_invalid');
  if (ref.includes('..') || ref.includes(' ') || ref.includes('\n') || ref.startsWith('-')) {
    throw new Error('changed_files_ref_invalid');
  }
  if (!DIFF_REF_PATTERN.test(ref)) throw new Error('changed_files_ref_invalid');
}

function normalizeDiffPath(raw: string): string {
  const normalized = raw.replace(/\\/gu, '/');
  if (normalized.length === 0 || normalized.startsWith('/')) {
    throw new Error('changed_files_path_invalid');
  }
  if (normalized.split('/').some((s) => s.length === 0 || s === '.' || s === '..')) {
    throw new Error('changed_files_path_invalid');
  }
  return normalized;
}

async function assertContainment(workspacesRoot: string, workspaceRepoRoot: string): Promise<void> {
  const normalizedRoot = await realpath(workspacesRoot).catch(() => workspacesRoot);
  const normalizedRepo = await realpath(workspaceRepoRoot).catch(() => workspaceRepoRoot);
  if (!normalizedRepo.startsWith(normalizedRoot + '/') && normalizedRepo !== normalizedRoot) {
    throw new Error('workspace_containment_violation');
  }
}

export function createRunWorkspaceGitPort(options: RunWorkspaceGitPortOptions): RunWorkspaceGitPort & {
  readHead(workspaceRepoRoot: string): Promise<string>;
} {
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

      if (input.onlyPath === undefined) {
        await execFileAsync('git', ['add', '--all'], { cwd: input.workspaceRepoRoot });
        await execFileAsync('git', ['commit', '-m', input.message], { cwd: input.workspaceRepoRoot });
      } else {
        validatePath(input.onlyPath);
        await execFileAsync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', 'commit', '--only', '-m', input.message, '--', input.onlyPath], { cwd: input.workspaceRepoRoot });
      }
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
    },

    async readHead(workspaceRepoRoot) {
      await assertContainment(options.workspacesRoot, workspaceRepoRoot);
      const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: workspaceRepoRoot });
      return stdout.trim();
    },

    async getDiffText(input) {
      validateDiffRef(input.baseRef);
      validateDiffRef(input.headRef);
      await assertContainment(options.workspacesRoot, input.workspaceRepoRoot);
      const args = ['diff', '--no-ext-diff', '--no-textconv', input.baseRef, input.headRef ?? 'HEAD', '--'];
      // Drain to process exit so a failing comparison never looks like a valid
      // truncated patch. Retain only enough bytes to detect overflow.
      return new Promise<string>((resolve, reject) => {
        const child = spawn('git', args, { cwd: input.workspaceRepoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
        const bytes = Buffer.alloc(TESTING_GUIDE_DIFF_MAX_BYTES + 1);
        let length = 0;
        child.stdout.on('data', (chunk: Buffer) => {
          length += chunk.copy(bytes, length, 0, Math.min(chunk.length, bytes.length - length));
        });
        child.on('error', () => reject(new Error('testing_guide_diff_failed')));
        child.on('close', code => {
          if (code === 0) resolve(bytes.subarray(0, length).toString('utf8'));
          else reject(new Error('testing_guide_diff_failed'));
        });
      });
    },

    async getChangedFiles(input: GetChangedFilesInput): Promise<readonly ChangedFileEntry[]> {
      validateDiffRef(input.baseRef);
      if (input.headRef !== undefined) {
        validateDiffRef(input.headRef);
      }
      await assertContainment(options.workspacesRoot, input.workspaceRepoRoot);

      const head = input.headRef ?? 'HEAD';
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '--find-renames', '-z', input.baseRef, head, '--'];
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn('git', args, { cwd: input.workspaceRepoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks: string[] = [];
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => chunks.push(chunk));
        child.on('error', () => reject(new Error('changed_files_comparison_failed')));
        child.on('close', code => {
          if (code === 0) resolve(chunks.join(''));
          else reject(new Error('changed_files_comparison_failed'));
        });
      });

      const entries = new Map<string, ChangedFileEntry>();
      const fields = stdout.split('\0');
      for (let index = 0; index < fields.length - 1;) {
        const status = fields[index++]?.[0];
        const first = normalizeDiffPath(fields[index++] ?? '');
        let entry: ChangedFileEntry | null = null;
        if (status === 'A') entry = { path: first, status: 'added' };
        else if (status === 'M' || status === 'T') entry = { path: first, status: 'modified' };
        else if (status === 'D') entry = { path: first, status: 'deleted' };
        else if (status === 'R' || status === 'C') {
          const path = normalizeDiffPath(fields[index++] ?? '');
          entry = status === 'R' ? { path, status: 'renamed', previousPath: first } : { path, status: 'added' };
        }
        if (entry !== null) entries.set(entry.path, entry);
      }

      return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
    }
  };
}
