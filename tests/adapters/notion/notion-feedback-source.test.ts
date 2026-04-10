// tests/adapters/notion/notion-feedback-source.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';
import { NotionFeedbackSource } from '../../../src/adapters/notion/notion-feedback-source.js';

const nullDest = { write: () => {} };

function makeMockClient(): NotionClient {
  return {
    pages: { create: vi.fn() },
    blocks: {
      children: { list: vi.fn(), append: vi.fn() },
      delete: vi.fn(),
    },
    comments: {
      list: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeComment(overrides: {
  id?: string;
  discussion_id?: string;
  resolved?: boolean;
  rich_text?: Array<{ plain_text: string }>;
  created_by?: { id: string; name?: string };
} = {}) {
  return {
    id: overrides.id ?? 'comment-1',
    discussion_id: overrides.discussion_id ?? 'disc-1',
    resolved: overrides.resolved ?? false,
    rich_text: overrides.rich_text ?? [{ plain_text: 'some feedback' }],
    created_by: overrides.created_by ?? { id: 'user-1', name: 'Phoebe' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotionFeedbackSource.fetch', () => {
  it('returns only unresolved threads; resolved threads excluded', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        makeComment({ discussion_id: 'disc-1', resolved: false }),
        makeComment({ discussion_id: 'disc-2', resolved: true }),
      ],
    });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('disc-1');
  });

  it('returns empty array when all threads are resolved', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [makeComment({ resolved: true })],
    });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toEqual([]);
  });

  it('returns empty array when there are no threads', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ results: [] });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    expect(await source.fetch('page-abc')).toEqual([]);
  });

  it('single-comment thread: body is "{name}: {text}"', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [makeComment({ discussion_id: 'disc-1', rich_text: [{ plain_text: 'use inline flow' }], created_by: { id: 'u1', name: 'Phoebe' } })],
    });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result[0].body).toBe('Phoebe: use inline flow');
  });

  it('multi-comment thread (3 comments from 2 authors): concatenates with newline in order', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        makeComment({ id: 'c1', discussion_id: 'disc-1', rich_text: [{ plain_text: 'first comment' }], created_by: { id: 'u1', name: 'Phoebe' } }),
        makeComment({ id: 'c2', discussion_id: 'disc-1', rich_text: [{ plain_text: 'reply to first' }], created_by: { id: 'u2', name: 'Enzo' } }),
        makeComment({ id: 'c3', discussion_id: 'disc-1', rich_text: [{ plain_text: 'follow up' }], created_by: { id: 'u1', name: 'Phoebe' } }),
      ],
    });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('Phoebe: first comment\nEnzo: reply to first\nPhoebe: follow up');
  });

  it('falls back to created_by.id when name is absent', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [makeComment({ rich_text: [{ plain_text: 'anon feedback' }], created_by: { id: 'user-anon-id' } })],
    });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result[0].body).toBe('user-anon-id: anon feedback');
  });

  it('returns discussion_id as id, not individual comment id', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [makeComment({ id: 'comment-id-xyz', discussion_id: 'disc-id-abc' })],
    });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result[0].id).toBe('disc-id-abc');
    expect(result[0].id).not.toBe('comment-id-xyz');
  });

  it('multiple open threads: returns one entry per thread', async () => {
    const client = makeMockClient();
    (client.comments.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        makeComment({ id: 'c1', discussion_id: 'disc-1', resolved: false }),
        makeComment({ id: 'c2', discussion_id: 'disc-2', resolved: false }),
      ],
    });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toEqual(['disc-1', 'disc-2']);
  });
});

describe('NotionFeedbackSource.reply', () => {
  it('calls comments.create with discussion_id and rich_text', async () => {
    const client = makeMockClient();
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    await source.reply('page-abc', 'disc-123', 'Updated: inline flow applied');

    expect(client.comments.create).toHaveBeenCalledWith({
      discussion_id: 'disc-123',
      rich_text: [{ type: 'text', text: { content: 'Updated: inline flow applied' } }],
    });
  });

  it('throws if comments.create rejects', async () => {
    const client = makeMockClient();
    (client.comments.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('create error'));
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    await expect(source.reply('page-abc', 'disc-123', 'response')).rejects.toThrow('create error');
  });
});

describe('NotionFeedbackSource.resolve', () => {
  it('calls comments.update once per ID', async () => {
    const client = makeMockClient();
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    await source.resolve('page-abc', ['disc-1', 'disc-2', 'disc-3']);

    expect(client.comments.update).toHaveBeenCalledTimes(3);
    expect(client.comments.update).toHaveBeenCalledWith('disc-1');
    expect(client.comments.update).toHaveBeenCalledWith('disc-2');
    expect(client.comments.update).toHaveBeenCalledWith('disc-3');
  });

  it('empty array: no API calls made', async () => {
    const client = makeMockClient();
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    await source.resolve('page-abc', []);

    expect(client.comments.update).not.toHaveBeenCalled();
  });

  it('404 on one ID: logs notion_comments.resolve_skipped, does not throw, continues processing remaining IDs', async () => {
    const client = makeMockClient();
    (client.comments.update as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)        // disc-1 succeeds
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))  // disc-2 fails
      .mockResolvedValueOnce(undefined);        // disc-3 succeeds
    const logLines: unknown[] = [];
    const dest = { write: (line: string) => logLines.push(JSON.parse(line)) };
    const source = new NotionFeedbackSource(client, { logDestination: dest });

    await expect(source.resolve('page-abc', ['disc-1', 'disc-2', 'disc-3'])).resolves.toBeUndefined();

    expect(client.comments.update).toHaveBeenCalledTimes(3);
    const warnLog = logLines.find((l: unknown) => (l as { event?: string }).event === 'notion_comments.resolve_skipped');
    expect(warnLog).toBeDefined();
    expect((warnLog as { comment_id?: string }).comment_id).toBe('disc-2');
  });

  it('405 on one ID: same warn-and-continue behavior', async () => {
    const client = makeMockClient();
    (client.comments.update as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(Object.assign(new Error('method not allowed'), { status: 405 }));
    const logLines: unknown[] = [];
    const dest = { write: (line: string) => logLines.push(JSON.parse(line)) };
    const source = new NotionFeedbackSource(client, { logDestination: dest });

    await expect(source.resolve('page-abc', ['disc-1'])).resolves.toBeUndefined();

    const warnLog = logLines.find((l: unknown) => (l as { event?: string }).event === 'notion_comments.resolve_skipped');
    expect(warnLog).toBeDefined();
  });
});
