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
    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    await wm.create('idea-abc', 'https://github.com/org/repo.git');

    expect(execFn).toHaveBeenCalledWith(
      expect.stringContaining('git clone --depth=1'),
    );
    expect(execFn).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/org/repo.git'),
    );
    const cloneCall = execFn.mock.calls[0][0] as string;
    expect(cloneCall).toContain(join(tempRoot, 'idea-abc'));
  });

  it('runs git checkout -b after clone with correct branch and cwd', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    await wm.create('idea-abc', 'https://github.com/org/repo.git');

    expect(execFn).toHaveBeenCalledTimes(2);
    const checkoutCall = execFn.mock.calls[1];
    expect(checkoutCall[0]).toMatch(/^git checkout -b "?spec\//);
    expect(checkoutCall[1]).toEqual({ cwd: join(tempRoot, 'idea-abc') });
  });

  it('returns workspace_path and branch', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    const result = await wm.create('idea-abc', 'https://github.com/org/repo.git');

    expect(result.workspace_path).toBe(join(tempRoot, 'idea-abc'));
    expect(result.branch).toMatch(/^spec\//);
  });

  it('throws and removes directory if git clone fails', async () => {
    const execFn = vi.fn()
      .mockRejectedValueOnce(new Error('clone failed'))
      .mockResolvedValue({ stdout: '', stderr: '' });
    // Pre-create the directory to simulate partial clone
    mkdirSync(join(tempRoot, 'idea-fail'), { recursive: true });

    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    await expect(wm.create('idea-fail', 'https://github.com/org/repo.git')).rejects.toThrow('git clone failed');

    // Verify cleanup occurred
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(tempRoot, 'idea-fail'))).toBe(false);
  });

  it('throws if git checkout -b fails', async () => {
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // clone succeeds
      .mockRejectedValueOnce(new Error('checkout failed')); // checkout fails

    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    await expect(wm.create('idea-xyz', 'https://github.com/org/repo.git')).rejects.toThrow('git checkout -b failed');
  });

  it('two ideas with different idea_ids produce non-overlapping paths', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    const r1 = await wm.create('idea-111', 'https://github.com/org/repo.git');
    const r2 = await wm.create('idea-222', 'https://github.com/org/repo.git');

    expect(r1.workspace_path).not.toBe(r2.workspace_path);
  });

  it('throws on invalid idea_id containing path separator', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    await expect(wm.create('idea/evil', 'https://github.com/org/repo.git')).rejects.toThrow(/Invalid idea_id/);
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe('WorkspaceManager.destroy', () => {
  it('removes the workspace directory recursively', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const wm = new WorkspaceManagerImpl(tempRoot, { execFn, logDestination: nullDest });

    // Create a real directory to destroy
    const wsPath = join(tempRoot, 'to-destroy');
    mkdirSync(wsPath, { recursive: true });

    await wm.destroy(wsPath);

    const { existsSync } = await import('node:fs');
    expect(existsSync(wsPath)).toBe(false);
  });
});
