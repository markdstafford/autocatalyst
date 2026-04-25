import { describe, it, expect, vi } from 'vitest';
import type { CommandEvent } from '../../../src/types/commands.js';
import type { IntentClassifier } from '../../../src/types/intent.js';
import { makeClassifyIntentHandler } from '../../../src/core/commands/classify-intent-command.js';

function makeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    command: 'classify-intent',
    args: [],
    source: 'slack',
    channel_id: 'C001',
    thread_ts: '1000.0',
    author: 'U001',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeClassifier(classifyImpl?: (msg: string, ctx: string) => Promise<string>) {
  return {
    classify: classifyImpl
      ? vi.fn().mockImplementation(classifyImpl)
      : vi.fn().mockResolvedValue('question'),
  } as unknown as IntentClassifier & { classify: ReturnType<typeof vi.fn> };
}

describe('makeClassifyIntentHandler — empty args', () => {
  it('posts usage message and does not call classify()', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: [] }), reply);

    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0] as string).toContain('Usage');
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});

describe('makeClassifyIntentHandler — context override', () => {
  it('args [reviewing_spec, is, this, right?] → classify("is this right?", "reviewing_spec")', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['reviewing_spec', 'is', 'this', 'right?'] }), reply);

    expect(classifier.classify).toHaveBeenCalledWith('is this right?', 'reviewing_spec');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('Context: `reviewing_spec`');
  });

  it('args [awaiting_impl_input, more, context] → classify("more context", "awaiting_impl_input")', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['awaiting_impl_input', 'more', 'context'] }), reply);

    expect(classifier.classify).toHaveBeenCalledWith('more context', 'awaiting_impl_input');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('Context: `awaiting_impl_input`');
  });

  it('args [reviewing_spec] with no message text → usage message, classify() not called', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['reviewing_spec'] }), reply);

    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0] as string).toContain('Usage');
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});

describe('makeClassifyIntentHandler — no context override (defaults to new_thread)', () => {
  it('args [hello, world] → classify("hello world", "new_thread")', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['hello', 'world'] }), reply);

    expect(classifier.classify).toHaveBeenCalledWith('hello world', 'new_thread');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('Context: `new_thread`');
  });

  it('args [foo, message] where "foo" is not a valid context → classify("foo message", "new_thread")', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['foo', 'message'] }), reply);

    expect(classifier.classify).toHaveBeenCalledWith('foo message', 'new_thread');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('Context: `new_thread`');
  });

  it('args [new_thread, message] → "new_thread" is valid → classify("message", "new_thread")', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['new_thread', 'message'] }), reply);

    expect(classifier.classify).toHaveBeenCalledWith('message', 'new_thread');
    const msg = reply.mock.calls[0][0] as string;
    expect(msg).toContain('Context: `new_thread`');
  });
});

describe('makeClassifyIntentHandler — reply format', () => {
  it('reply is exactly *Classification result*\\nContext: `new_thread`\\nIntent: `question`', async () => {
    const classifier = makeClassifier();
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler(makeEvent({ args: ['hello', 'world'] }), reply);

    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0]).toBe(
      '*Classification result*\nContext: `new_thread`\nIntent: `question`',
    );
  });
});

describe('makeClassifyIntentHandler — error propagation', () => {
  it('classify() throws → error propagates out of handler; reply not called', async () => {
    const error = new Error('API failure');
    const classifier = makeClassifier(() => Promise.reject(error));
    const handler = makeClassifyIntentHandler(classifier);
    const reply = vi.fn().mockResolvedValue(undefined);

    await expect(handler(makeEvent({ args: ['hello'] }), reply)).rejects.toThrow('API failure');
    expect(reply).not.toHaveBeenCalled();
  });
});
