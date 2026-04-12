// src/adapters/notion/notion-publisher.ts
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { NotionClient } from './notion-client.js';
import type { SpecPublisher } from '../slack/canvas-publisher.js';

interface NotionPublisherOptions {
  logDestination?: pino.DestinationStream;
}

export class NotionPublisher implements SpecPublisher {
  private readonly client: NotionClient;
  private readonly app: App;
  private readonly parent_page_id: string;
  private readonly logger: pino.Logger;

  constructor(
    client: NotionClient,
    app: App,
    parent_page_id: string,
    options?: NotionPublisherOptions,
  ) {
    this.client = client;
    this.app = app;
    this.parent_page_id = parent_page_id;
    this.logger = createLogger('notion-publisher', { destination: options?.logDestination });
  }

  private titleFromPath(spec_path: string): string {
    const slug = basename(spec_path, '.md')
      .replace(/^(feature|enhancement)-/, '')
      .replace(/-/g, ' ');
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  }

  async create(channel_id: string, thread_ts: string, spec_path: string): Promise<string> {
    const content = readFileSync(spec_path, 'utf-8');
    const title = this.titleFromPath(spec_path);

    const page = await this.client.pages.create({
      parent: { page_id: this.parent_page_id },
      properties: {
        title: [{ type: 'text', text: { content: title } }],
      } as unknown as Parameters<NotionClient['pages']['create']>[0]['properties'],
    });

    const pageId = page.id;

    await this.client.pages.updateMarkdown(pageId, { type: 'replace_content', replace_content: { new_str: content } });

    const pageUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;

    await this.app.client.chat.postMessage({
      channel: channel_id,
      thread_ts,
      text: `Here's the spec: <${pageUrl}|View spec in Notion>`,
    });

    this.logger.info({ event: 'notion_page.created', channel_id, thread_ts, page_id: pageId }, 'Notion page created');
    return pageId;
  }

  async getPageMarkdown(publisher_ref: string): Promise<string> {
    return this.client.pages.getMarkdown(publisher_ref);
  }

  async update(publisher_ref: string, spec_path: string, page_content?: string): Promise<void> {
    const content = page_content ?? readFileSync(spec_path, 'utf-8');

    await this.client.pages.updateMarkdown(publisher_ref, {
      type: 'replace_content',
      replace_content: { new_str: content },
    });

    this.logger.info({ event: 'notion_page.updated', page_id: publisher_ref }, 'Notion page updated');
  }
}
