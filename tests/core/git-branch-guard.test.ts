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
