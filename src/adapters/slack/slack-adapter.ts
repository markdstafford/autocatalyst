import { randomUUID } from 'node:crypto';
import type { App } from '@slack/bolt';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { HumanInterfaceAdapter } from '../human-interface-adapter.js';
import type { InboundEvent, Request, ThreadMessage } from '../../types/events.js';
import { classifyMessage } from './classifier.js';
import { EMOJI_COMMAND_TABLE } from './classifier.js';
import type { CommandEvent } from '../../types/commands.js';
import { ThreadRegistry } from './thread-registry.js';
import type { RepoEntry, ChannelRepoMap, PreRepoEntry } from '../../types/config.js';

type SlackAdapterConfig =
  | { channelName: string }
  | { repoEntries: PreRepoEntry[] };

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
  private _resolvedChannelId: string | undefined;
  private _resolvedChannelRepoMap: ChannelRepoMap | null = null;
  private _channelsResolved = false;

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

  /**
   * Resolves configured channel name(s) to IDs using conversations.list.
   * Idempotent — skips re-resolution on subsequent calls.
   * Single-repo: caches channel_id; logs slack.startup.channel_resolved.
   * Multi-repo: builds ChannelRepoMap; logs slack.startup.channels_resolved.
   * Throws (logging slack.startup.channel_resolution_failed) if any channel can't be resolved.
   */
  async resolveChannels(): Promise<void> {
    if (this._channelsResolved) return;

    const listResult = await this.app.client.conversations.list({
      types: 'public_channel',
      limit: 1000,
    });

    if ((listResult as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor) {
      this.logger.warn(
        { event: 'slack.error', error: 'conversations.list result truncated — channel may not be found if workspace has >1000 channels' },
        'Channel list truncated; consider paginating if channel is not found',
      );
    }

    if ('channelName' in this.config) {
      const channelName = this.config.channelName;
      const channel = listResult.channels?.find(
        (c: { name?: string }) => c.name === channelName,
      );
      if (!channel || !('id' in channel) || typeof channel.id !== 'string') {
        this.logger.error(
          { event: 'slack.startup.channel_resolution_failed', channel_name: channelName, error: `channel not found: ${channelName}` },
          'Slack channel not found — adapter cannot start',
        );
        throw new Error(`Slack channel not found: ${channelName}`);
      }
      this._resolvedChannelId = channel.id;
      this.logger.info(
        { event: 'slack.startup.channel_resolved', channel_name: channelName, channel_id: this._resolvedChannelId },
        'Channel resolved',
      );
    } else {
      const repoEntries = this.config.repoEntries;
      const channelRepoMap: ChannelRepoMap = new Map();
      for (const entry of repoEntries) {
        const channel = listResult.channels?.find(
          (c: { name?: string }) => c.name === entry.channel_name,
        );
        if (!channel || !('id' in channel) || typeof channel.id !== 'string') {
          this.logger.error(
            { event: 'slack.startup.channel_resolution_failed', channel_name: entry.channel_name, error: `channel not found: ${entry.channel_name}` },
            'Slack channel not found — adapter cannot start',
          );
          throw new Error(`Slack channel not found: ${entry.channel_name}`);
        }
        channelRepoMap.set(channel.id, {
          channel_id: channel.id,
          repo_url: entry.repo_url,
          workspace_root: entry.workspace_root,
        });
      }
      this._resolvedChannelRepoMap = channelRepoMap;
      this.logger.info(
        {
          event: 'slack.startup.channels_resolved',
          channels: [...channelRepoMap.values()].map(e => ({
            channel_id: e.channel_id,
            repo_url: e.repo_url,
          })),
        },
        'All channels resolved',
      );
    }

    this._channelsResolved = true;
  }

  /** Returns the resolved channel ID for single-repo mode. Valid after resolveChannels() or start(). */
  getChannelId(): string {
    if (this._resolvedChannelId === undefined) {
      throw new Error('resolveChannels() has not been called or channel is not yet resolved');
    }
    return this._resolvedChannelId;
  }

  /** Returns the resolved ChannelRepoMap for multi-repo mode. Valid after resolveChannels() in multi-repo mode. */
  getChannelRepoMap(): ChannelRepoMap {
    if (this._resolvedChannelRepoMap === null) {
      throw new Error('resolveChannels() has not been called or this adapter is not in multi-repo mode');
    }
    return this._resolvedChannelRepoMap;
  }

  async start(): Promise<void> {
    // Resolve bot user ID
    const authResult = await this.app.client.auth.test();
    if (typeof authResult.user_id !== 'string') {
      throw new Error('auth.test() did not return a user_id');
    }
    this.botUserId = authResult.user_id;

    // Resolve channel name(s) → channel ID(s) (idempotent)
    await this.resolveChannels();

    // Build set of allowed channel IDs for filtering
    const allowedChannelIds = new Set<string>(
      'channelName' in this.config
        ? [this._resolvedChannelId!]
        : [...this._resolvedChannelRepoMap!.keys()],
    );

    // Register message handler (must happen before app.start())
    this.app.message(async ({ message }) => {
      // Skip non-regular messages (bot_message, message_changed, etc.)
      if ('subtype' in message && (message as { subtype?: string }).subtype !== undefined) return;
      // Filter to target channel(s)
      const msgChannel = ('channel' in message) ? (message as { channel?: string }).channel : undefined;
      if (!msgChannel || !allowedChannelIds.has(msgChannel)) {
        this.logger.debug(
          { event: 'slack.event.channel_filtered', channel_id: msgChannel },
          'Message filtered — not in allowed channels',
        );
        return;
      }

      const channelId = msgChannel;

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
          { event: 'slack.message.ignored', author: msg.user, channel_id: channelId },
          'Message ignored',
        );
        return;
      }

      if (result.intent === 'command') {
        const commandEvent: CommandEvent = {
          command: result.command,
          args: result.args,
          source: 'slack',
          channel_id: channelId,
          thread_ts: msg.thread_ts ?? msg.ts,
          author: msg.user,
          received_at: new Date().toISOString(),
          inferred_context: {
            request_id: this.registry.resolve(msg.thread_ts ?? msg.ts),
          },
        };
        this.logger.info(
          { event: 'slack.command.received', author: msg.user, channel_id: channelId, command: result.command, thread_ts: msg.thread_ts ?? msg.ts },
          'Command received',
        );
        this.emit({ type: 'command', payload: commandEvent });
        return;
      }

      this.logger.info(
        { event: 'slack.message.classified', author: msg.user, channel_id: channelId, intent: result.intent, thread_ts: msg.ts },
        'Message classified',
      );

      if (result.intent === 'new_request') {
        const request: Request = {
          id: randomUUID(),
          source: 'slack',
          content: msg.text ?? '',
          author: msg.user,
          received_at: new Date().toISOString(),
          thread_ts: msg.ts,
          channel_id: channelId,
        };

        // Post acknowledgement and register thread before emitting
        this.registry.register(msg.ts, request.id);
        await this.postMessage(channelId, msg.ts, "Got it — I'll work on a spec and post it here.");
        this.emit({ type: 'new_request', payload: request });

      } else if (result.intent === 'thread_message') {
        const message: ThreadMessage = {
          request_id: result.request_id,
          content: msg.text ?? '',
          author: msg.user,
          received_at: new Date().toISOString(),
          thread_ts: msg.thread_ts!,
          channel_id: channelId,
        };

        await this.postMessage(channelId, msg.thread_ts!, "Thanks — I'll incorporate that feedback.");
        this.emit({ type: 'thread_message', payload: message });
      }
    });

    // Register reaction_added handler for command-via-reaction
    this.app.event('reaction_added', async ({ event: reactionEvent }) => {
      const reaction = reactionEvent as {
        reaction: string;
        user: string;
        item: { type: string; channel?: string; ts: string };
      };
      if (reaction.item.type !== 'message') return;
      if (!reaction.item.channel || !allowedChannelIds.has(reaction.item.channel)) {
        this.logger.debug(
          { event: 'slack.event.channel_filtered', channel_id: reaction.item.channel },
          'Reaction filtered — not in allowed channels',
        );
        return;
      }

      const commandName = EMOJI_COMMAND_TABLE[reaction.reaction];
      if (!commandName) {
        this.logger.debug({ event: 'slack.reaction.ignored', emoji: reaction.reaction }, 'Reaction ignored');
        return;
      }

      let reactedThreadTs: string = reaction.item.ts;
      try {
        const historyResult = await this.app.client.conversations.history({
          channel: reaction.item.channel!,
          latest: reaction.item.ts,
          limit: 1,
          inclusive: true,
        });
        const reactedMessage = historyResult.messages?.[0];
        if (reactedMessage?.thread_ts) {
          reactedThreadTs = reactedMessage.thread_ts as string;
        }
      } catch (err) {
        this.logger.warn(
          { event: 'slack.error', error: String(err) },
          'Failed to fetch reacted-to message; using item.ts as thread_ts',
        );
      }

      const commandEvent: CommandEvent = {
        command: commandName,
        args: [],
        source: 'slack',
        channel_id: reaction.item.channel!,
        thread_ts: reactedThreadTs,
        author: reaction.user,
        received_at: new Date().toISOString(),
        inferred_context: {
          request_id: this.registry.resolve(reactedThreadTs),
        },
      };
      this.logger.info(
        { event: 'slack.command.received', author: reaction.user, channel_id: reaction.item.channel, command: commandName, thread_ts: reactedThreadTs },
        'Reaction command received',
      );
      this.emit({ type: 'command', payload: commandEvent });
    });

    // Start Bolt (opens Socket Mode WebSocket)
    await this.app.start();
    this.logger.info(
      { event: 'slack.connected', channel_count: allowedChannelIds.size },
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

  isConnected(): boolean {
    return !this.closed;
  }
}
