import { promisify } from 'node:util';
import { exec as _exec } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type pino from 'pino';
import { createLogger } from './logger.js';

const defaultExec = promisify(_exec);

type ExecFn = (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

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
    try {
      await this.execFn(`git clone --depth=1 "${repo_url}" "${workspace_path}"`);
    } catch (err) {
      // Clean up partially-created directory if present
      try { rmSync(workspace_path, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`git clone failed`, { cause: err });
    }

    // Create branch
    try {
      await this.execFn(`git checkout -b "${branch}"`, { cwd: workspace_path });
    } catch (err) {
      // Clean up cloned directory if present
      try { rmSync(workspace_path, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`git checkout -b failed`, { cause: err });
    }

    this.logger.info({ event: 'workspace.created', request_id, workspace_path, branch }, 'Workspace created');
    return { workspace_path, branch };
  }

  async destroy(workspace_path: string): Promise<void> {
    rmSync(workspace_path, { recursive: true, force: true });
    this.logger.info({ event: 'workspace.destroyed', workspace_path }, 'Workspace destroyed');
  }
}
