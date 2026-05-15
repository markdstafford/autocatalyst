// src/adapters/github/issue-manager.ts
import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { IssueManager, TrackedIssue } from '../../types/issue-tracker.js';

const _promisifiedExecFile = promisify(_execFile);

const _extraPaths = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];

async function defaultExecFile(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const sep = process.platform === 'win32' ? ';' : ':';
  const currentPath = process.env.PATH ?? '';
  const currentParts = new Set(currentPath.split(sep));
  const newParts = _extraPaths.filter(p => !currentParts.has(p));
  const augmentedPath = newParts.length > 0
    ? [...newParts, currentPath].filter(Boolean).join(sep)
    : currentPath;
  return _promisifiedExecFile(cmd, args, { ...opts, env: { ...process.env, PATH: augmentedPath } });
}

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

  async getIssue(repo_url: string, issue_number: number): Promise<TrackedIssue> {
    let stdout: string;
    try {
      ({ stdout } = await this.execFn(
        'gh',
        ['issue', 'view', String(issue_number), '--repo', repo_url, '--json', 'number,title,body,labels,state,url'],
        {},
      ));
    } catch (err) {
      this.logger.error(
        { event: 'issue.read_failed', issue_number, error: String(err) },
        'Failed to read issue',
      );
      throw new Error(`gh issue view failed: ${String(err)}`);
    }

    let parsed: {
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string } | string>;
      state: string;
      url?: string;
    };
    try {
      parsed = JSON.parse(stdout) as typeof parsed;
    } catch (err) {
      this.logger.error(
        { event: 'issue.read_failed', issue_number, error: 'malformed JSON' },
        'Failed to parse gh issue view output',
      );
      throw new Error(`gh issue view returned malformed JSON for issue ${issue_number}`);
    }

    const labels = parsed.labels.map(l => (typeof l === 'string' ? l : l.name));

    this.logger.info(
      { event: 'issue_reference.loaded', issue_number, labels, state: parsed.state },
      'Issue loaded',
    );

    return {
      number: parsed.number,
      title: parsed.title,
      body: parsed.body,
      labels,
      state: parsed.state,
      url: parsed.url,
    };
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
