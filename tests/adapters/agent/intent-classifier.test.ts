import { describe, it, expect, vi } from 'vitest';
import type { Intent, ClassificationContext } from '../../../src/adapters/agent/intent-classifier.js';
import { AnthropicIntentClassifier } from '../../../src/adapters/agent/intent-classifier.js';

const nullDest = { write: () => {} };

function makeApiResponse(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

type CreateFn = ReturnType<typeof vi.fn>;

function makeClassifier(createFn: CreateFn) {
  return new AnthropicIntentClassifier('test-api-key', {
    createFn,
    logDestination: nullDest,
  });
}

describe('AnthropicIntentClassifier — unified taxonomy: valid intents by context', () => {
  it('new_thread: model returns idea → idea', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('idea'));
    expect(await makeClassifier(cf).classify('add a wizard', 'new_thread')).toBe('idea');
  });

  it('new_thread: model returns bug → bug', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('bug'));
    expect(await makeClassifier(cf).classify('this is broken', 'new_thread')).toBe('bug');
  });

  it('new_thread: model returns question → question', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('question'));
    expect(await makeClassifier(cf).classify('how does X work?', 'new_thread')).toBe('question');
  });

  it('new_thread: model returns ignore → ignore', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('ignore'));
    expect(await makeClassifier(cf).classify('hey team', 'new_thread')).toBe('ignore');
  });

  it('new_thread: model returns feedback (not valid) → falls back to idea', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    expect(await makeClassifier(cf).classify('some message', 'new_thread')).toBe('idea');
  });

  it('intake: model returns idea → idea (upgrade path)', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('idea'));
    expect(await makeClassifier(cf).classify('actually build this', 'intake')).toBe('idea');
  });

  it('intake: model returns question → question', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('question'));
    expect(await makeClassifier(cf).classify('what does this do?', 'intake')).toBe('question');
  });

  it('intake: model returns feedback (not valid) → falls back to idea', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    expect(await makeClassifier(cf).classify('some message', 'intake')).toBe('idea');
  });

  it('reviewing_spec: model returns feedback → feedback', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    expect(await makeClassifier(cf).classify('change this section', 'reviewing_spec')).toBe('feedback');
  });

  it('reviewing_spec: model returns approval → approval', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('approval'));
    expect(await makeClassifier(cf).classify('looks good, build it', 'reviewing_spec')).toBe('approval');
  });

  it('reviewing_spec: model returns question → question', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('question'));
    expect(await makeClassifier(cf).classify('what does this mean?', 'reviewing_spec')).toBe('question');
  });

  it('reviewing_spec: model returns idea (not valid) → falls back to feedback', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('idea'));
    expect(await makeClassifier(cf).classify('some message', 'reviewing_spec')).toBe('feedback');
  });

  it('reviewing_implementation: model returns feedback → feedback', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    expect(await makeClassifier(cf).classify('the button is broken', 'reviewing_implementation')).toBe('feedback');
  });

  it('reviewing_implementation: model returns approval → approval', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('approval'));
    expect(await makeClassifier(cf).classify('ship it', 'reviewing_implementation')).toBe('approval');
  });

  it('awaiting_impl_input: model returns feedback → feedback', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    expect(await makeClassifier(cf).classify('go with option A', 'awaiting_impl_input')).toBe('feedback');
  });

  it('awaiting_impl_input: model returns approval (not valid) → falls back to feedback', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('approval'));
    expect(await makeClassifier(cf).classify('some message', 'awaiting_impl_input')).toBe('feedback');
  });

  it('new_thread: model returns file_issues → file_issues', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('file_issues'));
    expect(await makeClassifier(cf).classify('please file these issues: ...', 'new_thread')).toBe('file_issues');
  });

  it('intake: model returns file_issues → file_issues', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('file_issues'));
    expect(await makeClassifier(cf).classify('file an issue for X', 'intake')).toBe('file_issues');
  });

  it('reviewing_spec: model returns file_issues (not valid) → falls back to feedback', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('file_issues'));
    expect(await makeClassifier(cf).classify('file these', 'reviewing_spec')).toBe('feedback');
  });
});

describe('AnthropicIntentClassifier — prompt construction', () => {
  it('classify sends the human message content in the prompt', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    await makeClassifier(cf).classify('the wizard should not require all settings', 'reviewing_spec');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('the wizard should not require all settings');
  });

  it('classify includes the context in the prompt', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    await makeClassifier(cf).classify('some message', 'reviewing_spec');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('reviewing_spec');
  });

  it('prompt for new_thread includes idea, bug, question, ignore and not feedback/approval', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('idea'));
    await makeClassifier(cf).classify('any message', 'new_thread');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('idea');
    expect(prompt).toContain('bug');
    expect(prompt).toContain('question');
    expect(prompt).toContain('ignore');
    expect(prompt).not.toContain('feedback');
    expect(prompt).not.toContain('approval');
  });

  it('prompt for reviewing_spec includes feedback, approval, question, ignore and not idea/bug', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    await makeClassifier(cf).classify('any message', 'reviewing_spec');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('feedback');
    expect(prompt).toContain('approval');
    expect(prompt).toContain('question');
    expect(prompt).toContain('ignore');
    expect(prompt).not.toContain('idea');
    expect(prompt).not.toContain('bug');
  });

  it('prompt for awaiting_impl_input includes feedback, question, ignore and not approval', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    await makeClassifier(cf).classify('any message', 'awaiting_impl_input');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('feedback');
    expect(prompt).toContain('question');
    expect(prompt).not.toContain('approval');
  });
});

describe('AnthropicIntentClassifier — response parsing', () => {
  it('trims whitespace from model response', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('  feedback  '));
    expect(await makeClassifier(cf).classify('message', 'reviewing_spec')).toBe('feedback');
  });

  it('extracts first token when response includes explanation', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('approval — user is clearly approving'));
    expect(await makeClassifier(cf).classify('looks good', 'reviewing_spec')).toBe('approval');
  });

  it('parses valid JSON wrapping the intent', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('"feedback"'));
    expect(await makeClassifier(cf).classify('message', 'reviewing_spec')).toBe('feedback');
  });

  it('empty response → falls back to conservative default', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse(''));
    expect(await makeClassifier(cf).classify('message', 'reviewing_spec')).toBe('feedback');
  });
});

describe('AnthropicIntentClassifier — error handling', () => {
  it('API error → retries once; falls back to conservative default', async () => {
    const cf = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await makeClassifier(cf).classify('message', 'reviewing_spec');
    expect(result).toBe('feedback');
    expect(cf).toHaveBeenCalledTimes(2);
  });

  it('first call fails, second succeeds → uses second result', async () => {
    const cf = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(makeApiResponse('approval'));
    expect(await makeClassifier(cf).classify('approved', 'reviewing_spec')).toBe('approval');
  });

  it('empty message → falls back without calling API', async () => {
    const cf = vi.fn();
    expect(await makeClassifier(cf).classify('', 'reviewing_spec')).toBe('feedback');
    expect(cf).not.toHaveBeenCalled();
  });
});

describe('AnthropicIntentClassifier — conservative fallbacks', () => {
  it('new_thread defaults to idea', async () => {
    const cf = vi.fn().mockRejectedValue(new Error('fail'));
    expect(await makeClassifier(cf).classify('message', 'new_thread')).toBe('idea');
  });

  it('intake defaults to idea', async () => {
    const cf = vi.fn().mockRejectedValue(new Error('fail'));
    expect(await makeClassifier(cf).classify('message', 'intake')).toBe('idea');
  });

  it('reviewing_spec defaults to feedback', async () => {
    const cf = vi.fn().mockRejectedValue(new Error('fail'));
    expect(await makeClassifier(cf).classify('message', 'reviewing_spec')).toBe('feedback');
  });

  it('reviewing_implementation defaults to feedback', async () => {
    const cf = vi.fn().mockRejectedValue(new Error('fail'));
    expect(await makeClassifier(cf).classify('message', 'reviewing_implementation')).toBe('feedback');
  });

  it('awaiting_impl_input defaults to feedback', async () => {
    const cf = vi.fn().mockRejectedValue(new Error('fail'));
    expect(await makeClassifier(cf).classify('message', 'awaiting_impl_input')).toBe('feedback');
  });
});

describe('AnthropicIntentClassifier — logging', () => {
  it('emits intent.classified on success', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    const classifier = new AnthropicIntentClassifier('key', { createFn: cf, logDestination: dest });
    await classifier.classify('some message', 'reviewing_spec');
    const ev = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'intent.classified');
    expect(ev).toBeDefined();
    expect(ev!['classified_intent']).toBe('feedback');
  });

  it('emits intent.classification_failed on API error', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const cf = vi.fn().mockRejectedValue(new Error('api down'));
    const classifier = new AnthropicIntentClassifier('key', { createFn: cf, logDestination: dest });
    await classifier.classify('message', 'reviewing_spec');
    const ev = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'intent.classification_failed');
    expect(ev).toBeDefined();
  });

  it('emits intent.invalid_for_context when model returns wrong-context intent', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const cf = vi.fn().mockResolvedValue(makeApiResponse('bug'));
    const classifier = new AnthropicIntentClassifier('key', { createFn: cf, logDestination: dest });
    await classifier.classify('message', 'reviewing_spec');
    const ev = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'intent.invalid_for_context');
    expect(ev).toBeDefined();
    expect(ev!['returned_intent']).toBe('bug');
  });

  it('human message content never appears in any log event', async () => {
    const logs: string[] = [];
    const dest = { write: (line: string) => logs.push(line) };
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    const classifier = new AnthropicIntentClassifier('key', { createFn: cf, logDestination: dest });
    const secret = 'super-secret-feedback-content-xyz123';
    await classifier.classify(secret, 'reviewing_spec');
    for (const line of logs) expect(line).not.toContain(secret);
  });
});

describe('AnthropicIntentClassifier — chore intent', () => {
  it('new_thread: model returns chore → chore', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('chore'));
    expect(await makeClassifier(cf).classify('we should upgrade Node to v22', 'new_thread')).toBe('chore');
  });

  it('intake: model returns chore → chore', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('chore'));
    expect(await makeClassifier(cf).classify('clean up the test helpers', 'intake')).toBe('chore');
  });

  it('reviewing_spec: model returns chore (not valid) → falls back to feedback', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('chore'));
    expect(await makeClassifier(cf).classify('some message', 'reviewing_spec')).toBe('feedback');
  });
});

describe('AnthropicIntentClassifier — prompt includes chore for new_thread and intake', () => {
  it('prompt for new_thread includes chore', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('idea'));
    await makeClassifier(cf).classify('any message', 'new_thread');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('chore');
  });

  it('prompt for intake includes chore', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('idea'));
    await makeClassifier(cf).classify('any message', 'intake');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('chore');
  });

  it('prompt for reviewing_spec does not include chore', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    await makeClassifier(cf).classify('any message', 'reviewing_spec');
    const prompt = cf.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain('chore');
  });
});

describe('AnthropicIntentClassifier — file_issues intent', () => {
  it('list-of-items message classifies as file_issues', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('file_issues'));
    expect(
      await makeClassifier(cf).classify('please file these: 1) add dark mode 2) fix login bug', 'new_thread'),
    ).toBe('file_issues');
  });

  it('single explicit filing message classifies as file_issues', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('file_issues'));
    expect(
      await makeClassifier(cf).classify('please file an issue for the missing pagination on the dashboard', 'new_thread'),
    ).toBe('file_issues');
  });
});

describe('AnthropicIntentClassifier — ALL_INTENTS snapshot', () => {
  it('ALL_INTENTS includes file_issues', async () => {
    // Exercise the classifier with all intents to verify file_issues is in the taxonomy.
    // We use the fact that intentDescriptions must cover every intent — if file_issues
    // is returned by the model and it's in the valid set, it will be accepted.
    const cf = vi.fn().mockResolvedValue(makeApiResponse('file_issues'));
    const result = await makeClassifier(cf).classify('file these issues', 'new_thread');
    expect(result).toBe('file_issues');
  });
});

describe('AnthropicIntentClassifier — pr_open context', () => {
  it('classifies approval message as approval in pr_open context', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('approval'));
    expect(await makeClassifier(cf).classify('looks good, merge it', 'pr_open')).toBe('approval');
  });

  it('classifies question message as question in pr_open context', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('question'));
    expect(await makeClassifier(cf).classify('what branch was used?', 'pr_open')).toBe('question');
  });

  it('classifies ignore message as ignore in pr_open context', async () => {
    const cf = vi.fn().mockResolvedValue(makeApiResponse('ignore'));
    expect(await makeClassifier(cf).classify('ignore this', 'pr_open')).toBe('ignore');
  });

  it('falls back to ignore when model returns feedback (invalid for pr_open) after two retries', async () => {
    // feedback is not valid for pr_open context; classifier retries and falls back to ignore
    const cf = vi.fn().mockResolvedValue(makeApiResponse('feedback'));
    const classifier = new AnthropicIntentClassifier('key', { createFn: cf, logDestination: nullDest });
    const result = await classifier.classify('please update the tests', 'pr_open');
    expect(result).toBe('ignore'); // conservative fallback for pr_open
    expect(cf).toHaveBeenCalledTimes(2); // two attempts before fallback
  });

  it('conservative fallback for pr_open is ignore when API always fails', async () => {
    const cf = vi.fn().mockRejectedValue(new Error('API error'));
    const classifier = new AnthropicIntentClassifier('key', { createFn: cf, logDestination: nullDest });
    const result = await classifier.classify('some message', 'pr_open');
    expect(result).toBe('ignore');
  });
});
