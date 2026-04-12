// tests/adapters/notion/notion-publisher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { App } from '@slack/bolt';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';
import { NotionPublisher } from '../../../src/adapters/notion/notion-publisher.js';

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
      getMarkdown: vi.fn().mockResolvedValue(''),
      updateMarkdown: vi.fn().mockResolvedValue(undefined),
    },
    blocks: {
      children: {
        list: vi.fn().mockResolvedValue({ results: [], has_more: false }),
      },
    },
    comments: {
      list: vi.fn().mockResolvedValue({ results: [] }),
      create: vi.fn().mockResolvedValue({}),
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
  it('calls pages.create with correct parent_page_id and title only (no children)', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile();

    await publisher.create('C123', '100.0', specPath);

    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({ parent: { page_id: 'parent-page-xyz' } }),
    );
    // No children in pages.create — content set via markdown API
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.children).toBeUndefined();
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

  it('calls pages.updateMarkdown with replace_content after pages.create', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });
    const specPath = makeSpecFile('# My Spec\n\ncontent');

    const callOrder: string[] = [];
    (client.pages.create as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('pages.create');
      return { id: 'page-abc123' };
    });
    (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('pages.updateMarkdown');
    });

    await publisher.create('C123', '100.0', specPath);

    expect(callOrder).toEqual(['pages.create', 'pages.updateMarkdown']);
    expect(client.pages.updateMarkdown).toHaveBeenCalledWith(
      'page-abc123',
      { type: 'replace_content', replace_content: { new_str: '# My Spec\n\ncontent' } },
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
    (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('pages.updateMarkdown');
    });
    (app.client.chat.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callOrder.push('postMessage');
      return {};
    });

    await publisher.create('C123', '100.0', specPath);

    expect(callOrder).toEqual(['pages.create', 'pages.updateMarkdown', 'postMessage']);
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

  it('throws if pages.create rejects; updateMarkdown and postMessage never called', async () => {
    const client = makeMockNotionClient();
    (client.pages.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('API error');
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled();
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('throws if pages.updateMarkdown rejects; postMessage never called', async () => {
    const client = makeMockNotionClient();
    (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Markdown error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('Markdown error');
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('throws if postMessage rejects after successful create and updateMarkdown', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (app.client.chat.postMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Slack error'));
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('Slack error');
  });
});

describe('NotionPublisher.update', () => {
  it('reads spec from disk and calls replace_content when no page_content provided', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile('# My Spec\n\ncontent'));

    expect(client.pages.updateMarkdown).toHaveBeenCalledWith(
      'page-xyz',
      { type: 'replace_content', replace_content: { new_str: '# My Spec\n\ncontent' } },
    );
  });

  it('uses page_content directly when provided (span-bearing)', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    const spanContent = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    await publisher.update('page-xyz', makeSpecFile('# Spec\n\ntext'), spanContent);

    expect(client.pages.updateMarkdown).toHaveBeenCalledWith(
      'page-xyz',
      { type: 'replace_content', replace_content: { new_str: spanContent } },
    );
  });

  it('does not call getMarkdown (no diff needed)', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile('# Spec'));

    expect(client.pages.getMarkdown).not.toHaveBeenCalled();
  });

  it('throws if pages.updateMarkdown rejects', async () => {
    const client = makeMockNotionClient();
    (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('patch error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.update('page-xyz', makeSpecFile('# New'))).rejects.toThrow('patch error');
  });

  it('never calls postMessage during update', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile('# New'));

    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('NotionPublisher.getPageMarkdown', () => {
  it('returns page markdown from client', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    const markdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(markdown);

    const result = await publisher.getPageMarkdown('page-xyz');

    expect(client.pages.getMarkdown).toHaveBeenCalledWith('page-xyz');
    expect(result).toBe(markdown);
  });

  it('returns empty string when page has no content', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');

    const result = await publisher.getPageMarkdown('page-xyz');

    expect(result).toBe('');
  });

  it('throws if client rejects', async () => {
    const client = makeMockNotionClient();
    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'parent-page-xyz', { logDestination: nullDest });

    await expect(publisher.getPageMarkdown('page-xyz')).rejects.toThrow('API error');
  });
});
