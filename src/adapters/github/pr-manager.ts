import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { PRManager, PRManagerOptions } from '../../types/issue-tracker.js';
import type { RequestIntent } from '../../types/runs.js';

const defaultExecFile = promisify(_execFile);

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

interface GHPRManagerOptions {
  logDestination?: pino.DestinationStream;
}

function extractSpecTitle(specContent: string): string {
  const match = specContent.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'spec';
}

function extractFrontmatterField(specContent: string, field: string): string | null {
  const delim = '---';
  const start = specContent.indexOf(delim);
  if (start === -1) return null;
  const end = specContent.indexOf(delim, start + 3);
  if (end === -1) return null;
  const frontmatter = specContent.slice(start + 3, end);
  const match = frontmatter.match(new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm'));
  if (!match) return null;
  const val = match[1].trim();
  return val === 'null' ? null : val;
}

function derivePrTitle(runIntent: RequestIntent | undefined, specTitle: string): string {
  const lowerTitle = specTitle.toLowerCase();
  if (runIntent === 'bug') return `fix: ${lowerTitle}`;
  if (runIntent === 'chore') return `chore: ${lowerTitle}`;
  return `feat: ${lowerTitle}`;
}

function buildPrBody(specPath: string, issueNumber: number | null, options?: PRManagerOptions): string {
  const summary = options?.impl_result?.summary ?? 'No implementation summary provided.';
  const testingInstructions = options?.impl_result?.testing_instructions ?? 'No testing instructions provided.';

  const lines: string[] = [
    summary,
    '',
    '## Testing',
    '',
    testingInstructions,
    '',
    '---',
    `Spec: \`${specPath}\``,
  ];

  if (issueNumber !== null && issueNumber > 0) {
    lines.push(`Closes #${issueNumber}`);
  }

  return lines.join('\n');
}

export class GHPRManager implements PRManager {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(execFn?: ExecFn, options?: GHPRManagerOptions) {
    this.execFn = execFn ?? defaultExecFile;
    this.logger = createLogger('pr-manager', { destination: options?.logDestination });
  }

  async createPR(
    workspace_path: string,
    branch: string,
    spec_path: string,
    options?: PRManagerOptions,
  ): Promise<string> {
    const specContent = readFileSync(spec_path, 'utf-8');
    const rawTitle = options?.title ?? extractSpecTitle(specContent);
    const prTitle = derivePrTitle(options?.run_intent, rawTitle);

    const issueFromOptions = options?.issue_number ?? null;
    const issueRaw = extractFrontmatterField(specContent, 'issue');
    const issueFromFrontmatter = issueRaw !== null ? parseInt(issueRaw, 10) : null;
    const issueForBody = issueFromOptions !== null
      ? issueFromOptions
      : (issueFromFrontmatter !== null && !isNaN(issueFromFrontmatter) ? issueFromFrontmatter : null);

    const prBody = buildPrBody(spec_path, issueForBody, options);

    // Push the branch
    try {
      await this.execFn('git', ['push', 'origin', branch], { cwd: workspace_path });
    } catch (err) {
      this.logger.error(
        { event: 'pr.creation_failed', error: String(err), step: 'push', branch },
        'git push failed',
      );
      throw new Error(`git push failed: ${String(err)}`);
    }

    // Create the PR
    let prUrl: string;
    try {
      const { stdout } = await this.execFn(
        'gh',
        ['pr', 'create', '--head', branch, '--title', prTitle, '--body', prBody],
        { cwd: workspace_path },
      );
      prUrl = stdout.trim();
    } catch (err) {
      this.logger.error(
        { event: 'pr.creation_failed', error: String(err), step: 'pr_create', branch },
        'gh pr create failed',
      );
      throw new Error(`gh pr create failed: ${String(err)}`);
    }

    this.logger.info(
      { event: 'pr.created', pr_url: prUrl, branch, spec_title: rawTitle },
      'PR created',
    );
    return prUrl;
  }

  async mergePR(workspace_path: string, pr_url: string): Promise<void> {
    try {
      await this.execFn(
        'gh',
        ['pr', 'merge', pr_url, '--squash', '--delete-branch'],
        { cwd: workspace_path },
      );
    } catch (err) {
      const errStr = String(err);
      this.logger.error(
        { event: 'pr.merge_failed', error: errStr, pr_url, workspace_path },
        'gh pr merge failed',
      );
      throw new Error(`gh pr merge failed: ${errStr}`);
    }

    this.logger.info(
      { event: 'pr.merged', pr_url, workspace_path },
      'PR merged',
    );
  }
}
