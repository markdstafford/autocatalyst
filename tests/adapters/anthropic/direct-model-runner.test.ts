import { describe, expect, test, vi } from 'vitest';
import { AnthropicDirectModelRunner } from '../../../src/adapters/anthropic/direct-model-runner.js';

describe('AnthropicDirectModelRunner', () => {
  test('sends direct model requests without any filesystem settings dependency', async () => {
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'question' }],
    });
    const runner = new AnthropicDirectModelRunner('test-key', { createFn });

    await expect(runner.run({
      route: { task: 'intent.classify', stage: 'new_thread' },
      profile: { id: 'intent', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      max_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    })).resolves.toEqual({ text: 'question', raw: { content: [{ type: 'text', text: 'question' }] } });

    expect(createFn).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'classify this' }],
    });
  });
});
