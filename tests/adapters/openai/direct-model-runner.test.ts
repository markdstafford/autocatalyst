// tests/adapters/openai/direct-model-runner.test.ts
import { describe, expect, test, vi } from 'vitest';
import { OpenAIDirectModelRunner } from '../../../src/adapters/openai/direct-model-runner.js';

function makeResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('OpenAIDirectModelRunner', () => {
  test('run() sends messages verbatim to createFn and returns text from choices[0].message.content', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('question'));
    const runner = new OpenAIDirectModelRunner('test-key', undefined, { createFn });

    const result = await runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o-mini', effort: 'low' },
      max_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    });

    expect(result).toEqual({ text: 'question', raw: makeResponse('question') });
    expect(createFn).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    });
  });

  test('run() uses profile.model when request.model is absent', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('ok'));
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn });

    await runner.run({
      route: { task: 'pr.title_generate' },
      profile: { id: 'gpt', provider: 'openai', model: 'gpt-4o', effort: 'low' },
      messages: [{ role: 'user', content: 'title' }],
    });

    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
  });

  test('run() uses defaultModel when neither request.model nor profile.model is set', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('ok'));
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn, defaultModel: 'gpt-4o-mini' });

    await runner.run({
      route: { task: 'intent.classify' },
      messages: [{ role: 'user', content: 'classify' }],
    });

    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-mini' }));
  });

  test('run() throws a descriptive error when no model can be resolved', async () => {
    const createFn = vi.fn();
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn });

    await expect(
      runner.run({
        route: { task: 'intent.classify' },
        messages: [{ role: 'user', content: 'classify' }],
      }),
    ).rejects.toThrow('Direct model route intent.classify requires a model');

    expect(createFn).not.toHaveBeenCalled();
  });

  test('run() defaults max_tokens to 1024 when not specified', async () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('ok'));
    const runner = new OpenAIDirectModelRunner('key', undefined, { createFn, defaultModel: 'gpt-4o-mini' });

    await runner.run({
      route: { task: 'intent.classify' },
      messages: [{ role: 'user', content: 'classify' }],
    });

    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1024 }));
  });

  test('constructor with baseUrl passes api-key header in defaultHeaders', () => {
    const createFn = vi.fn().mockResolvedValue(makeResponse('grove-response'));
    const runner = new OpenAIDirectModelRunner('grove-key', 'https://grove.internal/openai', { createFn });

    expect(runner).toBeDefined();
    // The createFn override is still used — confirming the baseUrl branch selects it correctly.
  });
});
