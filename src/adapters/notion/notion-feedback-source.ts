// src/adapters/notion/notion-feedback-source.ts
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { NotionClient } from './notion-client.js';
import type { FeedbackComment, FeedbackSource } from '../../types/feedback-source.js';
export type { FeedbackComment, FeedbackSource } from '../../types/feedback-source.js';

interface NotionFeedbackSourceOptions {
  bot_user_id?: string;
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
  private readonly bot_user_id?: string;
  private readonly logger: pino.Logger;

  constructor(client: NotionClient, options?: NotionFeedbackSourceOptions) {
    this.client = client;
    this.bot_user_id = options?.bot_user_id;
    this.logger = createLogger('notion-feedback-source', { destination: options?.logDestination });
  }

  async fetch(publisher_ref: string): Promise<FeedbackComment[]> {
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

    // Filter out threads where the last comment is from the bot
    let botSkippedCount = 0;
    if (this.bot_user_id) {
      for (const [discussion_id, threadComments] of threadMap) {
        const lastComment = threadComments[threadComments.length - 1];
        if (lastComment.created_by.id === this.bot_user_id) {
          threadMap.delete(discussion_id);
          botSkippedCount++;
        }
      }
    }

    const result: FeedbackComment[] = [];
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

    this.logger.debug({ event: 'notion_comments.fetched', publisher_ref, comment_count: result.length, bot_skipped_count: botSkippedCount }, 'Fetched Notion comments');
    return result;
  }

  async reply(publisher_ref: string, comment_id: string, response: string): Promise<void> {
    await this.client.comments.create({
      discussion_id: comment_id,
      rich_text: [{ type: 'text', text: { content: response } }],
    } as Parameters<NotionClient['comments']['create']>[0]);

    this.logger.debug({ event: 'notion_comment.replied', publisher_ref, comment_id }, 'Replied to Notion comment');
  }

}
