import type { ClassificationContext } from '../../types/intent.js';
import { IntentRegistryImpl, type IntentRegistry } from '../intent-registry.js';

export type BuiltInExtensionKind =
  | 'channel'
  | 'publisher'
  | 'issue_tracker'
  | 'agent_runtime'
  | 'intent_classifier'
  | 'intent_set'
  | 'command_set';

export interface BuiltInExtension {
  kind: BuiltInExtensionKind;
  provider: string;
  capabilities: string[];
}

export class BuiltInExtensionRegistry {
  private readonly extensions = new Map<string, BuiltInExtension>();

  register(extension: BuiltInExtension): void {
    const key = extensionKey(extension.kind, extension.provider);
    if (this.extensions.has(key)) {
      throw new Error(`Built-in extension already registered: ${key}`);
    }
    this.extensions.set(key, { ...extension, capabilities: [...extension.capabilities] });
  }

  has(kind: BuiltInExtensionKind, provider: string): boolean {
    return this.extensions.has(extensionKey(kind, provider));
  }

  get(kind: BuiltInExtensionKind, provider: string): BuiltInExtension | undefined {
    const extension = this.extensions.get(extensionKey(kind, provider));
    return extension ? { ...extension, capabilities: [...extension.capabilities] } : undefined;
  }

  providersFor(kind: BuiltInExtensionKind): string[] {
    return [...this.extensions.values()]
      .filter(extension => extension.kind === kind)
      .map(extension => extension.provider);
  }

  entries(): BuiltInExtension[] {
    return [...this.extensions.values()].map(extension => ({
      ...extension,
      capabilities: [...extension.capabilities],
    }));
  }
}

function extensionKey(kind: BuiltInExtensionKind, provider: string): string {
  return `${kind}:${provider}`;
}

export const BUILT_IN_CLASSIFICATION_CONTEXTS: ClassificationContext[] = [
  'new_thread',
  'intake',
  'reviewing_spec',
  'reviewing_implementation',
  'awaiting_impl_input',
  'speccing',
  'implementing',
  'pr_open',
  'done',
  'failed',
];

export function createBuiltInIntentRegistry(): IntentRegistry {
  const registry = new IntentRegistryImpl();
  registerBuiltInIntents(registry);
  return registry;
}

export function registerBuiltInIntents(registry: IntentRegistry): void {
  registry.register({
    name: 'idea',
    description: 'the human wants to build a new feature or improvement',
    valid_contexts: ['new_thread', 'intake'],
    fallback_contexts: ['new_thread', 'intake'],
  });
  registry.register({
    name: 'bug',
    description: 'the human is reporting a bug or something broken',
    valid_contexts: ['new_thread', 'intake'],
  });
  registry.register({
    name: 'chore',
    description: 'the human is requesting maintenance work',
    valid_contexts: ['new_thread', 'intake'],
  });
  registry.register({
    name: 'file_issues',
    description: 'the human is explicitly requesting issue filing',
    valid_contexts: ['new_thread', 'intake'],
  });
  registry.register({
    name: 'feedback',
    description: 'the human is providing feedback or revision requests',
    valid_contexts: ['reviewing_spec', 'reviewing_implementation', 'awaiting_impl_input', 'speccing', 'implementing'],
    fallback_contexts: ['reviewing_spec', 'reviewing_implementation', 'awaiting_impl_input', 'speccing', 'implementing'],
  });
  registry.register({
    name: 'approval',
    description: 'the human is approving the current work',
    valid_contexts: ['reviewing_spec', 'reviewing_implementation', 'pr_open'],
  });
  registry.register({
    name: 'question',
    description: 'the human is asking a question',
    valid_contexts: ['new_thread', 'intake', 'reviewing_spec', 'reviewing_implementation', 'awaiting_impl_input', 'pr_open'],
  });
  registry.register({
    name: 'ignore',
    description: 'the message is not actionable',
    valid_contexts: ['new_thread', 'intake', 'reviewing_spec', 'reviewing_implementation', 'awaiting_impl_input', 'speccing', 'implementing', 'pr_open', 'done', 'failed'],
    fallback_contexts: ['pr_open', 'done', 'failed'],
  });
}
