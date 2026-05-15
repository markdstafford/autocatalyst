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

describe('GHIssueManager.getIssue', () => {
  it('parses a successful gh issue view JSON response into a TrackedIssue', async () => {
    const ghResponse = JSON.stringify({
      number: 42,
      title: 'Intent classifier misidentifies work-on-issue messages',
      body: "When the user says \"let's work on issue 42\", it routes to file_issues instead.",
      labels: [{ name: 'bug' }, { name: 'P2: medium' }],
      state: 'OPEN',
      url: 'https://github.com/org/repo/issues/42',
    });
    const execFn = vi.fn().mockResolvedValue({ stdout: ghResponse, stderr: '' });
    const manager = new GHIssueManager({ execFn, logDestination: nullDest });

    const issue = await manager.getIssue('https://github.com/org/repo.git', 42);

    expect(issue).toEqual({
      number: 42,
      title: 'Intent classifier misidentifies work-on-issue messages',
      body: "When the user says \"let's work on issue 42\", it routes to file_issues instead.",
      labels: ['bug', 'P2: medium'],
      state: 'OPEN',
      url: 'https://github.com/org/repo/issues/42',
    });
    expect(execFn).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '42', '--repo', 'https://github.com/org/repo.git', '--json', 'number,title,body,labels,state,url'],
      {},
    );
  });

  it('handles issues with no labels', async () => {
    const ghResponse = JSON.stringify({
      number: 7,
      title: 'Unlabeled issue',
      body: 'body text',
      labels: [],
      state: 'OPEN',
      url: 'https://github.com/org/repo/issues/7',
    });
    const execFn = vi.fn().mockResolvedValue({ stdout: ghResponse, stderr: '' });
    const manager = new GHIssueManager({ execFn, logDestination: nullDest });

    const issue = await manager.getIssue('/repo', 7);
    expect(issue.labels).toEqual([]);
  });

  it('throws a clear error when gh fails', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('gh: not found'));
    const manager = new GHIssueManager({ execFn, logDestination: nullDest });

    await expect(manager.getIssue('/repo', 42)).rejects.toThrow('gh issue view failed');
  });

  it('throws a clear error when the response is not valid JSON', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    const manager = new GHIssueManager({ execFn, logDestination: nullDest });

    await expect(manager.getIssue('/repo', 42)).rejects.toThrow();
  });
});
