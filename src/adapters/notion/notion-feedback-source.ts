// src/adapters/notion/notion-feedback-source.ts
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { NotionClient } from './notion-client.js';
import type { NotionComment } from '../agent/spec-generator.js';

export interface FeedbackSource {
  fetch(publisher_ref: string): Promise<NotionComment[]>;
  reply(publisher_ref: string, comment_id: string, response: string): Promise<void>;
  resolve(publisher_ref: string, comment_ids: string[]): Promise<void>;
}

interface NotionFeedbackSourceOptions {
  logDestination?: pino.DestinationStream;
}

interface NotionCommentRecord {
  id: string;
  discussion_id: string;
  resolved: boolean;
  rich_text: Array<{ plain_text: string }>;
  created_by: { id: string; name?: string };
}

export class NotionFeedbackSource implements FeedbackSource {
  private readonly client: NotionClient;
  private readonly logger: pino.Logger;

  constructor(client: NotionClient, options?: NotionFeedbackSourceOptions) {
    this.client = client;
    this.logger = createLogger('notion-feedback-source', { destination: options?.logDestination });
  }

  async fetch(publisher_ref: string): Promise<NotionComment[]> {
    // Collect all raw comment records from the page and every direct child block.
    // The Notion API only returns comments for the specific block_id supplied — there
    // is no recursive or "all comments on page" endpoint — so we must enumerate child
    // blocks and query each one individually.
    const allComments: NotionCommentRecord[] = [];

    // Page-level comments
    const pageResponse = await this.client.comments.list({ block_id: publisher_ref } as Parameters<NotionClient['comments']['list']>[0]);
    allComments.push(...(pageResponse.results as unknown as NotionCommentRecord[]));

    // Inline comments on direct child blocks (paginated)
    let cursor: string | undefined;
    do {
      const blocksResponse = await this.client.blocks.children.list({
        block_id: publisher_ref,
        ...(cursor ? { start_cursor: cursor } : {}),
      } as Parameters<NotionClient['blocks']['children']['list']>[0]);

      const blocks = blocksResponse.results as unknown as Array<{ id: string }>;
      for (const block of blocks) {
        const blockComments = await this.client.comments.list({ block_id: block.id } as Parameters<NotionClient['comments']['list']>[0]);
        allComments.push(...(blockComments.results as unknown as NotionCommentRecord[]));
      }

      cursor = (blocksResponse as unknown as { has_more: boolean; next_cursor?: string }).has_more
        ? ((blocksResponse as unknown as { next_cursor?: string }).next_cursor ?? undefined)
        : undefined;
    } while (cursor);

    // Group comments by discussion_id, only include unresolved
    const threadMap = new Map<string, NotionCommentRecord[]>();
    for (const comment of allComments) {
      if (comment.resolved) continue;
      const existing = threadMap.get(comment.discussion_id) ?? [];
      existing.push(comment);
      threadMap.set(comment.discussion_id, existing);
    }

    const result: NotionComment[] = [];
    for (const [discussion_id, threadComments] of threadMap) {
      const body = threadComments
        .map(c => {
          const author = c.created_by.name ?? c.created_by.id;
          const text = c.rich_text.map(rt => rt.plain_text).join('');
          return `${author}: ${text}`;
        })
        .join('\n');
      result.push({ id: discussion_id, body });
    }

    this.logger.debug({ event: 'notion_comments.fetched', publisher_ref, comment_count: result.length }, 'Fetched Notion comments');
    return result;
  }

  async reply(publisher_ref: string, comment_id: string, response: string): Promise<void> {
    await this.client.comments.create({
      discussion_id: comment_id,
      rich_text: [{ type: 'text', text: { content: response } }],
    } as Parameters<NotionClient['comments']['create']>[0]);

    this.logger.debug({ event: 'notion_comment.replied', publisher_ref, comment_id }, 'Replied to Notion comment');
  }

  async resolve(publisher_ref: string, comment_ids: string[]): Promise<void> {
    for (const comment_id of comment_ids) {
      try {
        await this.client.comments.update(comment_id);
        this.logger.debug({ event: 'notion_comments.resolved', publisher_ref, comment_id }, 'Resolved Notion comment');
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 405) {
          this.logger.warn({ event: 'notion_comments.resolve_skipped', publisher_ref, comment_id, status }, 'Notion comment resolve not supported; skipping');
        } else {
          throw err;
        }
      }
    }
  }
}
