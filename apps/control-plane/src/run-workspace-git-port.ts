import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { defaultReviewerWorkspacePolicy, type RunWorkspaceGitPort } from '@autocatalyst/core';

const execFileAsync = promisify(execFile);

interface RunWorkspaceGitPortOptions {
  readonly workspacesRoot: string;
}

export function createRunWorkspaceGitPort(options: RunWorkspaceGitPortOptions): RunWorkspaceGitPort {
  return {
    reviewerPolicy: defaultReviewerWorkspacePolicy,
    async commitFiles(input) {
      // Verify the workspace root is within the configured workspacesRoot
      const normalizedRoot = await realpath(options.workspacesRoot).catch(() => options.workspacesRoot);
      const normalizedRepo = await realpath(input.workspaceRepoRoot).catch(() => input.workspaceRepoRoot);
      if (!normalizedRepo.startsWith(normalizedRoot + '/') && normalizedRepo !== normalizedRoot) {
        throw new Error('workspace_containment_violation');
      }

      const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'], { cwd: input.workspaceRepoRoot });
      const changedFiles = statusOutput.trim().split('\n').filter(Boolean);
      const changedFileCount = changedFiles.length;

      if (changedFileCount === 0 && !input.allowEmpty) {
        return { commitSha: null, changedFileCount: 0 };
      }

      await execFileAsync('git', ['add', '--all'], { cwd: input.workspaceRepoRoot });
      await execFileAsync('git', ['commit', '-m', input.message], { cwd: input.workspaceRepoRoot });
      const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: input.workspaceRepoRoot });
      return { commitSha: sha.trim(), changedFileCount };
    }
  };
}
