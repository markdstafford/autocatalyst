// src/adapters/slack/canvas-publisher.ts
import { readFileSync } from 'node:fs';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';

export interface CanvasPublisher {
  create(channel_id: string, thread_ts: string, spec_path: string): Promise<string>;
  update(canvas_id: string, spec_path: string): Promise<void>;
}

interface CanvasPublisherOptions {
  logDestination?: pino.DestinationStream;
}

export class SlackCanvasPublisher implements CanvasPublisher {
  private readonly app: App;
  private readonly logger: pino.Logger;

  constructor(app: App, options?: CanvasPublisherOptions) {
    this.app = app;
    this.logger = createLogger('canvas-publisher', { destination: options?.logDestination });
  }

  async create(channel_id: string, thread_ts: string, spec_path: string): Promise<string> {
    const content = readFileSync(spec_path, 'utf-8');

    // Create the canvas
    const createResult = await (this.app.client as unknown as {
      canvases: { create: (args: { title?: string; document_content: { type: string; markdown: string } }) => Promise<{ canvas_id: string }> }
    }).canvases.create({
      document_content: { type: 'markdown', markdown: content },
    });
    const canvas_id = createResult.canvas_id;

    // Post canvas link to thread
    await this.app.client.chat.postMessage({
      channel: channel_id,
      thread_ts,
      text: `Here's the spec: <https://app.slack.com/canvas/${canvas_id}|View spec canvas>`,
    });

    this.logger.info({ event: 'canvas.created', channel_id, thread_ts, canvas_id }, 'Canvas created');
    return canvas_id;
  }

  async update(canvas_id: string, spec_path: string): Promise<void> {
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
