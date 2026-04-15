import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../../../src/adapters/slack/classifier.js';
import { ThreadRegistry } from '../../../src/adapters/slack/thread-registry.js';

const BOT_ID = 'UBOT001';

function makeRegistry(entries: Record<string, string> = {}): ThreadRegistry {
  const r = new ThreadRegistry();
  for (const [ts, id] of Object.entries(entries)) r.register(ts, id);
  return r;
}

describe('classifyMessage', () => {
  it('returns ignore when message has no @mention', () => {
    expect(classifyMessage(
      { text: 'hello world', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns ignore when message text is undefined', () => {
    expect(classifyMessage(
      { text: undefined, user: 'U999', ts: '100.0' },
      'UBOT001',
      new ThreadRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns new_request for @mention in root message (no thread_ts)', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> add a setup wizard`, user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('new_request');
  });

  it('returns new_request for @mention when thread_ts equals ts', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> start an idea`, user: 'U999', ts: '100.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('new_request');
  });

  it('returns thread_message for @mention reply to registered thread', () => {
    const result = classifyMessage(
      { text: `<@${BOT_ID}> that field is confusing`, user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry({ '100.0': 'request-xyz' }),
    );
    expect(result.intent).toBe('thread_message');
    if (result.intent === 'thread_message') expect(result.request_id).toBe('request-xyz');
  });

  it('returns ignore for @mention reply to unregistered thread', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> something`, user: 'U999', ts: '200.0', thread_ts: '999.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns ignore for messages from the bot itself', () => {
    expect(classifyMessage(
      { text: `<@${BOT_ID}> ignored`, user: BOT_ID, ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('does not false-positive when botUserId is a substring of another user ID', () => {
    // BOT_ID is UBOT001; message mentions UBOT0011 (longer, different user)
    expect(classifyMessage(
      { text: '<@UBOT0011> hello', user: 'U999', ts: '100.0' },
      BOT_ID,
      makeRegistry(),
    ).intent).toBe('ignore');
  });

  it('returns ignore for in-thread message mentioning only another user (not bot)', () => {
    expect(classifyMessage(
      { text: '<@UOTHER> what do you think?', user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry({ '100.0': 'request-xyz' }),
    ).intent).toBe('ignore');
  });

  it('returns thread_message for in-thread message mentioning both bot and another user', () => {
    const result = classifyMessage(
      { text: `<@${BOT_ID}> <@UOTHER> please review`, user: 'U999', ts: '200.0', thread_ts: '100.0' },
      BOT_ID,
      makeRegistry({ '100.0': 'request-xyz' }),
    );
    expect(result.intent).toBe('thread_message');
    if (result.intent === 'thread_message') expect(result.request_id).toBe('request-xyz');
  });
});
