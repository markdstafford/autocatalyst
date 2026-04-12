// tests/adapters/notion/notion-feedback-source.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';
import { NotionFeedbackSource } from '../../../src/adapters/notion/notion-feedback-source.js';

const nullDest = { write: () => {} };

function makeMockClient(): NotionClient {
  return {
    pages: { create: vi.fn() },
    blocks: {
      children: {
        list: vi.fn().mockResolvedValue({ results: [], has_more: false }),
      },
    },
    comments: {
      list: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeBlock(id: string) {
  return { id, type: 'paragraph', has_children: false };
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

  it('returns inline comments from child blocks when page-level has none', async () => {
    const client = makeMockClient();
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [makeBlock('block-child-1')],
      has_more: false,
    });
    // page-level: no comments; child block: one comment
    (client.comments.list as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [makeComment({ discussion_id: 'disc-inline-1' })] });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('disc-inline-1');
  });

  it('combines page-level and child block comments into a single result', async () => {
    const client = makeMockClient();
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [makeBlock('block-child-1')],
      has_more: false,
    });
    // page-level: one comment; child block: one comment
    (client.comments.list as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [makeComment({ discussion_id: 'disc-page-1' })] })
      .mockResolvedValueOnce({ results: [makeComment({ discussion_id: 'disc-inline-1' })] });
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toEqual(expect.arrayContaining(['disc-page-1', 'disc-inline-1']));
  });

  it('skips child blocks that have no comments', async () => {
    const client = makeMockClient();
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [makeBlock('block-no-comments'), makeBlock('block-with-comment')],
      has_more: false,
    });
    (client.comments.list as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [] })          // page-level: empty
      .mockResolvedValueOnce({ results: [] })          // block-no-comments: empty
      .mockResolvedValueOnce({ results: [makeComment({ discussion_id: 'disc-inline-1' })] }); // block-with-comment
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('disc-inline-1');
  });

  it('fetches all child blocks when listing is paginated', async () => {
    const client = makeMockClient();
    (client.blocks.children.list as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [makeBlock('block-1')], has_more: true, next_cursor: 'cursor-1' })
      .mockResolvedValueOnce({ results: [makeBlock('block-2')], has_more: false });
    (client.comments.list as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [] })           // page-level: empty
      .mockResolvedValueOnce({ results: [makeComment({ discussion_id: 'disc-1' })] }) // block-1
      .mockResolvedValueOnce({ results: [makeComment({ discussion_id: 'disc-2' })] }); // block-2
    const source = new NotionFeedbackSource(client, { logDestination: nullDest });

    const result = await source.fetch('page-abc');

    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toEqual(expect.arrayContaining(['disc-1', 'disc-2']));
    expect(client.blocks.children.list).toHaveBeenCalledTimes(2);
    expect(client.blocks.children.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ start_cursor: 'cursor-1' }));
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

