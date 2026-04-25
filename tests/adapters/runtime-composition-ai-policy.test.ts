import { describe, expect, test } from 'vitest';
import { buildAgentRoutingPolicy } from '../../src/adapters/runtime-composition.js';
import type { AgentPluginConfig } from '../../src/types/ai.js';

const pluginPaths: Record<string, AgentPluginConfig> = {
  mm: { type: 'local', path: '/plugins/mm' },
  superpowers: { type: 'local', path: '/plugins/superpowers' },
};

function buildTestPolicy() {
  return buildAgentRoutingPolicy({ resolvePlugins: ids => ids.map(id => pluginPaths[id]) });
}

describe('runtime AI routing policy', () => {
  test('question answering disables settings sources to avoid inherited Claude thinking config', () => {
    const policy = buildTestPolicy();

    expect(policy.resolve({ task: 'question.answer' })).toMatchObject({
      id: 'repo-question',
      provider: 'claude_agent_sdk',
      effort: 'low',
      thinking: 'adaptive',
      setting_sources: [],
    });
  });

  test('artifact creation loads mm explicitly without user settings', () => {
    const policy = buildTestPolicy();

    expect(policy.resolve({ task: 'artifact.create' })).toMatchObject({
      id: 'artifact-authoring',
      provider: 'claude_agent_sdk',
      setting_sources: ['project'],
      load_user_settings: false,
      plugins: [pluginPaths.mm],
    });
  });

  test('implementation loads superpowers explicitly without user settings', () => {
    const policy = buildTestPolicy();

    expect(policy.resolve({ task: 'implementation.run' })).toMatchObject({
      id: 'implementation',
      provider: 'claude_agent_sdk',
      setting_sources: ['project'],
      load_user_settings: false,
      plugins: [pluginPaths.superpowers],
    });
  });

  test('issue triage loads mm explicitly without user settings', () => {
    const policy = buildTestPolicy();

    expect(policy.resolve({ task: 'issue.triage' })).toMatchObject({
      id: 'issue-triage',
      provider: 'claude_agent_sdk',
      setting_sources: ['project'],
      load_user_settings: false,
      plugins: [pluginPaths.mm],
    });
  });
});
