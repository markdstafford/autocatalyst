import { execFile as _execFile } from 'node:child_process';

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
}

export class GitBranchGuard implements BranchGuard {
  private readonly execFn: ExecFn;

  constructor(options?: GitBranchGuardOptions) {
    this.execFn = options?.execFn ?? defaultExec;
  }

  async check(workspace_path: string, expected_branch: string): Promise<void> {
    let current: string;
    try {
      const { stdout } = await this.execFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace_path });
      current = stdout.trim();
    } catch (err) {
      throw new Error(`Branch check failed: ${String(err)}`);
    }

    if (current !== expected_branch) {
      throw new Error(
        `Agent changed branches from ${expected_branch} to ${current}. Autocatalyst owns run branches; this run cannot continue safely.`,
      );
    }
  }
}
