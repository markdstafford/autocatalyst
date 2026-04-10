// src/adapters/notion/notion-publisher.ts
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { markdownToBlocks } from '@tryfabric/martian';
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
    const blocks = markdownToBlocks(content);

    const page = await this.client.pages.create({
      parent: { page_id: this.parent_page_id },
      properties: {
        title: [{ type: 'text', text: { content: title } }],
      } as unknown as Parameters<NotionClient['pages']['create']>[0]['properties'],
      children: blocks as Parameters<NotionClient['pages']['create']>[0]['children'],
    });

    const pageId = page.id;
    const pageUrl = `https://notion.so/${pageId}`;

    await this.app.client.chat.postMessage({
      channel: channel_id,
      thread_ts,
      text: `Here's the spec: <${pageUrl}|View spec in Notion>`,
    });

    this.logger.info({ event: 'notion_page.created', channel_id, thread_ts, page_id: pageId }, 'Notion page created');
    return pageId;
  }

  async update(publisher_ref: string, spec_path: string): Promise<void> {
    const content = readFileSync(spec_path, 'utf-8');
    const blocks = markdownToBlocks(content);

    // Fetch existing child block IDs
    const existing = await this.client.blocks.children.list({ block_id: publisher_ref });
    const blockIds = existing.results.map((b: { id: string }) => b.id);

    // Delete each existing block sequentially
    for (const block_id of blockIds) {
      await this.client.blocks.delete({ block_id });
    }

    // Append new blocks
    await this.client.blocks.children.append({
      block_id: publisher_ref,
      children: blocks as Parameters<NotionClient['blocks']['children']['append']>[0]['children'],
    });

    this.logger.info({ event: 'notion_page.updated', page_id: publisher_ref, block_count: blocks.length }, 'Notion page updated');
  }
}
