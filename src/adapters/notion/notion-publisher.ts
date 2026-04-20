// src/adapters/notion/notion-publisher.ts
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { NotionClient } from './notion-client.js';
import { titleFromPath } from '../../types/publisher.js';
import type { SpecPublisher, SpecEntryStatus } from '../../types/publisher.js';
import { stripAllHtml } from './markdown-diff.js';

interface NotionPublisherOptions {
  logDestination?: pino.DestinationStream;
  repo_name?: string;
}

export class NotionPublisher implements SpecPublisher {
  private readonly client: NotionClient;
  private readonly app: App;
  private readonly specs_database_id: string;
  private readonly options?: NotionPublisherOptions;
  private readonly logger: pino.Logger;

  constructor(
    client: NotionClient,
    app: App,
    specs_database_id: string,
    options?: NotionPublisherOptions,
  ) {
    this.client = client;
    this.app = app;
    this.specs_database_id = specs_database_id;
    this.options = options;
    this.logger = createLogger('notion-publisher', { destination: options?.logDestination });
  }

  async create(channel_id: string, thread_ts: string, spec_path: string): Promise<string> {
    const content = readFileSync(spec_path, 'utf-8');
    const title = titleFromPath(spec_path);
    const filename = basename(spec_path);
    const frontmatter = this.parseFrontmatter(spec_path);

    // Resolve supersedes relation if set
    let supersedingPageId: string | undefined;
    const supersedes = frontmatter['supersedes'];
    if (supersedes) {
      supersedingPageId = await this.resolveFilenameToPageId(String(supersedes));
    }

    // Build typed properties
    const properties: Record<string, unknown> = {
      Title: { title: [{ type: 'text', text: { content: title } }] },
      Filename: { rich_text: [{ type: 'text', text: { content: filename } }] },
      Status: { status: { name: 'Speccing' } },
      'Specced by': {
        rich_text: [{ type: 'text', text: { content: String(frontmatter['specced_by'] ?? '') } }],
      },
      'Last updated': { date: { start: String(frontmatter['last_updated'] ?? new Date().toISOString().slice(0, 10)) } },
    };

    if (this.options?.repo_name) {
      properties['Repo / Codebase'] = { select: { name: this.options.repo_name } };
    }
    if (frontmatter['issue'] != null) {
      properties['Issue #'] = { number: frontmatter['issue'] as number };
    }
    if (frontmatter['implemented_by'] != null) {
      properties['Implemented by'] = {
        rich_text: [{ type: 'text', text: { content: String(frontmatter['implemented_by']) } }],
      };
    }
    if (supersedingPageId) {
      properties['Superseded by / Supersedes'] = { relation: [{ id: supersedingPageId }] };
    }

    const page = await this.client.pages.create({
      parent: { database_id: this.specs_database_id } as unknown as Parameters<NotionClient['pages']['create']>[0]['parent'],
      properties: properties as unknown as Parameters<NotionClient['pages']['create']>[0]['properties'],
    });

    const pageId = page.id;

    await this.client.pages.updateMarkdown(pageId, {
      type: 'replace_content',
      replace_content: { new_str: content },
    });

    const pageUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;

    await this.app.client.chat.postMessage({
      channel: channel_id,
      thread_ts,
      text: `Here's the spec: <${pageUrl}|View spec in Notion>`,
    });

    this.logger.info(
      { event: 'notion_spec.properties_created', channel_id, thread_ts, page_id: pageId },
      'Spec database entry created',
    );
    return pageId;
  }

  async getPageMarkdown(publisher_ref: string, stripHtml = false): Promise<string> {
    const raw = await this.client.pages.getMarkdown(publisher_ref);
    return stripHtml ? stripAllHtml(raw) : raw;
  }

  async update(publisher_ref: string, spec_path: string, page_content?: string): Promise<void> {
    const content = page_content ?? readFileSync(spec_path, 'utf-8');

    await this.client.pages.updateMarkdown(publisher_ref, {
      type: 'replace_content',
      replace_content: { new_str: content },
    });

    // Sync frontmatter properties from spec file on disk
    const frontmatter = this.parseFrontmatter(spec_path);

    const propertiesToUpdate: Record<string, unknown> = {
      'Last updated': { date: { start: String(frontmatter['last_updated'] ?? new Date().toISOString().slice(0, 10)) } },
    };

    if (frontmatter['implemented_by'] != null) {
      propertiesToUpdate['Implemented by'] = {
        rich_text: [{ type: 'text', text: { content: String(frontmatter['implemented_by']) } }],
      };
    }

    const superseded_by = frontmatter['superseded_by'];
    if (superseded_by) {
      const supersededByPageId = await this.resolveFilenameToPageId(String(superseded_by));
      if (supersededByPageId) {
        propertiesToUpdate['Status'] = { status: { name: 'Superseded' } };
        propertiesToUpdate['Superseded by / Supersedes'] = { relation: [{ id: supersededByPageId }] };
      }
    }

    await this.client.pages.updateProperties(publisher_ref, propertiesToUpdate);

    this.logger.info(
      { event: 'notion_spec.properties_updated', page_id: publisher_ref },
      'Spec database entry updated',
    );
  }

  async updateStatus(publisher_ref: string, status: SpecEntryStatus): Promise<void> {
    await this.client.pages.updateProperties(publisher_ref, {
      Status: { status: { name: status } },
    });
    this.logger.info(
      { event: 'notion_spec.status_updated', page_id: publisher_ref, status },
      'Spec status updated',
    );
  }

  private parseFrontmatter(spec_path: string): Record<string, unknown> {
    let content: string;
    try {
      content = readFileSync(spec_path, 'utf-8');
    } catch {
      return {};
    }
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match || !match[1] || !match[1].trim()) return {};
    try {
      const parsed = parseYaml(match[1]);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private async resolveFilenameToPageId(filename: string): Promise<string | undefined> {
    const result = await this.client.databases.query(this.specs_database_id, {
      filter: { property: 'Filename', rich_text: { equals: filename } },
    });
    if (result.results.length === 0) {
      this.logger.warn(
        { event: 'notion_spec.filename_lookup_failed', filename },
        'Could not resolve spec filename to page ID',
      );
      return undefined;
    }
    return result.results[0].id;
  }
}
