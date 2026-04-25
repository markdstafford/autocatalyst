import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { SpecCommitter, SpecLifecycleStatus } from '../../core/spec-committer.js';
import type { ArtifactContentSource } from '../../types/publisher.js';
import { stripCommentSpans, prettifyMarkdown } from './markdown-diff.js';

const defaultExecFile = promisify(_execFile);

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

interface NotionSpecCommitterOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

function normalizeFrontmatter(markdown: string, implementedBy: string | null): string {
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
    if (/^status\s*:/.test(line)) return `status: implementing`;
    if (/^last_updated\s*:/.test(line)) return `last_updated: ${today}`;
    if (/^implemented_by\s*:/.test(line)) {
      return implementedBy !== null ? `implemented_by: ${implementedBy}` : `implemented_by: null`;
    }
    return line;
  });

  return `---${normalized.join('\n')}---${body}`;
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'spec';
}

export class NotionSpecCommitter implements SpecCommitter {
  private readonly contentSource: ArtifactContentSource;
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(contentSource: ArtifactContentSource, execFn?: ExecFn, options?: NotionSpecCommitterOptions) {
    this.contentSource = contentSource;
    this.execFn = execFn ?? defaultExecFile;
    this.logger = createLogger('spec-committer', { destination: options?.logDestination });
  }

  async commit(workspace_path: string, publication_ref: string, artifact_path: string): Promise<void> {
    let raw: string;
    try {
      raw = await this.contentSource.getContent(publication_ref, true);
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publication_ref, step: 'fetch' },
        'Failed to fetch markdown from Notion',
      );
      throw err;
    }

    if (!raw || !raw.trim()) {
      const error = 'Notion page has no content';
      this.logger.error(
        { event: 'spec.commit_failed', error, publication_ref, step: 'validate' },
        error,
      );
      throw new Error(error);
    }

    // Validate frontmatter present before doing any transforms
    if (!raw.trimStart().startsWith('---')) {
      const error = 'Spec has no YAML frontmatter (missing --- delimiters)';
      this.logger.error(
        { event: 'spec.commit_failed', error, publication_ref, step: 'validate' },
        error,
      );
      throw new Error(error);
    }

    let processed: string;
    try {
      // Strip comment spans, remove orphaned comments, prettify
      processed = prettifyMarkdown(stripCommentSpans(raw));
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publication_ref, step: 'transform' },
        'Failed to transform spec markdown',
      );
      throw err;
    }

    // Fetch GitHub username for implemented_by
    let implementedBy: string | null = null;
    try {
      const { stdout } = await this.execFn('gh', ['api', 'user', '-q', '.login'], { cwd: workspace_path });
      implementedBy = stdout.trim() || null;
    } catch (err) {
      this.logger.warn(
        { event: 'spec.implemented_by_fetch_failed', error: String(err), publication_ref },
        'Failed to fetch GitHub username for implemented_by; setting to null',
      );
    }

    // Normalize frontmatter (status: implementing, implemented_by, last_updated)
    try {
      processed = normalizeFrontmatter(processed, implementedBy);
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publication_ref, step: 'transform' },
        'Failed to normalize spec frontmatter',
      );
      throw err;
    }

    // Write file — create parent dirs if needed
    mkdirSync(dirname(artifact_path), { recursive: true });
    writeFileSync(artifact_path, processed, 'utf-8');

    const title = extractTitle(processed);

    try {
      await this.execFn('git', ['add', artifact_path], { cwd: workspace_path });
    } catch (err) {
      this.logger.error(
        { event: 'spec.commit_failed', error: String(err), publication_ref, step: 'git_add' },
        'git add failed',
      );
      throw err;
    }

    // Skip commit if nothing was staged (spec already committed and unchanged)
    try {
      await this.execFn('git', ['diff', '--cached', '--quiet'], { cwd: workspace_path });
      this.logger.info(
        { event: 'spec.committed', publication_ref, artifact_path, workspace_path, skipped: true },
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
        { event: 'spec.commit_failed', error: String(err), publication_ref, step: 'git_commit' },
        'git commit failed',
      );
      throw err;
    }

    this.logger.info(
      { event: 'spec.committed', publication_ref, artifact_path, workspace_path },
      'Spec committed to workspace',
    );
  }

  async updateStatus(
    workspace_path: string,
    artifact_path: string,
    update: { status: SpecLifecycleStatus; last_updated: string },
  ): Promise<void> {
    let content: string;
    try {
      content = readFileSync(artifact_path, 'utf-8');
    } catch (err) {
      const msg = `Spec file not found: ${artifact_path}`;
      this.logger.error(
        { event: 'spec.status_update_failed', error: msg, artifact_path, workspace_path },
        msg,
      );
      throw new Error(msg);
    }

    // Patch frontmatter: update status and last_updated, preserve all other fields
    const delim = '---';
    const start = content.indexOf(delim);
    const end = content.indexOf(delim, start + 3);
    if (start === -1 || end === -1) {
      const msg = `Spec has no YAML frontmatter: ${artifact_path}`;
      this.logger.error(
        { event: 'spec.status_update_failed', error: msg, artifact_path, workspace_path },
        msg,
      );
      throw new Error(msg);
    }

    const frontmatterRaw = content.slice(start + 3, end);
    const body = content.slice(end + 3);

    const lines = frontmatterRaw.split('\n');
    const patched = lines.map(line => {
      if (/^status\s*:/.test(line)) return `status: ${update.status}`;
      if (/^last_updated\s*:/.test(line)) return `last_updated: ${update.last_updated}`;
      return line;
    });
    const newContent = `---${patched.join('\n')}---${body}`;

    writeFileSync(artifact_path, newContent, 'utf-8');

    const title = extractTitle(newContent);

    try {
      await this.execFn('git', ['add', artifact_path], { cwd: workspace_path });
    } catch (err) {
      this.logger.error(
        { event: 'spec.status_update_failed', error: String(err), artifact_path, workspace_path, step: 'git_add' },
        'git add failed in updateStatus',
      );
      throw err;
    }

    try {
      await this.execFn(
        'git',
        ['commit', '-m', `docs: update spec status — ${title} (${update.status})`],
        { cwd: workspace_path },
      );
    } catch (err) {
      this.logger.error(
        { event: 'spec.status_update_failed', error: String(err), artifact_path, workspace_path, step: 'git_commit' },
        'git commit failed in updateStatus',
      );
      throw err;
    }

    this.logger.info(
      { event: 'spec.status_updated', artifact_path, workspace_path, status: update.status, last_updated: update.last_updated },
      'Spec status updated',
    );
  }
}
