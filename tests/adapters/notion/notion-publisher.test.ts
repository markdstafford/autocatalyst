// tests/adapters/notion/notion-publisher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { App } from '@slack/bolt';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';
import { NotionPublisher } from '../../../src/adapters/notion/notion-publisher.js';

const nullDest = { write: () => {} };

function makeLogCapture() {
  const records: Record<string, unknown>[] = [];
  const destination = {
    write(msg: string) {
      try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore */ }
    },
  };
  return { records, destination: destination as unknown as import('pino').DestinationStream };
}

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
      updateProperties: vi.fn().mockResolvedValue(undefined),
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
    users: { me: vi.fn() },
    databases: {
      query: vi.fn().mockResolvedValue({ results: [] }),
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
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile();

    await publisher.create('C123', '100.0', specPath);

    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({ parent: expect.objectContaining({ database_id: 'db-specs-id' }) }),
    );
    // No children in pages.create — content set via markdown API
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.children).toBeUndefined();
  });

  it('derives title from filename slug — feature-setup-wizard.md → "Setup wizard"', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('# spec', 'feature-setup-wizard.md');

    await publisher.create('C123', '100.0', specPath);

    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          Title: expect.objectContaining({
            title: expect.arrayContaining([
              expect.objectContaining({ text: expect.objectContaining({ content: 'Setup wizard' }) }),
            ]),
          }),
        }),
      }),
    );
  });

  it('derives title from enhancement slug — enhancement-notion-publisher.md → "Notion publisher"', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('# spec', 'enhancement-notion-publisher.md');

    await publisher.create('C123', '100.0', specPath);

    expect(client.pages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          Title: expect.objectContaining({
            title: expect.arrayContaining([
              expect.objectContaining({ text: expect.objectContaining({ content: 'Notion publisher' }) }),
            ]),
          }),
        }),
      }),
    );
  });

  it('calls pages.updateMarkdown with replace_content after pages.create', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
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
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
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
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    const result = await publisher.create('C123', '100.0', makeSpecFile());

    expect(result).toBe('returned-page-id');
  });

  it('throws if pages.create rejects; updateMarkdown and postMessage never called', async () => {
    const client = makeMockNotionClient();
    (client.pages.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('API error');
    expect(client.pages.updateMarkdown).not.toHaveBeenCalled();
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('throws if pages.updateMarkdown rejects; postMessage never called', async () => {
    const client = makeMockNotionClient();
    (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Markdown error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('Markdown error');
    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('throws if postMessage rejects after successful create and updateMarkdown', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (app.client.chat.postMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Slack error'));
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await expect(publisher.create('C123', '100.0', makeSpecFile())).rejects.toThrow('Slack error');
  });
});

describe('NotionPublisher.update', () => {
  it('reads spec from disk and calls replace_content when no page_content provided', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile('# My Spec\n\ncontent'));

    expect(client.pages.updateMarkdown).toHaveBeenCalledWith(
      'page-xyz',
      { type: 'replace_content', replace_content: { new_str: '# My Spec\n\ncontent' } },
    );
  });

  it('uses page_content directly when provided (span-bearing)', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

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
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile('# Spec'));

    expect(client.pages.getMarkdown).not.toHaveBeenCalled();
  });

  it('throws if pages.updateMarkdown rejects', async () => {
    const client = makeMockNotionClient();
    (client.pages.updateMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('patch error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await expect(publisher.update('page-xyz', makeSpecFile('# New'))).rejects.toThrow('patch error');
  });

  it('never calls postMessage during update', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await publisher.update('page-xyz', makeSpecFile('# New'));

    expect(app.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('NotionPublisher.getPageMarkdown', () => {
  it('returns page markdown from client', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    const markdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(markdown);

    const result = await publisher.getPageMarkdown('page-xyz');

    expect(client.pages.getMarkdown).toHaveBeenCalledWith('page-xyz');
    expect(result).toBe(markdown);
  });

  it('returns empty string when page has no content', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');

    const result = await publisher.getPageMarkdown('page-xyz');

    expect(result).toBe('');
  });

  it('throws if client rejects', async () => {
    const client = makeMockNotionClient();
    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API error'));
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    await expect(publisher.getPageMarkdown('page-xyz')).rejects.toThrow('API error');
  });

  it('strips all HTML when stripHtml=true', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    const rawMarkdown = '# Spec\n\n<table header-row="true"><tr><td>Cell</td></tr></table>\n\n<span discussion-urls="discussion://abc">text</span>';
    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rawMarkdown);

    const result = await publisher.getPageMarkdown('page-xyz', true);

    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('Cell');
    expect(result).toContain('text');
  });

  it('returns raw HTML when stripHtml=false (default)', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });

    const rawMarkdown = '# Spec\n\n<table header-row="true"><tr><td>Cell</td></tr></table>';
    (client.pages.getMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(rawMarkdown);

    const result = await publisher.getPageMarkdown('page-xyz');

    expect(result).toContain('<table');
    expect(result).toContain('<td>Cell</td>');
  });
});

describe('NotionPublisher — parseFrontmatter behavior (via create)', () => {
  it('returns all frontmatter fields — create sets Specced by from frontmatter', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile(
      '---\nspecced_by: alice\nlast_updated: 2026-04-16\n---\n# Spec\ncontent',
      'feature-setup-wizard.md',
    );
    await publisher.create('C123', '100.0', specPath);
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.properties['Specced by'].rich_text[0].text.content).toBe('alice');
    expect(createCall.properties['Last updated'].date.start).toBe('2026-04-16');
  });

  it('no frontmatter: create still works without crashing', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('# Spec with no frontmatter\ncontent', 'feature-no-fm.md');
    await publisher.create('C123', '100.0', specPath);
    expect(client.pages.create).toHaveBeenCalledOnce();
  });

  it('issue: null in frontmatter — Issue # omitted from properties', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile(
      '---\nspecced_by: bob\nlast_updated: 2026-04-16\nissue: null\n---\n# Spec',
      'feature-null-issue.md',
    );
    await publisher.create('C123', '100.0', specPath);
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.properties['Issue #']).toBeUndefined();
  });

  it('issue: 42 in frontmatter — Issue # number property included', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile(
      '---\nspecced_by: bob\nlast_updated: 2026-04-16\nissue: 42\n---\n# Spec',
      'feature-with-issue.md',
    );
    await publisher.create('C123', '100.0', specPath);
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.properties['Issue #'].number).toBe(42);
  });
});

describe('NotionPublisher — resolveFilenameToPageId behavior (via create)', () => {
  it('supersedes set and found: relation property included in create call', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (client.databases.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ id: 'old-spec-page-id', properties: {} }],
    });
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile(
      '---\nspecced_by: alice\nlast_updated: 2026-04-16\nsupersedes: feature-old-spec.md\n---\n# Spec',
      'feature-new-spec.md',
    );
    await publisher.create('C123', '100.0', specPath);
    expect(client.databases.query).toHaveBeenCalledWith('db-specs-id', {
      filter: { property: 'Filename', rich_text: { equals: 'feature-old-spec.md' } },
    });
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.properties['Superseded by / Supersedes'].relation).toEqual([{ id: 'old-spec-page-id' }]);
  });

  it('supersedes filename not found: warn logged, relation omitted, create still called', async () => {
    const { records, destination } = makeLogCapture();
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (client.databases.query as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: destination });
    const specPath = makeSpecFile(
      '---\nspecced_by: alice\nlast_updated: 2026-04-16\nsupersedes: feature-missing.md\n---\n# Spec',
      'feature-new-spec.md',
    );
    await publisher.create('C123', '100.0', specPath);
    expect(client.pages.create).toHaveBeenCalledOnce();
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.properties['Superseded by / Supersedes']).toBeUndefined();
    expect(records.find(r => r['event'] === 'notion_spec.filename_lookup_failed')).toBeDefined();
  });

  it('multiple results: returns first result id', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (client.databases.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        { id: 'first-page-id', properties: {} },
        { id: 'second-page-id', properties: {} },
      ],
    });
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile(
      '---\nspecced_by: alice\nlast_updated: 2026-04-16\nsupersedes: feature-old.md\n---\n# Spec',
      'feature-new.md',
    );
    await publisher.create('C123', '100.0', specPath);
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.properties['Superseded by / Supersedes'].relation).toEqual([{ id: 'first-page-id' }]);
  });
});

describe('NotionPublisher.create — database entry with typed properties', () => {
  it('calls pages.create with database_id parent (not page_id)', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('---\nspecced_by: alice\nlast_updated: 2026-04-16\n---\n# Spec', 'feature-setup-wizard.md');
    await publisher.create('C123', '100.0', specPath);
    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.parent).toEqual(expect.objectContaining({ database_id: 'db-specs-id' }));
    expect(createCall.parent.page_id).toBeUndefined();
  });

  it('sets all required typed properties', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', {
      logDestination: nullDest,
      repo_name: 'acme-org/autocatalyst',
    });
    const specPath = makeSpecFile(
      '---\nspecced_by: alice\nlast_updated: 2026-04-16\nissue: 7\nimplemented_by: bob\n---\n# Spec',
      'feature-setup-wizard.md',
    );
    await publisher.create('C123', '100.0', specPath);
    const p = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].properties;
    expect(p['Title'].title[0].text.content).toBe('Setup wizard');
    expect(p['Filename'].rich_text[0].text.content).toBe('feature-setup-wizard.md');
    expect(p['Status'].status.name).toBe('Speccing');
    expect(p['Specced by'].rich_text[0].text.content).toBe('alice');
    expect(p['Repo / Codebase'].select.name).toBe('acme-org/autocatalyst');
    expect(p['Issue #'].number).toBe(7);
    expect(p['Last updated'].date.start).toBe('2026-04-16');
    expect(p['Implemented by'].rich_text[0].text.content).toBe('bob');
  });

  it('omits Repo/Codebase when repo_name absent from options', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('---\nspecced_by: alice\nlast_updated: 2026-04-16\n---\n# Spec', 'feature-no-repo.md');
    await publisher.create('C123', '100.0', specPath);
    const p = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].properties;
    expect(p['Repo / Codebase']).toBeUndefined();
  });

  it('omits Implemented by when null/absent in frontmatter', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('---\nspecced_by: alice\nlast_updated: 2026-04-16\nimplemented_by: null\n---\n# Spec', 'feature-no-impl.md');
    await publisher.create('C123', '100.0', specPath);
    const p = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0][0].properties;
    expect(p['Implemented by']).toBeUndefined();
  });

  it('logs notion_spec.properties_created event', async () => {
    const { records, destination } = makeLogCapture();
    const client = makeMockNotionClient('page-xyz');
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: destination });
    const specPath = makeSpecFile('---\nspecced_by: alice\nlast_updated: 2026-04-16\n---\n# Spec', 'feature-log-test.md');
    await publisher.create('C123', '100.0', specPath);
    expect(records.find(r => r['event'] === 'notion_spec.properties_created')).toBeDefined();
  });
});

describe('NotionPublisher.update — property sync', () => {
  it('calls pages.updateProperties after Markdown write with last_updated and implemented_by', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile(
      '---\nspecced_by: alice\nlast_updated: 2026-04-17\nimplemented_by: bob\n---\n# Spec',
      'feature-update-test.md',
    );
    await publisher.update('page-abc', specPath);
    expect(client.pages.updateMarkdown).toHaveBeenCalledWith('page-abc', expect.any(Object));
    expect(client.pages.updateProperties).toHaveBeenCalledWith('page-abc', expect.objectContaining({
      'Last updated': { date: { start: '2026-04-17' } },
      'Implemented by': { rich_text: [{ type: 'text', text: { content: 'bob' } }] },
    }));
  });

  it('omits Implemented by when absent from frontmatter on update', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('---\nspecced_by: alice\nlast_updated: 2026-04-17\n---\n# Spec', 'feature-no-impl.md');
    await publisher.update('page-abc', specPath);
    const call = (client.pages.updateProperties as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]['Implemented by']).toBeUndefined();
    expect(call[1]['Last updated']).toBeDefined();
  });

  it('always calls updateProperties even when called twice (no diffing)', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile('---\nlast_updated: 2026-04-16\n---\n# Spec', 'feature-nodiff.md');
    await publisher.update('page-abc', specPath);
    await publisher.update('page-abc', specPath);
    expect(client.pages.updateProperties).toHaveBeenCalledTimes(2);
  });

  it('superseded_by set and resolves: Status=Superseded and relation set', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (client.databases.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ id: 'superseding-page-id', properties: {} }],
    });
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    const specPath = makeSpecFile(
      '---\nlast_updated: 2026-04-16\nsuperseded_by: feature-new-spec.md\n---\n# Spec',
      'feature-old-spec.md',
    );
    await publisher.update('page-abc', specPath);
    const call = (client.pages.updateProperties as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]['Status'].status.name).toBe('Superseded');
    expect(call[1]['Superseded by / Supersedes'].relation).toEqual([{ id: 'superseding-page-id' }]);
  });

  it('superseded_by set but not found: last_updated synced, Status NOT changed', async () => {
    const { records, destination } = makeLogCapture();
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (client.databases.query as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: destination });
    const specPath = makeSpecFile(
      '---\nlast_updated: 2026-04-16\nsuperseded_by: feature-missing.md\n---\n# Spec',
      'feature-old-spec.md',
    );
    await publisher.update('page-abc', specPath);
    const call = (client.pages.updateProperties as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]['Last updated']).toBeDefined();
    expect(call[1]['Status']).toBeUndefined();
    expect(records.find(r => r['event'] === 'notion_spec.filename_lookup_failed')).toBeDefined();
  });

  it('logs notion_spec.properties_updated event', async () => {
    const { records, destination } = makeLogCapture();
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: destination });
    const specPath = makeSpecFile('---\nlast_updated: 2026-04-16\n---\n# Spec', 'feature-logtest.md');
    await publisher.update('page-abc', specPath);
    expect(records.find(r => r['event'] === 'notion_spec.properties_updated')).toBeDefined();
  });
});

describe('NotionPublisher.updateStatus', () => {
  it('calls pages.updateProperties with Status payload', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    await publisher.updateStatus!('page-abc', 'Approved');
    expect(client.pages.updateProperties).toHaveBeenCalledWith('page-abc', {
      Status: { status: { name: 'Approved' } },
    });
  });

  it.each([
    ['Speccing'],
    ['Waiting on feedback'],
    ['Approved'],
    ['Complete'],
    ['Superseded'],
  ] as const)('passes status "%s" through correctly', async (status) => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    await publisher.updateStatus!('page-abc', status);
    const call = (client.pages.updateProperties as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]['Status'].status.name).toBe(status);
  });

  it('throws if pages.updateProperties rejects', async () => {
    const client = makeMockNotionClient();
    const app = makeMockApp();
    (client.pages.updateProperties as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Notion API error'));
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: nullDest });
    await expect(publisher.updateStatus!('page-abc', 'Approved')).rejects.toThrow('Notion API error');
  });

  it('logs notion_spec.status_updated event on success', async () => {
    const { records, destination } = makeLogCapture();
    const client = makeMockNotionClient();
    const app = makeMockApp();
    const publisher = new NotionPublisher(client, app as unknown as App, 'db-specs-id', { logDestination: destination });
    await publisher.updateStatus!('page-abc', 'Complete');
    expect(records.find(r => r['event'] === 'notion_spec.status_updated')).toBeDefined();
  });
});
