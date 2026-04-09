import { promisify } from 'node:util';
import { exec as _exec } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from './logger.js';

const defaultExec = promisify(_exec);

type ExecFn = (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface WorkspaceManager {
  create(idea_id: string, repo_url: string): Promise<{ workspace_path: string; branch: string }>;
  destroy(workspace_path: string): Promise<void>;
}

interface WorkspaceManagerOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

export class WorkspaceManagerImpl implements WorkspaceManager {
  private readonly workspaceRoot: string;
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(workspaceRoot: string, options?: WorkspaceManagerOptions) {
    this.workspaceRoot = workspaceRoot;
    this.execFn = options?.execFn ?? defaultExec;
    this.logger = createLogger('workspace-manager', { destination: options?.logDestination });
  }

  async create(idea_id: string, repo_url: string): Promise<{ workspace_path: string; branch: string }> {
    const workspace_path = join(this.workspaceRoot, idea_id);
    const slug = idea_id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const branch = `spec/${slug}`;

    // Clone
    try {
      await this.execFn(`git clone --depth=1 ${repo_url} ${workspace_path}`);
    } catch (err) {
      // Clean up partially-created directory if present
      try { rmSync(workspace_path, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`git clone failed: ${String(err)}`);
    }

    // Create branch
    try {
      await this.execFn(`git checkout -b ${branch}`, { cwd: workspace_path });
    } catch (err) {
      throw new Error(`git checkout -b failed: ${String(err)}`);
    }

    this.logger.info({ event: 'workspace.created', idea_id, workspace_path, branch }, 'Workspace created');
    return { workspace_path, branch };
  }

  async destroy(workspace_path: string): Promise<void> {
    rmSync(workspace_path, { recursive: true, force: true });
    this.logger.info({ event: 'workspace.destroyed', workspace_path }, 'Workspace destroyed');
  }
}
