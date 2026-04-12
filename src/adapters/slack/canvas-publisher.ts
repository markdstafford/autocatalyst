// src/adapters/slack/canvas-publisher.ts
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';

export interface SpecPublisher {
  create(channel_id: string, thread_ts: string, spec_path: string): Promise<string>;
  update(publisher_ref: string, spec_path: string, page_content?: string): Promise<void>;
  getPageMarkdown(publisher_ref: string): Promise<string>;
}

export function titleFromPath(spec_path: string): string {
  const slug = basename(spec_path, '.md')
    .replace(/^(feature|enhancement)-/, '')
    .replace(/-/g, ' ');
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

interface CanvasPublisherOptions {
  logDestination?: pino.DestinationStream;
}

export class SlackCanvasPublisher implements SpecPublisher {
  private readonly app: App;
  private readonly logger: pino.Logger;
  private workspaceUrl: string | undefined;
  private teamId: string | undefined;

  constructor(app: App, options?: CanvasPublisherOptions) {
    this.app = app;
    this.logger = createLogger('canvas-publisher', { destination: options?.logDestination });
  }

  private async resolveWorkspace(): Promise<void> {
    if (this.workspaceUrl && this.teamId) return;
    const auth = await this.app.client.auth.test();
    this.workspaceUrl = (auth.url as string).replace(/\/$/, '');
    this.teamId = auth.team_id as string;
  }

  private canvasUrl(canvas_id: string): string {
    return `${this.workspaceUrl}/docs/${this.teamId}/${canvas_id}`;
  }

  async create(channel_id: string, thread_ts: string, spec_path: string): Promise<string> {
    await this.resolveWorkspace();
    const content = readFileSync(spec_path, 'utf-8');
    const title = titleFromPath(spec_path);

    // Create the canvas
    const createResult = await (this.app.client as unknown as {
      canvases: {
        create: (args: { title?: string; document_content: { type: string; markdown: string } }) => Promise<{ canvas_id: string }>;
        access: { set: (args: { canvas_id: string; access_level: string; channel_ids: string[] }) => Promise<void> };
      }
    }).canvases.create({
      title,
      document_content: { type: 'markdown', markdown: content },
    });
    const canvas_id = createResult.canvas_id;

    // Grant write access to the channel so members can comment
    await (this.app.client as unknown as {
      canvases: { access: { set: (args: { canvas_id: string; access_level: string; channel_ids: string[] }) => Promise<void> } }
    }).canvases.access.set({
      canvas_id,
      access_level: 'write',
      channel_ids: [channel_id],
    });

    // Post canvas link to thread
    await this.app.client.chat.postMessage({
      channel: channel_id,
      thread_ts,
      text: `Here's the spec: <${this.canvasUrl(canvas_id)}|View spec canvas>`,
    });

    this.logger.info({ event: 'canvas.created', channel_id, thread_ts, canvas_id }, 'Canvas created');
    return canvas_id;
  }

  async getPageMarkdown(_publisher_ref: string): Promise<string> {
    return '';
  }

  async update(canvas_id: string, spec_path: string, _page_content?: string): Promise<void> {
    const content = readFileSync(spec_path, 'utf-8');

    await (this.app.client as unknown as {
      canvases: { edit: (args: { canvas_id: string; changes: Array<{ operation: string; document_content: { type: string; markdown: string } }> }) => Promise<void> }
    }).canvases.edit({
      canvas_id,
      changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: content } }],
    });

    this.logger.info({ event: 'canvas.updated', canvas_id }, 'Canvas updated');
  }
}
