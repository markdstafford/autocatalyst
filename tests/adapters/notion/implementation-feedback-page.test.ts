import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotionImplementationFeedbackPage } from '../../../src/adapters/notion/implementation-feedback-page.js';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';

const nullDest = { write: () => {} };

function makeNotionClient(overrides: Partial<{
  pagesCreate: ReturnType<typeof vi.fn>;
  blocksChildrenList: ReturnType<typeof vi.fn>;
  pagesGetMarkdown: ReturnType<typeof vi.fn>;
  pagesUpdateMarkdown: ReturnType<typeof vi.fn>;
  pagesUpdateProperties: ReturnType<typeof vi.fn>;
}> = {}): NotionClient {
  return {
    pages: {
      create: overrides.pagesCreate ?? vi.fn().mockResolvedValue({ id: 'new-page-id' }),
      getMarkdown: overrides.pagesGetMarkdown ?? vi.fn().mockResolvedValue(''),
      updateMarkdown: overrides.pagesUpdateMarkdown ?? vi.fn().mockResolvedValue(undefined),
      updateProperties: overrides.pagesUpdateProperties ?? vi.fn().mockResolvedValue(undefined),
    },
    blocks: {
      children: {
        list: overrides.blocksChildrenList ?? vi.fn().mockResolvedValue({ results: [] }),
      },
    },
    comments: {
      list: vi.fn().mockResolvedValue({ results: [] }),
      create: vi.fn().mockResolvedValue({}),
    },
    users: {
      me: vi.fn().mockResolvedValue({ id: 'bot-id' }),
    },
    databases: {
      query: vi.fn().mockResolvedValue({ results: [] }),
    },
  } as unknown as NotionClient;
}

// Helper: build a Notion to-do block
function makeTodoBlock(id: string, text: string, checked: boolean, children: unknown[] = []) {
  return {
    id,
    type: 'to_do',
    has_children: children.length > 0,
    to_do: {
      rich_text: [{ plain_text: text }],
      checked,
    },
    _children: children, // test helper, not Notion API
  };
}

// Helper: build a paragraph block (sub-bullet)
function makeParagraphBlock(text: string) {
  return {
    id: `para-${Math.random()}`,
    type: 'paragraph',
    paragraph: {
      rich_text: [{ plain_text: text }],
    },
  };
}

// Mock blocksChildrenList that returns different results for page vs. block children calls
function makeBlocksChildrenListFn(
  pageBlocks: unknown[],
  childrenByBlockId: Record<string, unknown[]> = {},
) {
  return vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
    if (childrenByBlockId[block_id]) {
      return { results: childrenByBlockId[block_id] };
    }
    return { results: pageBlocks };
  });
}

describe('NotionImplementationFeedbackPage — create', () => {
  it('creates a page under the given parent_page_id', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    await page.create('parent-123', 'https://notion.so/spec', 'Summary text', 'Run npm test');

    expect(pagesCreate).toHaveBeenCalledOnce();
    const args = pagesCreate.mock.calls[0][0];
    expect(JSON.stringify(args)).toContain('parent-123');
  });

  it('returns the page_id from the created page', async () => {
    const client = makeNotionClient({ pagesCreate: vi.fn().mockResolvedValue({ id: 'page-xyz' }) });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    const result = await page.create('parent', 'https://notion.so/spec', 'Summary', 'Test');
    expect(result).toBe('page-xyz');
  });

  it('includes the spec link in the page content', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    await page.create('parent', 'https://notion.so/spec-page', 'Summary', 'Test instructions');

    const args = JSON.stringify(pagesCreate.mock.calls[0][0]);
    expect(args).toContain('notion.so/spec-page');
  });

  it('throws when pages.create rejects', async () => {
    const client = makeNotionClient({
      pagesCreate: vi.fn().mockRejectedValue(new Error('Notion API error')),
    });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    await expect(page.create('parent', 'https://url', 'Summary', 'Test')).rejects.toThrow();
  });
});

describe('NotionImplementationFeedbackPage — readFeedback', () => {
  it('returns empty array when page has no blocks', async () => {
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([]),
    });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toEqual([]);
  });

  it('returns unchecked to-do item with resolved: false', async () => {
    const todoBlock = makeTodoBlock('block-1', 'Fix the bug', false);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([todoBlock]),
    });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('block-1');
    expect(result[0].text).toBe('Fix the bug');
    expect(result[0].resolved).toBe(false);
  });

  it('returns checked to-do item with resolved: true', async () => {
    const todoBlock = makeTodoBlock('block-2', 'Already done', true);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([todoBlock]),
    });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result[0].resolved).toBe(true);
  });

  it('returns sub-bullets in conversation array', async () => {
    const para1 = makeParagraphBlock('Comment A');
    const para2 = makeParagraphBlock('Comment B');
    const todoBlock = makeTodoBlock('block-3', 'The item', false, [para1, para2]);

    const blocksChildrenList = vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === 'page-id') return { results: [todoBlock] };
      if (block_id === 'block-3') return { results: [para1, para2] };
      return { results: [] };
    });

    const client = makeNotionClient({ blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result[0].conversation).toEqual(['Comment A', 'Comment B']);
  });

  it('returns multiple to-do items in document order', async () => {
    const block1 = makeTodoBlock('b1', 'First', false);
    const block2 = makeTodoBlock('b2', 'Second', true);
    const block3 = makeTodoBlock('b3', 'Third', false);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([block1, block2, block3]),
    });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('First');
    expect(result[1].text).toBe('Second');
    expect(result[2].text).toBe('Third');
  });

  it('ignores non-to-do blocks', async () => {
    const heading = { id: 'h1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Feedback' }] } };
    const paragraph = { id: 'p1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Some text' }] } };
    const todo = makeTodoBlock('t1', 'Actual feedback', false);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([heading, paragraph, todo]),
    });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Actual feedback');
  });
});

describe('NotionImplementationFeedbackPage — update', () => {
  it('replaces summary when provided', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '# Implementation',
      '',
      '## Summary',
      '',
      'Old summary.',
      '',
      '## Testing instructions',
      '',
      'Old instructions.',
      '',
      '## Feedback',
      '',
    ].join('\n'));
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    await page.update('page-id', { summary: 'New summary text.' });

    expect(pagesUpdateMarkdown).toHaveBeenCalledOnce();
    const updatedMarkdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updatedMarkdown).toContain('New summary text.');
    expect(updatedMarkdown).not.toContain('Old summary.');
  });

  it('leaves summary unchanged when not provided', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '# Implementation',
      '',
      '## Summary',
      '',
      'Existing summary.',
      '',
    ].join('\n'));
    const blocksChildrenList = vi.fn().mockResolvedValue({ results: [] });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    await page.update('page-id', {
      resolved_items: [],
    });

    if (pagesUpdateMarkdown.mock.calls.length > 0) {
      const updatedMarkdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
      expect(updatedMarkdown).toContain('Existing summary.');
    }
  });

  it('marks resolved items as checked with resolution comment sub-bullet', async () => {
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const pagesGetMarkdown = vi.fn().mockResolvedValue([
      '# Implementation',
      '',
      '## Summary',
      '',
      'Summary.',
      '',
      '## Testing instructions',
      '',
      'Test.',
      '',
      '## Feedback',
      '',
      '- [ ] Fix the bug',
      '',
    ].join('\n'));
    const blocksChildrenList = vi.fn().mockImplementation(async ({ block_id }: { block_id: string }) => {
      if (block_id === 'page-id') {
        return {
          results: [makeTodoBlock('todo-1', 'Fix the bug', false)],
        };
      }
      return { results: [] };
    });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    await page.update('page-id', {
      resolved_items: [{ id: 'todo-1', resolution_comment: 'Fixed the config validator' }],
    });

    expect(pagesUpdateMarkdown).toHaveBeenCalledOnce();
    const updatedMarkdown = pagesUpdateMarkdown.mock.calls[0][1].replace_content.new_str as string;
    expect(updatedMarkdown).toContain('[x]');
    expect(updatedMarkdown).toContain('Fixed the config validator');
    expect(updatedMarkdown).toContain('✓');
  });

  it('throws when update API rejects', async () => {
    const pagesGetMarkdown = vi.fn().mockResolvedValue('# Page\n\n## Summary\n\nText.\n');
    const pagesUpdateMarkdown = vi.fn().mockRejectedValue(new Error('API error'));
    const blocksChildrenList = vi.fn().mockResolvedValue({ results: [] });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: nullDest });

    await expect(page.update('page-id', { summary: 'New summary' })).rejects.toThrow();
  });
});

describe('NotionImplementationFeedbackPage — logging', () => {
  it('emits impl_feedback_page.created on successful create', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, { logDestination: dest });

    await page.create('parent', 'https://url', 'Summary', 'Test');

    const created = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'impl_feedback_page.created');
    expect(created).toBeDefined();
  });

  it('emits implementation.feedback_read on successful readFeedback', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([]),
    });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: dest });

    await page.readFeedback('page-id');

    const read = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'implementation.feedback_read');
    expect(read).toBeDefined();
  });

  it('emits implementation.feedback_updated on successful update', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const pagesGetMarkdown = vi.fn().mockResolvedValue('# Page\n\n## Summary\n\nText.\n');
    const pagesUpdateMarkdown = vi.fn().mockResolvedValue(undefined);
    const blocksChildrenList = vi.fn().mockResolvedValue({ results: [] });
    const client = makeNotionClient({ pagesGetMarkdown, pagesUpdateMarkdown, blocksChildrenList });
    const page = new NotionImplementationFeedbackPage(client, { logDestination: dest });

    await page.update('page-id', { summary: 'New summary' });

    const updated = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'implementation.feedback_updated');
    expect(updated).toBeDefined();
  });
});
