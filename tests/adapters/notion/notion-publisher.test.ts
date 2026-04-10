// tests/adapters/notion/notion-publisher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { App } from '@slack/bolt';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';

// Mock @tryfabric/martian before importing NotionPublisher
vi.mock('@tryfabric/martian', () => ({
  markdownToBlocks: vi.fn().mockReturnValue([{ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'mocked' } }] } }]),
}));

import { NotionPublisher } from '../../../src/adapters/notion/notion-publisher.js';
import { markdownToBlocks } from '@tryfabric/martian';

const nullDest = { write: () => {} };

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'np-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeSpecFile(content = '# My Spec\n\ncontent', filename = 'feature-setup-wizard.md'): string {
  const path = join(tempDir, filename);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeMockNotionClient(pageId = 'page-abc123'): NotionClient {
  return {
    pages: {
      create: vi.fn().mockResolvedValue({ id: pageId }),
    },
    blocks: {
      children: {
        list: vi.fn().mockResolvedValue({ results: [{ id: 'block-1' }, { id: 'block-2' }] }),
        append: vi.fn().mockResolvedValue({}),
      },
      delete: vi.fn().mockResolvedValue({}),
    },
    comments: {
      list: vi.fn().mockResolvedValue({ results: [] }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeMockApp() {
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe('NotionPublisher.create', () => {
  it('calls pages.create with correct parent_page_id', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile();

    await publisher.create('C123', '100.0', specPath);

    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({ parent: { page_id: 'parent-page-xyz' } }),
    );
  });

  it('derives title from filename slug — feature-setup-wizard.md → "Setup wizard"', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile('# spec', 'feature-setup-wizard.md');

    await publisher.create('C123', '100.0', specPath);

    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          title: expect.arrayContaining([
            expect.objectContaining({ text: expect.objectContaining({ content: 'Setup wizard' }) }),
          ]),
        }),
      }),
    );
  });

  it('derives title from enhancement slug — enhancement-notion-publisher.md → "Notion publisher"', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile('# spec', 'enhancement-notion-publisher.md');

    await publisher.create('C123', '100.0', specPath);

    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          title: expect.arrayContaining([
            expect.objectContaining({ text: expect.objectContaining({ content: 'Notion publisher' }) }),
          ]),
        }),
      }),
    );
  });

  it('passes markdownToBlocks output as children', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile('# My Spec\n\ncontent');

    await publisher.create('C123', '100.0', specPath);

    expect(markdownToBlocks).toHaveBeenCalledWith(expect.stringContaining('My Spec'));
    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({ children: expect.any(Array) }),
    );
  });

  it('calls postMessage after pages.create with Notion page URL', async () => {
    const client = makeMockNotionClient('page-abc-123-xyz');
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile();

    const callOrder: string[] = [];
    (client.pages.create as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('pages.create');
      return { id: 'page-abc-123-xyz' };
    });
    (app.client.chat.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('postMessage');
      return {};
    });

    await publisher.create('C123', '100.0', specPath);

    expect(callOrder).toEqual(['pages.create', 'postMessage']);
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.0',
        text: expect.stringContaining('pageabc123xyz'),
      }),
    );
  });

  it('returns page_id', async () => {
    const client = makeMockNotionClient('returned-page-id');
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    const result = await publisher.create('C123', '100.0', makeSpecFile());

    expect(result).toBe('returned-page-id');
  });

  it('throws if pages.create rejects; postMessage never called', async () => {
    const client = makeMockNotionClient();
    (client.pages.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('API error');
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('throws if postMessage rejects after successful pages.create', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (app.client.chat.postMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Slack error'));
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('Slack error');
  });
});

describe('NotionPublisher.update', () => {
  it('fetches existing blocks, deletes each in order, then appends new blocks', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile('# Updated');

    const callOrder: string[] = [];
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('list');
      return { results: [{ id: 'block-1' }, { id: 'block-2' }] };
    });
    (client.blocks.delete as ReturnType<typeof vi.fn>).mockImplementation(async ({ block_id }: { block_id: string }) => {
      callOrder.push(`delete:${block_id}`);
      return {};
    });
    (client.blocks.children.append as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('append');
      return {};
    });

    await publisher.update('page-xyz', specPath);

    expect(callOrder).toEqual(['list', 'delete:block-1', 'delete:block-2', 'append']);
  });

  it('handles empty page: no deletes, append proceeds', async () => {
    const client = makeMockNotionClient();
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ results: [] });
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile());

    expect(client.blocks.delete).not.toHaveBeenCalled();
    expect(client.blocks.children.append).toHaveBeenCalled();
  });

  it('throws if blocks.children.list rejects; no deletes or appends', async () => {
    const client = makeMockNotionClient();
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('list error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.update('page-xyz', makeSpecFile())).rejects.toThrow('list error');
    expect(client.blocks.delete).not.toHaveBeenCalled();
    expect(client.blocks.children.append).not.toHaveBeenCalled();
  });

  it('throws if blocks.delete rejects; append not called', async () => {
    const client = makeMockNotionClient();
    (client.blocks.delete as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('delete error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.update('page-xyz', makeSpecFile())).rejects.toThrow('delete error');
    expect(client.blocks.children.append).not.toHaveBeenCalled();
  });

  it('throws if blocks.children.append rejects', async () => {
    const client = makeMockNotionClient();
    (client.blocks.children.append as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('append error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.update('page-xyz', makeSpecFile())).rejects.toThrow('append error');
  });

  it('never calls postMessage during update', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile());

    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('throws if blocks.children.list returns has_more: true', async () => {
    const client = makeMockNotionClient();
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [{ id: 'block-1' }],
      has_more: true,
    });
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.update('page-xyz', makeSpecFile())).rejects.toThrow(/pagination not yet supported/i);
    expect(client.blocks.delete).not.toHaveBeenCalled();
  });
});
