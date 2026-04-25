import type { ClassificationContext, Intent, IntentDefinition } from '../types/intent.js';

export interface IntentRegistry {
  register(definition: IntentDefinition): void;
  get(name: Intent): IntentDefinition | undefined;
  list(): IntentDefinition[];
  validIntentsForContext(context: ClassificationContext): Intent[];
  fallbackForContext(context: ClassificationContext): Intent | undefined;
}

export class IntentRegistryImpl implements IntentRegistry {
  private readonly definitions = new Map<Intent, IntentDefinition>();

  register(definition: IntentDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Intent already registered: ${definition.name}`);
    }
    this.definitions.set(definition.name, {
      ...definition,
      valid_contexts: [...definition.valid_contexts],
      fallback_contexts: definition.fallback_contexts ? [...definition.fallback_contexts] : undefined,
    });
  }

  get(name: Intent): IntentDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): IntentDefinition[] {
    return [...this.definitions.values()];
  }

  validIntentsForContext(context: ClassificationContext): Intent[] {
    return this.list()
      .filter(definition => definition.valid_contexts.includes(context))
      .map(definition => definition.name);
  }

  fallbackForContext(context: ClassificationContext): Intent | undefined {
    return this.list().find(definition => definition.fallback_contexts?.includes(context))?.name;
  }
}
