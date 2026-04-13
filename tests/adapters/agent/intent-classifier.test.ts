import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Intent } from '../../../src/adapters/agent/intent-classifier.js';
import { AnthropicIntentClassifier } from '../../../src/adapters/agent/intent-classifier.js';
import type { RunStage } from '../../../src/types/runs.js';

const nullDest = { write: () => {} };

// Helper: build a minimal Anthropic-like response
function makeApiResponse(content: string) {
  return {
    content: [{ type: 'text' as const, text: content }],
  };
}

// Mock type for the Anthropic messages.create call
type CreateFn = ReturnType<typeof vi.fn>;

function makeClassifier(createFn: CreateFn) {
  return new AnthropicIntentClassifier('test-api-key', {
    createFn,
    logDestination: nullDest,
  });
}

describe('AnthropicIntentClassifier — prompt construction', () => {
  it('classify sends the human message content in the prompt', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = makeClassifier(createFn);
    await classifier.classify('the wizard should not require all settings', 'reviewing_spec');
    const prompt = createFn.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('the wizard should not require all settings');
  });

  it('classify includes the current run stage in the prompt', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = makeClassifier(createFn);
    await classifier.classify('some message', 'reviewing_spec');
    const prompt = createFn.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('reviewing_spec');
  });

  it('prompt for reviewing_spec includes only spec_feedback and spec_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = makeClassifier(createFn);
    await classifier.classify('any message', 'reviewing_spec');
    const prompt = createFn.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('spec_feedback');
    expect(prompt).toContain('spec_approval');
    expect(prompt).not.toContain('implementation_feedback');
    expect(prompt).not.toContain('implementation_approval');
  });

  it('prompt for reviewing_implementation includes only implementation_feedback and implementation_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_feedback'));
    const classifier = makeClassifier(createFn);
    await classifier.classify('any message', 'reviewing_implementation');
    const prompt = createFn.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('implementation_feedback');
    expect(prompt).toContain('implementation_approval');
    expect(prompt).not.toContain('spec_feedback');
    expect(prompt).not.toContain('spec_approval');
  });

  it('prompt for awaiting_impl_input includes only implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_feedback'));
    const classifier = makeClassifier(createFn);
    await classifier.classify('go with option A', 'awaiting_impl_input');
    const prompt = createFn.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('implementation_feedback');
    expect(prompt).not.toContain('implementation_approval');
    expect(prompt).not.toContain('spec_feedback');
    expect(prompt).not.toContain('spec_approval');
  });
});

describe('AnthropicIntentClassifier — classification accuracy (reviewing_spec)', () => {
  it('"approved, go ahead and build it" → spec_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_approval'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('approved, go ahead and build it', 'reviewing_spec')).toBe('spec_approval');
  });

  it('"approved" (single word) → spec_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_approval'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('approved', 'reviewing_spec')).toBe('spec_approval');
  });

  it('"yes, this looks right, let\'s build it" → spec_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_approval'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify("yes, this looks right, let's build it", 'reviewing_spec')).toBe('spec_approval');
  });

  it('"the wizard shouldn\'t require all settings before exiting" → spec_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify("the wizard shouldn't require all settings before exiting", 'reviewing_spec')).toBe('spec_feedback');
  });

  it('"I think the scope is too broad here" → spec_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('I think the scope is too broad here', 'reviewing_spec')).toBe('spec_feedback');
  });

  it('"can you change the section about error handling?" → spec_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('can you change the section about error handling?', 'reviewing_spec')).toBe('spec_feedback');
  });
});

describe('AnthropicIntentClassifier — classification accuracy (reviewing_implementation)', () => {
  it('"looks good, ship it" → implementation_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_approval'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('looks good, ship it', 'reviewing_implementation')).toBe('implementation_approval');
  });

  it('"confirmed, send the PR" → implementation_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_approval'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('confirmed, send the PR', 'reviewing_implementation')).toBe('implementation_approval');
  });

  it('"LGTM, let\'s merge" → implementation_approval', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_approval'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify("LGTM, let's merge", 'reviewing_implementation')).toBe('implementation_approval');
  });

  it('"the custom step isn\'t working — it gets swallowed on add" → implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify("the custom step isn't working — it gets swallowed on add", 'reviewing_implementation')).toBe('implementation_feedback');
  });

  it('"I\'ve added feedback on the implementation page" → implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify("I've added feedback on the implementation page", 'reviewing_implementation')).toBe('implementation_feedback');
  });

  it('"there\'s a bug when I run the setup wizard with no args" → implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify("there's a bug when I run the setup wizard with no args", 'reviewing_implementation')).toBe('implementation_feedback');
  });
});

describe('AnthropicIntentClassifier — classification accuracy (awaiting_impl_input)', () => {
  it('"go with the subtype approach" → implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('go with the subtype approach', 'awaiting_impl_input')).toBe('implementation_feedback');
  });

  it('"use option A" → implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_feedback'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('use option A', 'awaiting_impl_input')).toBe('implementation_feedback');
  });
});

describe('AnthropicIntentClassifier — stage-intent validation', () => {
  it('model returns spec_approval for reviewing_implementation → retries once, falls back to implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_approval'));
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('some message', 'reviewing_implementation');
    expect(result).toBe('implementation_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('model returns implementation_approval for reviewing_spec → retries once, falls back to spec_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_approval'));
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('some message', 'reviewing_spec');
    expect(result).toBe('spec_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('model returns implementation_approval for awaiting_impl_input → retries once, falls back to implementation_feedback', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_approval'));
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('some message', 'awaiting_impl_input');
    expect(result).toBe('implementation_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('model returns invalid intent → retries once, falls back to conservative default', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('totally_unknown_intent'));
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('some message', 'reviewing_spec');
    expect(result).toBe('spec_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('first call returns invalid intent, second returns valid → uses second result', async () => {
    const createFn = vi.fn()
      .mockResolvedValueOnce(makeApiResponse('implementation_approval'))
      .mockResolvedValueOnce(makeApiResponse('spec_feedback'));
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('some message', 'reviewing_spec');
    expect(result).toBe('spec_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });
});

describe('AnthropicIntentClassifier — response parsing', () => {
  it('trims leading/trailing whitespace from model response', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('  spec_feedback  '));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('message', 'reviewing_spec')).toBe('spec_feedback');
  });

  it('extracts first token when response includes explanation', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_approval — the user is clearly approving'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('approved!', 'reviewing_spec')).toBe('spec_approval');
  });

  it('parses valid JSON wrapping the intent', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('"spec_feedback"'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('message', 'reviewing_spec')).toBe('spec_feedback');
  });

  it('empty response → falls back to conservative default', async () => {
    const createFn = vi.fn().mockResolvedValue(makeApiResponse(''));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('message', 'reviewing_spec')).toBe('spec_feedback');
  });
});

describe('AnthropicIntentClassifier — error handling', () => {
  it('HTTP 429 error → retries once; on second failure falls back to conservative default', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const createFn = vi.fn().mockRejectedValue(err);
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('message', 'reviewing_spec');
    expect(result).toBe('spec_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('HTTP 500 error → retries once; falls back to conservative default', async () => {
    const err = Object.assign(new Error('internal server error'), { status: 500 });
    const createFn = vi.fn().mockRejectedValue(err);
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('message', 'reviewing_implementation');
    expect(result).toBe('implementation_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('connection timeout → retries once; falls back to conservative default', async () => {
    const createFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('message', 'awaiting_impl_input');
    expect(result).toBe('implementation_feedback');
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('first call fails, second succeeds → uses second result', async () => {
    const createFn = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(makeApiResponse('spec_approval'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('approved', 'reviewing_spec')).toBe('spec_approval');
  });

  it('empty message string → falls back to conservative default without calling API', async () => {
    const createFn = vi.fn();
    const classifier = makeClassifier(createFn);
    const result = await classifier.classify('', 'reviewing_spec');
    expect(result).toBe('spec_feedback');
    expect(createFn).not.toHaveBeenCalled();
  });
});

describe('AnthropicIntentClassifier — conservative fallback defaults', () => {
  it('reviewing_spec defaults to spec_feedback', async () => {
    const createFn = vi.fn().mockRejectedValue(new Error('fail'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('message', 'reviewing_spec')).toBe('spec_feedback');
  });

  it('reviewing_implementation defaults to implementation_feedback', async () => {
    const createFn = vi.fn().mockRejectedValue(new Error('fail'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('message', 'reviewing_implementation')).toBe('implementation_feedback');
  });

  it('awaiting_impl_input defaults to implementation_feedback', async () => {
    const createFn = vi.fn().mockRejectedValue(new Error('fail'));
    const classifier = makeClassifier(createFn);
    expect(await classifier.classify('message', 'awaiting_impl_input')).toBe('implementation_feedback');
  });
});

describe('AnthropicIntentClassifier — logging', () => {
  it('emits intent.classified on successful classification with correct fields', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = new AnthropicIntentClassifier('key', { createFn, logDestination: dest });

    await classifier.classify('some feedback message', 'reviewing_spec');

    const classified = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'intent.classified');
    expect(classified).toBeDefined();
    expect(classified!['run_stage']).toBe('reviewing_spec');
    expect(classified!['classified_intent']).toBe('spec_feedback');
    expect(typeof classified!['message_length']).toBe('number');
  });

  it('emits intent.classification_failed when API call fails', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const createFn = vi.fn().mockRejectedValue(new Error('api down'));
    const classifier = new AnthropicIntentClassifier('key', { createFn, logDestination: dest });

    await classifier.classify('message', 'reviewing_spec');

    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'intent.classification_failed');
    expect(failed).toBeDefined();
    expect(failed!['run_stage']).toBe('reviewing_spec');
    expect(typeof failed!['error']).toBe('string');
  });

  it('emits intent.invalid_for_stage when model returns wrong-stage intent', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('implementation_approval'));
    const classifier = new AnthropicIntentClassifier('key', { createFn, logDestination: dest });

    await classifier.classify('message', 'reviewing_spec');

    const invalid = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'intent.invalid_for_stage');
    expect(invalid).toBeDefined();
    expect(invalid!['returned_intent']).toBe('implementation_approval');
    expect(invalid!['run_stage']).toBe('reviewing_spec');
    expect(Array.isArray(invalid!['valid_intents'])).toBe(true);
  });

  it('human message content never appears in any log event', async () => {
    const logs: string[] = [];
    const dest = { write: (line: string) => logs.push(line) };
    const createFn = vi.fn().mockResolvedValue(makeApiResponse('spec_feedback'));
    const classifier = new AnthropicIntentClassifier('key', { createFn, logDestination: dest });

    const secretMessage = 'super-secret-feedback-content-xyz123';
    await classifier.classify(secretMessage, 'reviewing_spec');

    for (const line of logs) {
      expect(line).not.toContain(secretMessage);
    }
  });
});
