import { BuiltInExtensionRegistry } from '../core/extensions/built-ins.js';

export function createBuiltInExtensionRegistry(): BuiltInExtensionRegistry {
  const registry = new BuiltInExtensionRegistry();
  registry.register({ kind: 'channel', provider: 'slack', capabilities: ['messages', 'threads', 'reacji'] });
  registry.register({ kind: 'publisher', provider: 'notion', capabilities: ['artifact', 'implementation_feedback', 'feedback'] });
  registry.register({ kind: 'publisher', provider: 'slack_canvas', capabilities: ['artifact'] });
  registry.register({ kind: 'issue_tracker', provider: 'github', capabilities: ['issues', 'pull_requests'] });
  registry.register({ kind: 'agent_runtime', provider: 'claude_agent_sdk', capabilities: ['artifact_authoring', 'implementation', 'question_answering', 'issue_triage'] });
  registry.register({ kind: 'intent_classifier', provider: 'anthropic', capabilities: ['intent_classification'] });
  registry.register({ kind: 'intent_set', provider: 'default', capabilities: ['autocatalyst_intents'] });
  registry.register({ kind: 'command_set', provider: 'default', capabilities: ['runtime_commands'] });
  return registry;
}
