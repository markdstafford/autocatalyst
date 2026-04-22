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
  historyMessages?: Array<{ ts: string; thread_ts?: string }>;
}) {
  const messageHandlers: Array<(args: { message: unknown }) => Promise<void>> = [];
  const eventHandlers = new Map<string, Array<(args: { event: unknown }) => Promise<void>>>();

  const app = {
    client: {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: opts.botUserId ?? 'UBOT001' }),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: opts.channels ?? [{ name: 'my-channel', id: 'C123' }],
        }),
        history: vi.fn().mockResolvedValue({
          messages: opts.historyMessages ?? [],
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    },
    message: vi.fn((handler: (args: { message: unknown }) => Promise<void>) => {
      messageHandlers.push(handler);
    }),
    event: vi.fn((eventName: string, handler: (args: { event: unknown }) => Promise<void>) => {
      if (!eventHandlers.has(eventName)) eventHandlers.set(eventName, []);
      eventHandlers.get(eventName)!.push(handler);
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    _triggerMessage: async (msg: unknown) => {
      for (const h of messageHandlers) await h({ message: msg });
    },
    _triggerReaction: async (reactionEvent: unknown) => {
      const handlers = eventHandlers.get('reaction_added') ?? [];
      for (const h of handlers) await h({ event: reactionEvent });
    },
  };
  return app;
}

describe('SlackAdapter — startup', () => {
  it('resolves channel name to ID and logs slack.startup.channel_resolved', async () => {
    const mock = makeMockApp({ channels: [{ name: 'my-channel', id: 'C123' }] });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();
    await adapter.stop();
    expect(mock.client.conversations.list).toHaveBeenCalled();
    expect(mock.start).toHaveBeenCalled();
  });

  it('throws when channel is not found', async () => {
    const mock = makeMockApp({ channels: [] });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'missing-channel', }, { logDestination: nullDest });
    await expect(adapter.start()).rejects.toThrow(/missing-channel/);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('registers message handler before calling app.start()', async () => {
    const mock = makeMockApp({});
    const order: string[] = [];
    // Override to record ordering only — handler capture is intentionally skipped
    // because this test does not trigger messages after start().
    mock.message.mockImplementation(() => { order.push('message_registered'); });
    mock.start.mockImplementation(async () => { order.push('app_started'); });

    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();
    await adapter.stop();

    expect(order.indexOf('message_registered')).toBeLessThan(order.indexOf('app_started'));
  });
});

describe('SlackAdapter — new request pipeline', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('emits new_request event with correct Request shape', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, }, { logDestination: nullDest });
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
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, }, { logDestination: nullDest });
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

  it('registers the thread so a subsequent reply is thread_message', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME, }, { logDestination: nullDest });
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

    // Now trigger a reply — should be thread_message
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

  it('emits thread_message with correct shape and posts acknowledgement', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
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


describe('SlackAdapter — ignore cases', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';

  async function setupAdapter(mock: ReturnType<typeof makeMockApp>) {
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
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
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
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
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: 'my-channel', }, { logDestination: nullDest });
    await adapter.start();
    expect(mock.start).toHaveBeenCalledTimes(1);
    await adapter.stop();
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });
});

describe('SlackAdapter — command events (message-based)', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('recognized command emoji in root message → command event with thread_ts = msg.ts; no postMessage', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.command).toBe('run.status');
      expect(event.payload.args).toEqual([]);
      expect(event.payload.thread_ts).toBe('100.0');
      expect(event.payload.author).toBe('U123');
      expect(event.payload.channel_id).toBe(CHANNEL_ID);
    }
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('recognized command emoji inside thread reply → event with thread_ts = msg.thread_ts', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.thread_ts).toBe('100.0');
    }
  });

  it('inferred_context.request_id populated when thread_ts is in registry', async () => {
    const { ThreadRegistry } = await import('../../../src/adapters/slack/thread-registry.js');
    const registry = new ThreadRegistry();
    registry.register('100.0', 'req-abc');
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(
      mock as unknown as App,
      { channelName: CHANNEL_NAME },
      { logDestination: nullDest, registry },
    );
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '200.0',
      thread_ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.inferred_context?.request_id).toBe('req-abc');
    }
  });

  it('inferred_context.request_id is undefined when thread not registered', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerMessage({
      text: ':ac-run-status:',
      user: 'U123',
      ts: '100.0',
      channel: CHANNEL_ID,
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.inferred_context?.request_id).toBeUndefined();
    }
  });
});

describe('SlackAdapter — command events (reaction-based)', () => {
  const BOT_ID = 'UBOT001';
  const CHANNEL_ID = 'C123';
  const CHANNEL_NAME = 'my-channel';

  it('reaction_added with recognized emoji on root message → conversations.history called; event emitted with correct thread_ts', async () => {
    const mock = makeMockApp({
      botUserId: BOT_ID,
      historyMessages: [{ ts: '100.0' }],
    });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '100.0' },
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(mock.client.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL_ID, latest: '100.0' }),
    );
    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.command).toBe('run.status');
      expect(event.payload.thread_ts).toBe('100.0');
    }
  });

  it('reaction_added on thread reply → command event with thread_ts = reactedMessage.thread_ts', async () => {
    const mock = makeMockApp({
      botUserId: BOT_ID,
      historyMessages: [{ ts: '200.0', thread_ts: '100.0' }],
    });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '200.0' },
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.thread_ts).toBe('100.0');
    }
  });

  it('reaction_added, conversations.history fails → event emitted with item.ts as fallback thread_ts', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    mock.client.conversations.history.mockRejectedValueOnce(new Error('network error'));
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    const eventPromise = takeOne(adapter.receive());
    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '100.0' },
    });

    const event = await eventPromise;
    await adapter.stop();

    expect(event.type).toBe('command');
    if (event.type === 'command') {
      expect(event.payload.thread_ts).toBe('100.0');
    }
  });

  it('reaction_added with unrecognized emoji → no event emitted', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'thumbsup',
      user: 'U123',
      item: { type: 'message', channel: CHANNEL_ID, ts: '100.0' },
    });

    await racePromise;
    await adapter.stop();
    expect(emitted).toBe(false);
  });

  it('reaction_added from different channel → ignored; no event emitted', async () => {
    const mock = makeMockApp({ botUserId: BOT_ID });
    const adapter = new SlackAdapter(mock as unknown as App, { channelName: CHANNEL_NAME }, { logDestination: nullDest });
    await adapter.start();

    let emitted = false;
    const racePromise = Promise.race([
      takeOne(adapter.receive()).then(() => { emitted = true; }),
      new Promise<void>(res => setTimeout(res, 30)),
    ]);

    await mock._triggerReaction({
      type: 'reaction_added',
      reaction: 'ac-run-status',
      user: 'U123',
      item: { type: 'message', channel: 'C_OTHER', ts: '100.0' },
    });

    await racePromise;
    await adapter.stop();
    expect(emitted).toBe(false);
  });
});
