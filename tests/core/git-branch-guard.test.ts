import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { GitBranchGuard } from '../../src/core/git-branch-guard.js';

describe('GitBranchGuard', () => {
  it('resolves when current branch matches expected', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: 'spec/abc-123\n', stderr: '' });
    const guard = new GitBranchGuard({ execFn });

    await expect(guard.check('/ws/abc-123', 'spec/abc-123')).resolves.toBeUndefined();
    expect(execFn).toHaveBeenCalledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: '/ws/abc-123' });
  });

  it('throws with a descriptive message when the branch has drifted', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: 'feat/debug-mode-slack\n', stderr: '' });
    const guard = new GitBranchGuard({ execFn });

    await expect(guard.check('/ws/abc-123', 'spec/abc-123')).rejects.toThrow(
      'Agent changed branches from spec/abc-123 to feat/debug-mode-slack. Autocatalyst owns run branches; this run cannot continue safely.',
    );
  });

  it('throws when git command fails', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('git not found'));
    const guard = new GitBranchGuard({ execFn });

    await expect(guard.check('/ws/abc-123', 'spec/abc-123')).rejects.toThrow('Branch check failed');
  });
});

describe('GitBranchGuard telemetry', () => {
  it('logs branch_guard.checked with outcome:allowed', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    const guard = new GitBranchGuard({
      execFn: async () => ({ stdout: 'spec/my-branch\n', stderr: '' }),
      logDestination: dest,
    });
    await guard.check('/workspace', 'spec/my-branch');
    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const checked = parsed.find(l => l.event === 'branch_guard.checked');
    expect(checked).toBeDefined();
    expect(checked.outcome).toBe('allowed');
    expect(checked.expected_branch).toBe('spec/my-branch');
    expect(checked.actual_branch).toBe('spec/my-branch');
  });

  it('logs outcome:blocked before throwing', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    const guard = new GitBranchGuard({
      execFn: async () => ({ stdout: 'main\n', stderr: '' }),
      logDestination: dest,
    });
    await expect(guard.check('/workspace', 'spec/my-branch')).rejects.toThrow();
    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const checked = parsed.find(l => l.event === 'branch_guard.checked');
    expect(checked?.outcome).toBe('blocked');
  });
});
