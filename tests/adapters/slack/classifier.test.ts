import { describe, it, expect } from 'vitest';
import { classifyMessage, classifyReaction } from '../../../src/adapters/slack/classifier.js';
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
      makeRegistry({ '100.0': 'idea-xyz' }),
    );
    expect(result.intent).toBe('thread_message');
    if (result.intent === 'thread_message') expect(result.request_id).toBe('idea-xyz');
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
});

describe('classifyReaction', () => {
  const EMOJIS = ['thumbsup', 'white_check_mark'];

  it('returns approval_signal for approval emoji on registered message', () => {
    const result = classifyReaction(
      { reaction: 'thumbsup', user: 'U999', item_ts: '100.0' },
      EMOJIS,
      makeRegistry({ '100.0': 'idea-xyz' }),
      BOT_ID,
    );
    expect(result.intent).toBe('approval_signal');
    if (result.intent === 'approval_signal') expect(result.request_id).toBe('idea-xyz');
  });

  it('returns ignore for non-approval emoji', () => {
    expect(classifyReaction(
      { reaction: 'wave', user: 'U999', item_ts: '100.0' },
      EMOJIS,
      makeRegistry({ '100.0': 'idea-xyz' }),
      BOT_ID,
    ).intent).toBe('ignore');
  });

  it('returns ignore for approval emoji on unregistered message', () => {
    expect(classifyReaction(
      { reaction: 'thumbsup', user: 'U999', item_ts: '999.0' },
      EMOJIS,
      makeRegistry(),
      BOT_ID,
    ).intent).toBe('ignore');
  });

  it('returns ignore for reaction from the bot itself', () => {
    expect(classifyReaction(
      { reaction: 'thumbsup', user: BOT_ID, item_ts: '100.0' },
      EMOJIS,
      makeRegistry({ '100.0': 'idea-xyz' }),
      BOT_ID,
    ).intent).toBe('ignore');
  });
});
