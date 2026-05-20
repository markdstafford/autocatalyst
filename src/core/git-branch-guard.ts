import { execFile as _execFile } from 'node:child_process';
import type pino from 'pino';
import { createLogger } from './logger.js';

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

function defaultExec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    _execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err) { reject(err); } else { resolve({ stdout, stderr }); }
    });
  });
}

export interface BranchGuard {
  check(workspace_path: string, expected_branch: string): Promise<void>;
}

interface GitBranchGuardOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

export class GitBranchGuard implements BranchGuard {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(options?: GitBranchGuardOptions) {
    this.execFn = options?.execFn ?? defaultExec;
    this.logger = createLogger('git-branch-guard', { destination: options?.logDestination });
  }

  async check(workspace_path: string, expected_branch: string): Promise<void> {
    let current: string;
    try {
      const { stdout } = await this.execFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace_path });
      current = stdout.trim();
    } catch (err) {
      this.logger.error(
        { event: 'branch_guard.checked', outcome: 'error', workspace_path, expected_branch, error: String(err) },
        'Branch check error',
      );
      throw new Error(`Branch check failed: ${String(err)}`);
    }

    if (current !== expected_branch) {
      this.logger.info(
        { event: 'branch_guard.checked', outcome: 'blocked', workspace_path, expected_branch, actual_branch: current },
        'Branch guard blocked',
      );
      throw new Error(
        `Agent changed branches from ${expected_branch} to ${current}. Autocatalyst owns run branches; this run cannot continue safely.`,
      );
    }

    this.logger.info(
      { event: 'branch_guard.checked', outcome: 'allowed', workspace_path, expected_branch, actual_branch: current },
      'Branch guard allowed',
    );
  }
}
