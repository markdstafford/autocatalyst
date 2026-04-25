import { describe, expect, it } from 'vitest';
import { IntentRegistryImpl } from '../../src/core/intent-registry.js';

describe('IntentRegistryImpl', () => {
  it('registers intent definitions and returns valid intents for a context', () => {
    const registry = new IntentRegistryImpl();
    registry.register({
      name: 'idea',
      description: 'build a feature',
      valid_contexts: ['new_thread', 'intake'],
      fallback_contexts: ['new_thread'],
    });
    registry.register({
      name: 'feedback',
      description: 'revise current work',
      valid_contexts: ['reviewing_spec'],
    });

    expect(registry.validIntentsForContext('new_thread')).toEqual(['idea']);
    expect(registry.validIntentsForContext('reviewing_spec')).toEqual(['feedback']);
  });

  it('throws on duplicate intent registration', () => {
    const registry = new IntentRegistryImpl();
    registry.register({ name: 'idea', description: 'one', valid_contexts: ['new_thread'] });

    expect(() =>
      registry.register({ name: 'idea', description: 'two', valid_contexts: ['intake'] }),
    ).toThrow(/already registered/i);
  });

  it('returns fallback intent for registered fallback contexts', () => {
    const registry = new IntentRegistryImpl();
    registry.register({
      name: 'idea',
      description: 'build a feature',
      valid_contexts: ['new_thread'],
      fallback_contexts: ['new_thread'],
    });

    expect(registry.fallbackForContext('new_thread')).toBe('idea');
    expect(registry.fallbackForContext('reviewing_spec')).toBeUndefined();
  });
});
