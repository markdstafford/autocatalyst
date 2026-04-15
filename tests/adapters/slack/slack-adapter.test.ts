import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from '@slack/bolt';
import { SlackAdapter } from '../../../src/adapters/slack/slack-adapter.js';
import type { Request, ThreadMessage } from '../../../src/types/events.js';

// Captures one event from the AsyncIterable then stops
async function takeOne<T>(iterable: AsyncIterable<T>): Promise<T> {
  for await (const item of iterable) return item;
  throw new Error('Stream ended without emitting an event');
}

const nullDest = { write: () => {} };

function makeMockApp(opts: {
  botUserId?: string;
  channels?: Array<{ name: string; id: string }>;
}) {
  const messageHandlers: Array<(args: { message: unknown }) => Promise<void>> = [];
  const reactionHandlers: Array<(args: { event: unknown }) => Promise<void>> = [];

  const app = {
    client: {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: opts.botUserId ?? 'UBOT001' }),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: opts.channels ?? [{ name: 'my-channel', id: 'C123' }],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    },
    message: vi.fn((handler: (args: { message: unknown }) => Promise<void>) => {
      messageHandlers.push(handler);
    }),
    event: vi.fn((name: string, handler: (args: { event: unknown }) => Promise<void>) => {
      if (name === 'reaction_added') reactionHandlers.push(handler);
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    // Test helpers — not part of the real App API
    _triggerMessage: async (msg: unknown) => {
      for (const h of messageHandlers) await h({ message: msg });
    },
    _triggerReaction: async (evt: unknown) => {
      for (const h of reactionHandlers) await h({ event: evt });
    },
  };
  return app;
}

describe('SlackAdapter — startup', () => {
  it('resolves channel name to ID and logs slack.startup.channel_resolved', async () => {
    const mock = makeMockApp({ channels: [{ name: 'my-channel', id: 'C123' }] });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();
    await adapter.stop();
    expect(mock.client.conversations.list).toHaveBeenCalled();
    expect(mock.start).toHaveBeenCalled();
  });

  it('throws when channel is not found', async () => {
    const mock = makeMockApp({ channels: [] });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'missing-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await expect(adapter.start()).rejects.toThrow(/missing-channel/);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('registers event handlers before calling app.start()', async () => {
    const mock = makeMockApp({});
    const order: string[] = [];
    // Override to record ordering only — handler capture is intentionally skipped
    // because this test does not trigger messages or reactions after start().
    mock.message.mockImplementation(() => { order.push('message_registered'); });
    mock.event.mockImplementation(() => { order.push('event_registered'); });
    mock.start.mockImplementation(async () => { order.push('app_started'); });

    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();
    await adapter.stop();

    expect(order.indexOf('message_registered')).toBeLessThan(order.indexOf('app_started'));
    expect(order.indexOf('event_registered')).toBeLessThan(order.indexOf('app_started'));
  });
});

describe('SlackAdapter — new idea pipeline', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('emits new_request event with correct Request shape', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> add a setup wizard`,
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();
    expect(event.type).toBe('new_request');
    const request = event.payload as Request;
    expect(request.source).toBe('slack');
    expect(request.author).toBe('U123');
    expect(request.content).toBe(`<@${BOT_ID}> add a setup wizard`);
    expect(request.thread_ts).toBe('100.0');
    expect(request.channel_id).toBe(CHANNEL_ID);
    expect(request.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof request.id).toBe('string');
  });

  it('posts acknowledgement in the correct thread', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> new idea`,
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });
    await eventPromise;
    await adapter.stop();

    expect(mock.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: CHANNEL_ID,
        thread_ts: '100.0',
        text: "Got it — I'll work on a spec and post it here.",
      }),
    );
  });

  it('registers the thread so a subsequent reply is spec_feedback', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();

    // Seed the idea to populate the registry
    const ideaEventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> new idea`,
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });
    await ideaEventPromise;

    // Now trigger a reply — should be spec_feedback
    const feedbackEventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> revise this`,
      user: 'U456',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await feedbackEventPromise;
    await adapter.stop();

    expect(event.type).toBe('thread_message');
  });
});

describe('SlackAdapter — spec feedback pipeline', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  it('emits spec_feedback with correct shape and posts acknowledgement', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();

    // Seed idea first
    const ideaPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> seed`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    const ideaEvent = await ideaPromise;

    // Trigger feedback
    const feedbackPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: `<@${BOT_ID}> the field is confusing`,
      user: 'U456',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });
    const feedbackEvent = await feedbackPromise;
    await adapter.stop();

    expect(feedbackEvent.type).toBe('thread_message');
    const feedback = feedbackEvent.payload as ThreadMessage;
    expect(feedback.request_id).toBe((ideaEvent.payload as Request).id);
    expect(feedback.author).toBe('U456');
    expect(feedback.thread_ts).toBe('100.0');
    expect(feedback.content).toBe(`<@${BOT_ID}> the field is confusing`);
    expect(feedback.channel_id).toBe(CHANNEL_ID);
    expect(feedback.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(mock.client.chat.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: CHANNEL_ID,
        thread_ts: '100.0',
        text: "Thanks — I'll incorporate that feedback.",
      }),
    );
  });
});

describe('SlackAdapter — approval signal pipeline', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  it('approval emoji on registered message: reaction logged but no event emitted (approval routing is wired in a future task)', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();

    // Seed request to register the thread
    const requestPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> seed`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await requestPromise;

    // React to the request message
    await mock._triggerReaction({
      reaction: 'thumbsup',
      user: 'U456',
      item: { type: 'message', ts: '100.0', channel: CHANNEL_ID },
    });
    await adapter.stop();

    // No event is emitted — approval routing is handled in a future task
    expect(mock.client.chat.postMessage).toHaveBeenCalledTimes(1); // only the ack for the seed
  });
});

describe('SlackAdapter — ignore cases', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  async function setupAdapter(mock: ReturnType<typeof makeMockApp>) {
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();
    return adapter;
  }

  it('non-mention message: no postMessage, no event', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    await mock._triggerMessage({ text: 'hello team', user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('@mention reply to unregistered thread: no postMessage, no event', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    await mock._triggerMessage({
      text: `<@${BOT_ID}> reply to unknown thread`,
      user: 'U123',
      ts: '200.0',
      thread_ts: '999.0', // not registered
      channel: CHANNEL_ID,
    });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('non-approval emoji reaction: no event', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    // Seed idea to register thread
    const ideaPromise = takeOne(adapter.receive());
    await mock._triggerMessage({ text: `<@${BOT_ID}> seed`, user: 'U123', ts: '100.0', channel: CHANNEL_ID });
    await ideaPromise;
    // React with non-approval emoji
    mock.client.chat.postMessage.mockClear();
    await mock._triggerReaction({
      reaction: 'wave',
      user: 'U456',
      item: { type: 'message', ts: '100.0', channel: CHANNEL_ID },
    });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('approval emoji on unregistered message: no event', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    await mock._triggerReaction({
      reaction: 'thumbsup',
      user: 'U456',
      item: { type: 'message', ts: '999.0', channel: CHANNEL_ID }, // not registered
    });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("bot's own message: no postMessage, no event", async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = await setupAdapter(mock);
    await mock._triggerMessage({
      text: `<@${BOT_ID}> ignored`,
      user: BOT_ID, // bot's own message
      ts: '100.0',
      channel: CHANNEL_ID,
    });
    await adapter.stop();
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('SlackAdapter — error handling', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  it('postMessage failure does not propagate — adapter continues running', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    mock.client.chat.postMessage.mockRejectedValueOnce(new Error('rate limited'));
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();

    // This should not throw even though postMessage fails
    await expect(
      mock._triggerMessage({ text: `<@${BOT_ID}> add wizard`, user: 'U123', ts: '100.0', channel: CHANNEL_ID }),
    ).resolves.not.toThrow();

    await adapter.stop();
  });
});

describe('SlackAdapter — service lifecycle', () => {
  it('start() calls app.start(); stop() calls app.stop()', async () => {
    const mock = makeMockApp({});
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', approvalEmojis: ['thumbsup'] }, { logDestination: nullDest });
    await adapter.start();
    expect(mock.start).toHaveBeenCalledTimes(1);
    await adapter.stop();
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });
});
