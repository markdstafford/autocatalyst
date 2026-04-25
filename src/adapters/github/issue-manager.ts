// src/adapters/github/issue-manager.ts
import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { IssueManager } from '../../types/issue-tracker.js';

const defaultExecFile = promisify(_execFile);

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

interface GHIssueManagerOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

export class GHIssueManager implements IssueManager {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(options?: GHIssueManagerOptions) {
    this.execFn = options?.execFn ?? defaultExecFile;
    this.logger = createLogger('issue-manager', { destination: options?.logDestination });
  }

  async writeIssue(workspace_path: string, issue_number: number, body: string): Promise<void> {
    try {
      await this.execFn('gh', ['issue', 'edit', String(issue_number), '--body', body], { cwd: workspace_path });
    } catch (err) {
      this.logger.error(
        { event: 'issue.write_failed', issue_number, error: String(err) },
        'Failed to update issue body',
      );
      throw new Error(`gh issue edit failed: ${String(err)}`);
    }
    this.logger.info({ event: 'issue.updated', issue_number }, 'Issue body updated');
  }

  async create(workspace_path: string, title: string, body: string, labels: string[] = []): Promise<{ number: number }> {
    const labelArgs = labels.flatMap(l => ['--label', l]);
    let stdout: string;
    try {
      ({ stdout } = await this.execFn(
        'gh',
        ['issue', 'create', '--title', title, '--body', body, ...labelArgs],
        { cwd: workspace_path },
      ));
    } catch (err) {
      this.logger.error(
        { event: 'issue.create_failed', error: String(err) },
        'Failed to create issue',
      );
      throw new Error(`gh issue create failed: ${String(err)}`);
    }
    const match = stdout.trim().match(/\/issues\/(\d+)$/);
    if (!match) {
      throw new Error(`Unexpected gh issue create output: "${stdout.trim()}"`);
    }
    const number = parseInt(match[1], 10);
    this.logger.info({ event: 'issue.created', issue_number: number }, 'Issue created');
    return { number };
  }
}
