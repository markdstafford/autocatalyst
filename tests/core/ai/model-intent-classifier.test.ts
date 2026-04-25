import { describe, expect, test } from 'vitest';
import { IntentRegistryImpl } from '../../../src/core/intent-registry.js';
import { IntentClassificationUnavailableError, ModelIntentClassifier } from '../../../src/core/ai/model-intent-classifier.js';
import type { DirectModelRunner, DirectModelRunRequest } from '../../../src/types/ai.js';

describe('ModelIntentClassifier', () => {
  test('classifies through a DirectModelRunner and uses registered intent context', async () => {
    const requests: DirectModelRunRequest[] = [];
    const runner: DirectModelRunner = {
      async run(request) {
        requests.push(request);
        return { text: 'question' };
      },
    };
    const registry = new IntentRegistryImpl();
    registry.register({
      name: 'question',
      description: 'A question about the repository or workflow',
      valid_contexts: ['new_thread'],
    });
    registry.register({
      name: 'idea',
      description: 'A request for new product work',
      valid_contexts: ['new_thread'],
      fallback_contexts: ['new_thread'],
    });

    const classifier = new ModelIntentClassifier(runner, { intentRegistry: registry });

    await expect(classifier.classify('How many open issues are there?', 'new_thread')).resolves.toBe('question');
    expect(requests).toHaveLength(1);
    expect(requests[0].route).toEqual({
      task: 'intent.classify',
      stage: 'new_thread',
    });
    expect(requests[0].messages[0].content).toContain('channel message');
    expect(requests[0].messages[0].content).not.toContain('Slack message');
  });

  test('throws a classification unavailable error when direct model calls fail', async () => {
    const runner: DirectModelRunner = {
      async run() {
        throw new Error('credentials expired');
      },
    };
    const registry = new IntentRegistryImpl();
    registry.register({
      name: 'idea',
      description: 'A request for new product work',
      valid_contexts: ['new_thread'],
      fallback_contexts: ['new_thread'],
    });

    const classifier = new ModelIntentClassifier(runner, { intentRegistry: registry });

    await expect(classifier.classify('How many open issues are there?', 'new_thread'))
      .rejects.toBeInstanceOf(IntentClassificationUnavailableError);
  });
});
