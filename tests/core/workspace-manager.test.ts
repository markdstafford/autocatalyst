import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManagerImpl } from '../../src/core/workspace-manager.js';

const nullDest = { write: () => {} };

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wm-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('WorkspaceManager.create', () => {
  it('runs git clone with --depth=1 and correct path', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    await wm.create('idea-abc', 'https://github.com/org/repo.git', tempRoot);

    const cloneCall = execFn.mock.calls[0];
    expect(cloneCall[0]).toBe('git');
    expect(cloneCall[1]).toContain('clone');
    expect(cloneCall[1]).toContain('--depth=1');
    expect(cloneCall[1]).toContain('https://github.com/org/repo.git');
    expect(cloneCall[1]).toContain(join(tempRoot, 'idea-abc'));
  });

  it('passes workspace_path as a single argument (not embedded in a shell string)', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    await wm.create('idea-abc', 'https://github.com/org/repo.git', tempRoot);

    const cloneArgs: string[] = execFn.mock.calls[0][1];
    // The workspace path must appear as its own element, never concatenated with quotes or other text
    const workspacePath = join(tempRoot, 'idea-abc');
    expect(cloneArgs).toContain(workspacePath);
    expect(cloneArgs.some(a => a.includes('"') && a.includes(workspacePath))).toBe(false);
  });

  it('runs git checkout -b after clone with correct branch and cwd', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    await wm.create('idea-abc', 'https://github.com/org/repo.git', tempRoot);

    expect(execFn).toHaveBeenCalledTimes(2);
    const checkoutCall = execFn.mock.calls[1];
    expect(checkoutCall[0]).toBe('git');
    expect(checkoutCall[1]).toEqual(['checkout', '-b', expect.stringMatching(/^spec\//)]);
    expect(checkoutCall[2]).toEqual({ cwd: join(tempRoot, 'idea-abc') });
  });

  it('returns workspace_path and branch', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    const result = await wm.create('idea-abc', 'https://github.com/org/repo.git', tempRoot);

    expect(result.workspace_path).toBe(join(tempRoot, 'idea-abc'));
    expect(result.branch).toMatch(/^spec\//);
  });

  it('throws and removes directory if git clone fails', async () => {
    const execFn = vi.fn()
      .mockRejectedValueOnce(new Error('clone failed'))
      .mockResolvedValue({ stdout: '', stderr: '' });
    // Pre-create the directory to simulate partial clone
    mkdirSync(join(tempRoot, 'idea-fail'), { recursive: true });

    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    const { existsSync } = await import('node:fs');
    expect(existsSync(join(tempRoot, 'idea-fail'))).toBe(true); // confirm dir exists before create
    await expect(wm.create('idea-fail', 'https://github.com/org/repo.git', tempRoot)).rejects.toThrow('git clone failed');

    // Verify cleanup occurred
    expect(existsSync(join(tempRoot, 'idea-fail'))).toBe(false);
  });

  it('throws and removes directory if git checkout -b fails', async () => {
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // clone succeeds
      .mockRejectedValueOnce(new Error('checkout failed')); // checkout fails
    // Pre-create directory to simulate what clone would have done
    mkdirSync(join(tempRoot, 'idea-xyz'), { recursive: true });

    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    const { existsSync } = await import('node:fs');
    expect(existsSync(join(tempRoot, 'idea-xyz'))).toBe(true); // confirm dir exists before create
    await expect(wm.create('idea-xyz', 'https://github.com/org/repo.git', tempRoot)).rejects.toThrow('git checkout -b failed');

    expect(existsSync(join(tempRoot, 'idea-xyz'))).toBe(false);
  });

  it('two requests with different request_ids produce non-overlapping paths', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    const r1 = await wm.create('idea-111', 'https://github.com/org/repo.git', tempRoot);
    const r2 = await wm.create('idea-222', 'https://github.com/org/repo.git', tempRoot);

    expect(r1.workspace_path).not.toBe(r2.workspace_path);
  });

  it('throws on invalid request_id containing path separator', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    await expect(wm.create('req/evil', 'https://github.com/org/repo.git', tempRoot)).rejects.toThrow(/Invalid request_id/);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('throws on invalid request_id containing dot-dot traversal', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    await expect(wm.create('req..evil', 'https://github.com/org/repo.git', tempRoot)).rejects.toThrow(/Invalid request_id/);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('two calls with different workspace_root values produce non-overlapping paths', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    const root1 = mkdtempSync(join(tmpdir(), 'wm-root1-'));
    const root2 = mkdtempSync(join(tmpdir(), 'wm-root2-'));
    try {
      const r1 = await wm.create('idea-same', 'https://github.com/org/repo.git', root1);
      const r2 = await wm.create('idea-same', 'https://github.com/org/repo.git', root2);
      expect(r1.workspace_path).not.toBe(r2.workspace_path);
      expect(r1.workspace_path).toContain(root1);
      expect(r2.workspace_path).toContain(root2);
    } finally {
      rmSync(root1, { recursive: true, force: true });
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it('preserves a Windows-style workspace root as a single argument without shell quoting', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    // Simulate a Windows-style path by passing it as workspace_root.
    // The ~ expansion won't apply because the path doesn't start with ~.
    // We call create directly so we can inspect the args without running real git.
    const windowsRoot = 'C:\\Users\\mark\\.autocatalyst\\workspaces';
    await wm.create('idea-win', 'https://github.com/org/repo.git', windowsRoot);

    const cloneArgs: string[] = execFn.mock.calls[0][1];
    // workspace_path should be the last arg and must be a plain string (no embedded quotes)
    const workspacePath = cloneArgs[cloneArgs.length - 1];
    expect(workspacePath).toContain('idea-win');
    expect(workspacePath).not.toMatch(/^".*"$/); // not wrapped in double-quotes
    expect(cloneArgs.some(a => a.startsWith('"') || a.endsWith('"'))).toBe(false);
  });
});

describe('WorkspaceManager telemetry', () => {
  it('logs workspace.cloned with duration_ms', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: dest });

    await wm.create('idea-telem', 'https://github.com/org/repo.git', tempRoot);
    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const cloned = parsed.find(l => l.event === 'workspace.cloned');
    expect(cloned).toBeDefined();
    expect(typeof cloned.duration_ms).toBe('number');
    expect(cloned.request_id).toBe('idea-telem');

    const checkedOut = parsed.find(l => l.event === 'workspace.checked_out');
    expect(checkedOut).toBeDefined();
    expect(typeof checkedOut.duration_ms).toBe('number');
  });

  it('logs workspace.clone_failed on git error', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    const execFn = vi.fn().mockRejectedValueOnce(new Error('clone failed'));
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: dest });

    await expect(wm.create('idea-fail2', 'https://github.com/org/repo.git', tempRoot)).rejects.toThrow('git clone failed');
    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const failed = parsed.find(l => l.event === 'workspace.clone_failed');
    expect(failed).toBeDefined();
    expect(typeof failed.duration_ms).toBe('number');
    expect(failed.error).toContain('clone failed');
  });
});

describe('WorkspaceManager.destroy', () => {
  it('removes the workspace directory recursively', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl({ execFn, logDestination: nullDest });

    // Create a real directory to destroy
    const wsPath = join(tempRoot, 'to-destroy');
    mkdirSync(wsPath, { recursive: true });

    await wm.destroy(wsPath);

    const { existsSync } = await import('node:fs');
    expect(existsSync(wsPath)).toBe(false);
  });
});
