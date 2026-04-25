import { describe, expect, it } from 'vitest';
import { IntentRegistryImpl } from '../../../src/core/intent-registry.js';
import { createBuiltInExtensionRegistry } from '../../../src/adapters/built-in-extensions.js';
import { registerBuiltInIntents } from '../../../src/core/extensions/built-ins.js';

describe('registerBuiltInIntents', () => {
  it('registers current production intents with their valid contexts', () => {
    const registry = new IntentRegistryImpl();

    registerBuiltInIntents(registry);

    expect(registry.validIntentsForContext('new_thread')).toEqual([
      'idea',
      'bug',
      'chore',
      'file_issues',
      'question',
      'ignore',
    ]);
    expect(registry.validIntentsForContext('reviewing_spec')).toEqual([
      'feedback',
      'approval',
      'question',
      'ignore',
    ]);
  });
});

describe('createBuiltInExtensionRegistry', () => {
  it('declares the static built-in extension providers used by runtime composition', () => {
    const registry = createBuiltInExtensionRegistry();

    expect(registry.providersFor('channel')).toEqual(['slack']);
    expect(registry.providersFor('publisher')).toEqual(['notion', 'slack_canvas']);
    expect(registry.has('issue_tracker', 'github')).toBe(true);
    expect(registry.has('agent_runtime', 'claude_agent_sdk')).toBe(true);
    expect(registry.has('intent_classifier', 'anthropic')).toBe(true);
    expect(registry.has('intent_set', 'default')).toBe(true);
    expect(registry.has('command_set', 'default')).toBe(true);
  });
});
