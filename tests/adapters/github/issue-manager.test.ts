import { describe, expect, it, vi } from 'vitest';
import { GHIssueManager } from '../../../src/adapters/github/issue-manager.js';

const nullDest = { write: () => {} };

describe('GHIssueManager', () => {
  it('creates an issue without labels through the unified create API', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: 'https://github.com/org/repo/issues/42\n', stderr: '' });
    const manager = new GHIssueManager({ execFn, logDestination: nullDest });

    await expect(manager.create('/repo', 'Title', 'Body')).resolves.toEqual({ number: 42 });

    expect(execFn).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--title', 'Title', '--body', 'Body'],
      { cwd: '/repo' },
    );
  });

  it('adds labels when provided through the unified create API', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: 'https://github.com/org/repo/issues/43\n', stderr: '' });
    const manager = new GHIssueManager({ execFn, logDestination: nullDest });

    await expect(manager.create('/repo', 'Title', 'Body', ['bug', 'urgent'])).resolves.toEqual({ number: 43 });

    expect(execFn).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--title', 'Title', '--body', 'Body', '--label', 'bug', '--label', 'urgent'],
      { cwd: '/repo' },
    );
  });
});
