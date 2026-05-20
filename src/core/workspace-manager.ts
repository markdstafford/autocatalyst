import { execFile as _execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import { createLogger } from './logger.js';

function defaultExec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    _execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err) { reject(err); } else { resolve({ stdout, stderr }); }
    });
  });
}

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface WorkspaceManager {
  create(request_id: string, repo_url: string, workspace_root: string): Promise<{ workspace_path: string; branch: string }>;
  destroy(workspace_path: string): Promise<void>;
}

interface WorkspaceManagerOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

export class WorkspaceManagerImpl implements WorkspaceManager {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(options?: WorkspaceManagerOptions) {
    this.execFn = options?.execFn ?? defaultExec;
    this.logger = createLogger('workspace-manager', { destination: options?.logDestination });
  }

  async create(request_id: string, repo_url: string, workspace_root: string): Promise<{ workspace_path: string; branch: string }> {
    if (request_id.includes('/') || request_id.includes('..')) {
      throw new Error(`Invalid request_id: "${request_id}"`);
    }
    const expandedRoot = workspace_root.replace(/^~/, homedir());
    const workspace_path = join(expandedRoot, request_id);
    // request_id is a UUID; strip non-alphanumeric chars for a valid branch name segment
    const slug = request_id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const branch = `spec/${slug}`;

    // Clone
    const cloneStart = performance.now();
    try {
      await this.execFn('git', ['clone', '--depth=1', repo_url, workspace_path]);
      this.logger.info(
        { event: 'workspace.cloned', request_id, workspace_path, duration_ms: Math.round(performance.now() - cloneStart) },
        'Workspace cloned',
      );
    } catch (err) {
      this.logger.error(
        { event: 'workspace.clone_failed', request_id, workspace_path, duration_ms: Math.round(performance.now() - cloneStart), error: String(err) },
        'Workspace clone failed',
      );
      // Clean up partially-created directory if present
      try { rmSync(workspace_path, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`git clone failed`, { cause: err });
    }

    // Create branch
    const checkoutStart = performance.now();
    try {
      await this.execFn('git', ['checkout', '-b', branch], { cwd: workspace_path });
      this.logger.info(
        { event: 'workspace.checked_out', request_id, workspace_path, branch, duration_ms: Math.round(performance.now() - checkoutStart) },
        'Workspace branch checked out',
      );
    } catch (err) {
      this.logger.error(
        { event: 'workspace.checkout_failed', request_id, workspace_path, branch, duration_ms: Math.round(performance.now() - checkoutStart), error: String(err) },
        'Workspace checkout failed',
      );
      // Clean up cloned directory if present
      try { rmSync(workspace_path, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`git checkout -b failed`, { cause: err });
    }

    this.logger.info({ event: 'workspace.created', request_id, workspace_path, branch }, 'Workspace created');
    return { workspace_path, branch };
  }

  async destroy(workspace_path: string): Promise<void> {
    const start = performance.now();
    try {
      rmSync(workspace_path, { recursive: true, force: true });
      this.logger.info(
        { event: 'workspace.destroyed', workspace_path, duration_ms: Math.round(performance.now() - start) },
        'Workspace destroyed',
      );
    } catch (err) {
      this.logger.error(
        { event: 'workspace.destroy_failed', workspace_path, duration_ms: Math.round(performance.now() - start), error: String(err) },
        'Workspace destroy failed',
      );
      throw err;
    }
  }
}
