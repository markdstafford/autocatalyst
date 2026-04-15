import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { NotionClient } from './notion-client.js';

export interface FeedbackItem {
  id: string;
  text: string;
  resolved: boolean;
  conversation: string[];
}

export interface ImplementationFeedbackPage {
  create(
    parent_page_id: string,
    spec_page_url: string,
    summary: string,
    testing_instructions: string,
  ): Promise<string>;

  readFeedback(page_id: string): Promise<FeedbackItem[]>;

  update(
    page_id: string,
    options: {
      summary?: string;
      resolved_items?: Array<{
        id: string;
        resolution_comment: string;
      }>;
    },
  ): Promise<void>;
}

interface NotionImplementationFeedbackPageOptions {
  logDestination?: pino.DestinationStream;
}

export class NotionImplementationFeedbackPage implements ImplementationFeedbackPage {
  private readonly client: NotionClient;
  private readonly logger: pino.Logger;

  constructor(client: NotionClient, options?: NotionImplementationFeedbackPageOptions) {
    this.client = client;
    this.logger = createLogger('implementation-feedback-page', { destination: options?.logDestination });
  }

  async create(
    parent_page_id: string,
    spec_page_url: string,
    summary: string,
    testing_instructions: string,
  ): Promise<string> {
    const response = await this.client.pages.create({
      parent: { type: 'page_id', page_id: parent_page_id },
      properties: {
        title: {
          title: [{ text: { content: 'Implementation feedback' } }],
        },
      },
      children: [
        // Spec link bookmark
        {
          type: 'bookmark',
          bookmark: { url: spec_page_url },
        } as never,
        // Summary section
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Summary' } }] },
        } as never,
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: summary } }] },
        } as never,
        // Testing instructions section
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Testing instructions' } }] },
        } as never,
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: testing_instructions } }] },
        } as never,
        // Feedback section (empty to-do list)
        {
          type: 'heading_2',
          heading_2: { rich_text: [{ text: { content: 'Feedback' } }] },
        } as never,
      ],
    });

    const page_id = (response as { id: string }).id;
    this.logger.info(
      { event: 'impl_feedback_page.created', page_id, parent_page_id },
      'Implementation feedback page created',
    );
    return page_id;
  }

  async readFeedback(page_id: string): Promise<FeedbackItem[]> {
    const blocksResponse = await this.client.blocks.children.list({ block_id: page_id });
    const blocks = blocksResponse.results as Array<{
      id: string;
      type: string;
      has_children?: boolean;
      to_do?: { rich_text: Array<{ plain_text: string }>; checked: boolean };
      _children?: unknown[]; // test helper only
    }>;

    const feedbackItems: FeedbackItem[] = [];

    for (const block of blocks) {
      if (block.type !== 'to_do' || !block.to_do) continue;

      const text = block.to_do.rich_text.map((r: { plain_text: string }) => r.plain_text).join('');
      const resolved = block.to_do.checked;
      const conversation: string[] = [];

      if (block.has_children || (block._children && (block._children as unknown[]).length > 0)) {
        const childResponse = await this.client.blocks.children.list({ block_id: block.id });
        const children = childResponse.results as Array<{
          type: string;
          paragraph?: { rich_text: Array<{ plain_text: string }> };
        }>;
        for (const child of children) {
          if (child.type === 'paragraph' && child.paragraph) {
            const childText = child.paragraph.rich_text.map((r: { plain_text: string }) => r.plain_text).join('');
            if (childText) conversation.push(childText);
          }
        }
      }

      feedbackItems.push({ id: block.id, text, resolved, conversation });
    }

    this.logger.debug(
      { event: 'implementation.feedback_read', page_id, item_count: feedbackItems.length },
      'Feedback read from Notion page',
    );
    return feedbackItems;
  }

  async update(
    page_id: string,
    options: {
      summary?: string;
      resolved_items?: Array<{
        id: string;
        resolution_comment: string;
      }>;
    },
  ): Promise<void> {
    // Fetch current markdown content
    let markdown = await this.client.pages.getMarkdown(page_id);

    // If resolved items provided, build a map of block id → resolution info
    // We need to read current blocks to find which to-do items match by ID
    const resolvedMap = new Map<string, string>();
    if (options.resolved_items && options.resolved_items.length > 0) {
      for (const item of options.resolved_items) {
        resolvedMap.set(item.id, item.resolution_comment);
      }

      // Read current blocks to get the to-do item text for each resolved ID
      const blocksResponse = await this.client.blocks.children.list({ block_id: page_id });
      const blocks = blocksResponse.results as Array<{
        id: string;
        type: string;
        to_do?: { rich_text: Array<{ plain_text: string }>; checked: boolean };
      }>;

      // Apply resolutions to markdown: find `- [ ] <text>` lines and check them, add sub-bullet
      for (const block of blocks) {
        if (block.type !== 'to_do' || !block.to_do) continue;
        const resolutionComment = resolvedMap.get(block.id);
        if (!resolutionComment) continue;

        const itemText = block.to_do.rich_text.map((r: { plain_text: string }) => r.plain_text).join('');
        // Replace `- [ ] <text>` with `- [x] <text>\n  - ✓ <resolutionComment>`
        const uncheckedPattern = new RegExp(
          `(^- \\[ \\] ${escapeRegex(itemText)})`,
          'm',
        );
        markdown = markdown.replace(
          uncheckedPattern,
          `- [x] ${itemText}\n  - ✓ ${resolutionComment}`,
        );
      }
    }

    // Replace summary if provided
    if (options.summary !== undefined) {
      // Replace content between ## Summary heading and next ## heading or EOF
      const summaryPattern = /(## Summary\n\n)[\s\S]*?(?=\n## |\n*$)/;
      markdown = markdown.replace(summaryPattern, `$1${options.summary}\n`);
    }

    await this.client.pages.updateMarkdown(page_id, {
      type: 'replace_content',
      replace_content: { new_str: markdown },
    });

    this.logger.info(
      { event: 'implementation.feedback_updated', page_id, resolved_count: options.resolved_items?.length ?? 0 },
      'Implementation feedback page updated',
    );
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
