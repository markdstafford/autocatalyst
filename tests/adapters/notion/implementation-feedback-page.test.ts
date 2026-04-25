import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotionImplementationFeedbackPage } from '../../../src/adapters/notion/implementation-feedback-page.js';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';
import type { ImplementationReviewInput } from '../../../src/types/impl-feedback-page.js';

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

function makeReviewInput(overrides: Partial<ImplementationReviewInput> = {}): ImplementationReviewInput {
  return {
    artifact_ref: 'spec-page-id',
    artifact_url: 'https://notion.so/spec',
    title: 'Setup wizard',
    summary: 'sum',
    testing_instructions: 'test',
    ...overrides,
  };
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
  it('creates a page in the testing_guides_database_id (not under a parent page)', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ summary: 'the summary', testing_instructions: 'run npm test' }));

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.parent).toEqual(
      expect.objectContaining({ database_id: 'db-testing-guides-id' }),
    );
    expect(createCall.parent.page_id).toBeUndefined();
  });

  it('returns the page_id', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.create(makeReviewInput());

    expect(result).toEqual({ id: 'new-page-id', url: 'https://notion.so/newpageid' });
  });

  it('sets Title to "Testing guide: {spec_title}"', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput());

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Title'].title[0].text.content).toBe('Testing guide: Setup wizard');
  });

  it('sets Spec relation to spec_page_id', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ artifact_ref: 'spec-page-abc' }));

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Spec'].relation).toEqual([{ id: 'spec-page-abc' }]);
  });

  it('sets Status to "Not started"', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput());

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Status'].status.name).toBe('Not started');
  });

  it('includes spec link bookmark in page children', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ artifact_url: 'https://notion.so/spec-url' }));

    const createCall = pagesCreate.mock.calls[0][0];
    const bookmarkBlock = createCall.children.find(
      (b: { type: string }) => b.type === 'bookmark',
    );
    expect(bookmarkBlock?.bookmark?.url).toBe('https://notion.so/spec-url');
  });

  it('spec_title with special characters passes through verbatim', async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: 'new-page-id' });
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.create(makeReviewInput({ title: 'API: v2/beta' }));

    const createCall = pagesCreate.mock.calls[0][0];
    expect(createCall.properties['Title'].title[0].text.content).toBe('Testing guide: API: v2/beta');
  });

  it('throws when pages.create rejects', async () => {
    const pagesCreate = vi.fn().mockRejectedValue(new Error('Notion error'));
    const client = makeNotionClient({ pagesCreate });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await expect(
      page.create(makeReviewInput()),
    ).rejects.toThrow('Notion error');
  });

  it('emits notion_testing_guide.created log event', async () => {
    const records: Record<string, unknown>[] = [];
    const logDest = {
      write(msg: string) {
        try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', {
      logDestination: logDest as unknown as import('pino').DestinationStream,
    });

    await page.create(makeReviewInput());

    expect(records.find(r => r['event'] === 'notion_testing_guide.created')).toBeDefined();
  });
});

describe('NotionImplementationFeedbackPage — readFeedback', () => {
  it('returns empty array when page has no blocks', async () => {
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    const result = await page.readFeedback('page-id');
    expect(result).toEqual([]);
  });

  it('returns unchecked to-do item with resolved: false', async () => {
    const todoBlock = makeTodoBlock('block-1', 'Fix the bug', false);
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([todoBlock]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: nullDest });

    await expect(page.update('page-id', { summary: 'New summary' })).rejects.toThrow();
  });
});

describe('NotionImplementationFeedbackPage — logging', () => {
  it('emits notion_testing_guide.created on successful create', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const client = makeNotionClient();
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

    await page.create(makeReviewInput({ artifact_url: 'https://url', title: 'Test title', summary: 'Summary', testing_instructions: 'Test' }));

    const created = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'notion_testing_guide.created');
    expect(created).toBeDefined();
  });

  it('emits implementation.feedback_read on successful readFeedback', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const client = makeNotionClient({
      blocksChildrenList: makeBlocksChildrenListFn([]),
    });
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

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
    const page = new NotionImplementationFeedbackPage(client, 'db-testing-guides-id', { logDestination: dest });

    await page.update('page-id', { summary: 'New summary' });

    const updated = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'implementation.feedback_updated');
    expect(updated).toBeDefined();
  });
});

describe('NotionImplementationFeedbackPage — updateStatus', () => {
  it('calls pages.updateProperties with Status payload', async () => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.updateStatus!('page-tg-id', 'in_progress');

    expect(pagesUpdateProperties).toHaveBeenCalledWith('page-tg-id', {
      Status: { status: { name: 'In progress' } },
    });
  });

  it.each([
    ['not_started', 'Not started'],
    ['in_progress', 'In progress'],
    ['waiting_on_feedback', 'Waiting on feedback'],
    ['approved', 'Approved'],
  ] as const)('maps status "%s" to Notion label "%s"', async (status, notionLabel) => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.updateStatus!('page-id', status);

    expect(pagesUpdateProperties.mock.calls[0][1]['Status'].status.name).toBe(notionLabel);
  });

  it('throws if pages.updateProperties rejects', async () => {
    const pagesUpdateProperties = vi.fn().mockRejectedValue(new Error('API error'));
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await expect(page.updateStatus!('page-id', 'approved')).rejects.toThrow('API error');
  });

  it('logs notion_testing_guide.status_updated event', async () => {
    const records: Record<string, unknown>[] = [];
    const logDest = {
      write(msg: string) {
        try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', {
      logDestination: logDest as unknown as import('pino').DestinationStream,
    });

    await page.updateStatus!('page-id', 'approved');

    expect(records.find(r => r['event'] === 'notion_testing_guide.status_updated')).toBeDefined();
  });
});

describe('NotionImplementationFeedbackPage — setPRLink', () => {
  it('calls pages.updateProperties with PR link payload', async () => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await page.setPRLink!('page-tg-id', 'https://example.test/org/repo/pull/42');

    expect(pagesUpdateProperties).toHaveBeenCalledWith('page-tg-id', {
      'PR link': { url: 'https://example.test/org/repo/pull/42' },
    });
  });

  it('passes pr_url through verbatim', async () => {
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    const url = 'https://example.test/org/repo/pull/99?special=true&x=1';
    await page.setPRLink!('page-id', url);

    expect(pagesUpdateProperties.mock.calls[0][1]['PR link'].url).toBe(url);
  });

  it('throws if pages.updateProperties rejects', async () => {
    const pagesUpdateProperties = vi.fn().mockRejectedValue(new Error('API error'));
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', { logDestination: nullDest });

    await expect(page.setPRLink!('page-id', 'https://example.com/pr')).rejects.toThrow('API error');
  });

  it('logs notion_testing_guide.pr_link_set event', async () => {
    const records: Record<string, unknown>[] = [];
    const logDest = {
      write(msg: string) {
        try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };
    const pagesUpdateProperties = vi.fn().mockResolvedValue(undefined);
    const client = makeNotionClient({ pagesUpdateProperties });
    const page = new NotionImplementationFeedbackPage(client, 'db-tg-id', {
      logDestination: logDest as unknown as import('pino').DestinationStream,
    });

    await page.setPRLink!('page-id', 'https://example.test/org/repo/pull/1');

    expect(records.find(r => r['event'] === 'notion_testing_guide.pr_link_set')).toBeDefined();
  });
});
