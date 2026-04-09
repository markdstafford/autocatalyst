import { randomUUID } from 'node:crypto';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { HumanInterfaceAdapter } from '../human-interface-adapter.js';
import type { InboundEvent, Idea, SpecFeedback, ApprovalSignal } from '../../types/events.js';
import { classifyMessage, classifyReaction } from './classifier.js';
import { ThreadRegistry } from './thread-registry.js';

interface SlackAdapterConfig {
  channelName: string;
  approvalEmojis: string[];
}

interface SlackAdapterOptions {
  registry?: ThreadRegistry;
  logDestination?: pino.DestinationStream;
}

export class SlackAdapter implements HumanInterfaceAdapter {
  private readonly app: App;
  private readonly config: SlackAdapterConfig;
  private readonly registry: ThreadRegistry;
  private readonly logger: pino.Logger;

  private botUserId: string | undefined;
  private channelId: string | undefined;

  // AsyncIterable queue
  private readonly eventQueue: InboundEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  constructor(app: App, config: SlackAdapterConfig, options?: SlackAdapterOptions) {
    this.app = app;
    this.config = config;
    this.registry = options?.registry ?? new ThreadRegistry();
    this.logger = createLogger('slack-adapter', { destination: options?.logDestination });
  }

  async start(): Promise<void> {
    // Resolve bot user ID
    const authResult = await this.app.client.auth.test();
    if (typeof authResult.user_id !== 'string') {
      throw new Error('auth.test() did not return a user_id');
    }
    this.botUserId = authResult.user_id;

    // Resolve channel name → channel ID
    const listResult = await this.app.client.conversations.list({
      types: 'public_channel',
      limit: 1000,
    });
    // Warn if results were truncated — the target channel may be in a subsequent page
    if ((listResult as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor) {
      this.logger.warn(
        { event: 'slack.error', error: 'conversations.list result truncated — channel may not be found if workspace has >1000 channels' },
        'Channel list truncated; consider paginating if channel is not found',
      );
    }
    const channel = listResult.channels?.find(
      (c: { name?: string }) => c.name === this.config.channelName,
    );
    if (!channel || !('id' in channel) || typeof channel.id !== 'string') {
      this.logger.error(
        { event: 'slack.error', error: `channel not found: ${this.config.channelName}` },
        'Slack channel not found — adapter cannot start',
      );
      throw new Error(`Slack channel not found: ${this.config.channelName}`);
    }
    this.channelId = channel.id;
    this.logger.info(
      { event: 'slack.startup.channel_resolved', channel_name: this.config.channelName, channel_id: this.channelId },
      'Channel resolved',
    );

    // Register message handler (must happen before app.start())
    this.app.message(async ({ message }) => {
      // Skip non-regular messages (bot_message, message_changed, etc.)
      if ('subtype' in message && (message as { subtype?: string }).subtype !== undefined) return;
      // Filter to target channel
      if (!('channel' in message) || (message as { channel?: string }).channel !== this.channelId) return;

      const msg = message as {
        text?: string;
        user?: string;
        ts: string;
        thread_ts?: string;
        channel: string;
      };

      if (!msg.user) return; // no user field means it's a system/bot message

      const result = classifyMessage(
        { text: msg.text, user: msg.user, ts: msg.ts, thread_ts: msg.thread_ts },
        this.botUserId!,
        this.registry,
      );

      if (result.intent === 'ignore') {
        this.logger.debug(
          { event: 'slack.message.ignored', author: msg.user, channel_id: this.channelId },
          'Message ignored',
        );
        return;
      }

      this.logger.info(
        { event: 'slack.message.classified', author: msg.user, channel_id: this.channelId, intent: result.intent, thread_ts: msg.ts },
        'Message classified',
      );

      if (result.intent === 'new_idea') {
        const idea: Idea = {
          id: randomUUID(),
          source: 'slack',
          content: msg.text ?? '',
          author: msg.user,
          received_at: new Date().toISOString(),
          thread_ts: msg.ts,
          channel_id: this.channelId!,
        };

        // Post acknowledgement and register thread before emitting
        this.registry.register(msg.ts, idea.id);
        await this.postMessage(this.channelId!, msg.ts, "Got it — I'll work on a spec and post it here.");
        this.emit({ type: 'new_idea', payload: idea });

      } else if (result.intent === 'spec_feedback') {
        const feedback: SpecFeedback = {
          idea_id: result.idea_id,
          content: msg.text ?? '',
          author: msg.user,
          received_at: new Date().toISOString(),
          thread_ts: msg.thread_ts!,
          channel_id: this.channelId!,
        };

        await this.postMessage(this.channelId!, msg.thread_ts!, "Thanks — I'll incorporate that feedback.");
        this.emit({ type: 'spec_feedback', payload: feedback });
      }
    });

    // Register reaction handler
    this.app.event('reaction_added', async ({ event }) => {
      if (event.item.type !== 'message') return;
      if (event.item.channel !== this.channelId) return;

      // item_ts is the ts of the reacted-to message — only original idea messages are registered;
      // reactions on bot reply messages are intentionally ignored.
      const result = classifyReaction(
        { reaction: event.reaction, user: event.user, item_ts: event.item.ts },
        this.config.approvalEmojis,
        this.registry,
        this.botUserId!,
      );

      if (result.intent === 'ignore') {
        this.logger.debug(
          { event: 'slack.reaction.ignored', author: event.user, thread_ts: event.item.ts },
          'Reaction ignored',
        );
        return;
      }

      this.logger.info(
        { event: 'slack.reaction.classified', author: event.user, thread_ts: event.item.ts, intent: 'approval_signal' },
        'Reaction classified',
      );

      const signal: ApprovalSignal = {
        idea_id: result.idea_id,
        approver: event.user,
        emoji: event.reaction,
        received_at: new Date().toISOString(),
      };
      this.emit({ type: 'approval_signal', payload: signal });
    });

    // Start Bolt (opens Socket Mode WebSocket)
    await this.app.start();
    this.logger.info(
      { event: 'slack.connected', channel_id: this.channelId, channel_name: this.config.channelName },
      'Connected to Slack',
    );
  }

  async stop(): Promise<void> {
    await this.app.stop();
    // Events that arrive during app.stop() teardown are discarded intentionally —
    // stop() signals end-of-stream, remaining queued events will still be drained by receive().
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
    this.logger.warn(
      { event: 'slack.disconnected', reason: 'stop() called' },
      'Disconnected from Slack',
    );
  }

  async *receive(): AsyncIterable<InboundEvent> {
    while (!this.closed || this.eventQueue.length > 0) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      } else {
        await new Promise<void>(resolve => {
          this.waiter = resolve;
        });
      }
    }
  }

  private emit(event: InboundEvent): void {
    this.eventQueue.push(event);
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
  }

  private async postMessage(channel: string, thread_ts: string, text: string): Promise<void> {
    try {
      await this.app.client.chat.postMessage({ channel, thread_ts, text });
      this.logger.info(
        { event: 'slack.post.sent', channel_id: channel, thread_ts, intent: 'ack' },
        'Acknowledgement posted',
      );
    } catch (err) {
      this.logger.error(
        { event: 'slack.error', error: String(err) },
        'Failed to post message',
      );
    }
  }
}
