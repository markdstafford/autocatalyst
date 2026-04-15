import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { SpecPublisher } from '../slack/canvas-publisher.js';
import { stripCommentSpans, prettifyMarkdown } from './markdown-diff.js';

const defaultExecFile = promisify(_execFile);

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface SpecCommitter {
  commit(
    workspace_path: string,
    publisher_ref: string,
    spec_path: string,
  ): Promise<void>;
}

interface NotionSpecCommitterOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

function normalizeFrontmatter(markdown: string): string {
  const delim = '---';
  const start = markdown.indexOf(delim);
  if (start === -1) throw new Error('Spec has no YAML frontmatter (missing --- delimiters)');
  const end = markdown.indexOf(delim, start + 3);
  if (end === -1) throw new Error('Spec has no YAML frontmatter (missing closing --- delimiter)');

  const frontmatterRaw = markdown.slice(start + 3, end);
  const body = markdown.slice(end + 3);

  const today = new Date().toISOString().slice(0, 10);

  // Update fields line-by-line to preserve all other fields
  const lines = frontmatterRaw.split('\n');
  const normalized = lines.map(line => {
    if (/^status\s*:/.test(line)) return `status: approved`;
    if (/^last_updated\s*:/.test(line)) return `last_updated: ${today}`;
    return line;
  });

  return `---${normalized.join('\n')}---${body}`;
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'spec';
}

export class NotionSpecCommitter implements SpecCommitter {
  private readonly publisher: SpecPublisher;
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(publisher: SpecPublisher, execFn?: ExecFn, options?: NotionSpecCommitterOptions) {
    this.publisher = publisher;
    this.execFn = execFn ?? defaultExecFile;
    this.logger = createLogger('spec-committer', { destination: options?.logDestination });
  }

  async commit(workspace_path: string, publisher_ref: string, spec_path: string): Promise<void> {
    let raw: string;
    try {
      raw = await this.publisher.getPageMarkdown(publisher_ref);
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publisher_ref, step: 'fetch' },
        'Failed to fetch markdown from Notion',
      );
      throw err;
    }

    if (!raw || !raw.trim()) {
      const error = 'Notion page has no content';
      this.logger.error(
        { event: 'spec.commit_failed', error, publisher_ref, step: 'validate' },
        error,
      );
      throw new Error(error);
    }

    // Validate frontmatter present before doing any transforms
    if (!raw.trimStart().startsWith('---')) {
      const error = 'Spec has no YAML frontmatter (missing --- delimiters)';
      this.logger.error(
        { event: 'spec.commit_failed', error, publisher_ref, step: 'validate' },
        error,
      );
      throw new Error(error);
    }

    let processed: string;
    try {
      // Strip comment spans, remove orphaned comments, prettify
      processed = prettifyMarkdown(stripCommentSpans(raw));
      // Normalize frontmatter
      processed = normalizeFrontmatter(processed);
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publisher_ref, step: 'transform' },
        'Failed to transform spec markdown',
      );
      throw err;
    }

    // Write file — create parent dirs if needed
    mkdirSync(dirname(spec_path), { recursive: true });
    writeFileSync(spec_path, processed, 'utf-8');

    const title = extractTitle(processed);

    try {
      await this.execFn('git', ['add', spec_path], { cwd: workspace_path });
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publisher_ref, step: 'git_add' },
        'git add failed',
      );
      throw err;
    }

    // Skip commit if nothing was staged (spec already committed and unchanged)
    try {
      await this.execFn('git', ['diff', '--cached', '--quiet'], { cwd: workspace_path });
      this.logger.info(
        { event: 'spec.committed', publisher_ref, spec_path, workspace_path, skipped: true },
        'Spec already committed — skipping git commit',
      );
      return;
    } catch {
      // non-zero exit means there are staged changes — proceed with commit
    }

    try {
      await this.execFn('git', ['commit', '-m', `docs: commit approved spec — ${title}`], { cwd: workspace_path });
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publisher_ref, step: 'git_commit' },
        'git commit failed',
      );
      throw err;
    }

    this.logger.info(
      { event: 'spec.committed', publisher_ref, spec_path, workspace_path },
      'Spec committed to workspace',
    );
  }
}
