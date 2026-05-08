import { describe, expect, test } from 'vitest';
import { DefaultAgentRoutingPolicy } from '../../../src/core/ai/routing-policy.js';
import type { AiConfig } from '../../../src/types/config.js';

function makeAiConfig(overrides?: Partial<AiConfig>): AiConfig {
  return {
    credentials: [{ name: 'my-key', type: 'api_key', value: 'sk-test' }],
    endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key' }],
    profiles: [
      {
        name: 'direct-default',
        endpoint: 'ep',
        model: 'claude-haiku-4-5',
        runner: 'anthropic_direct',
        anthropic: { effort: 'low' },
      },
      {
        name: 'agent-default',
        endpoint: 'ep',
        model: 'claude-sonnet-4-5',
        runner: 'claude_agent_sdk',
        anthropic: { effort: 'medium', thinking: 'adaptive' },
      },
    ],
    routing: {
      'intent.classify': 'direct-default',
      'pr.title_generate': 'direct-default',
      'artifact.create': 'agent-default',
      'artifact.revise': 'agent-default',
      'implementation.run': 'agent-default',
      'question.answer': 'agent-default',
      'issue.triage': 'agent-default',
    },
    ...overrides,
  };
}

describe('DefaultAgentRoutingPolicy', () => {
  test('resolves intent.classify to the direct profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'intent.classify' })).toMatchObject({
      id: 'direct-default',
      provider: 'anthropic',
      effort: 'low',
    });
  });

  test('resolves pr.title_generate to the direct profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'pr.title_generate' })).toMatchObject({
      id: 'direct-default',
      provider: 'anthropic',
    });
  });

  test('resolves implementation.run to the agent profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'implementation.run' })).toMatchObject({
      id: 'agent-default',
      provider: 'claude_agent_sdk',
      effort: 'medium',
      thinking: 'adaptive',
    });
  });

  test('resolves artifact.create to the agent profile', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    expect(policy.resolve({ task: 'artifact.create' })).toMatchObject({
      id: 'agent-default',
      provider: 'claude_agent_sdk',
    });
  });

  test('throws for a task not in routing', () => {
    const config = makeAiConfig();
    // Remove one routing entry to simulate missing task
    delete config.routing['question.answer'];
    const policy = new DefaultAgentRoutingPolicy(config);
    expect(() => policy.resolve({ task: 'question.answer' })).toThrow("No routing entry for task 'question.answer'");
  });

  test('returned AgentProfile has correct model from ProfileConfig', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());
    const profile = policy.resolve({ task: 'intent.classify' });
    expect(profile.model).toBe('claude-haiku-4-5');
  });

  test('returned AgentProfile includes plugins when ProfileConfig has plugins', () => {
    const pluginPath = { type: 'local' as const, path: '/plugins/mm' };
    const config = makeAiConfig();
    config.profiles[1].plugins = [pluginPath];
    const policy = new DefaultAgentRoutingPolicy(config);
    expect(policy.resolve({ task: 'artifact.create' })).toMatchObject({
      plugins: [pluginPath],
    });
  });

  test('returned AgentProfile includes route-derived required skills', () => {
    const policy = new DefaultAgentRoutingPolicy(makeAiConfig());

    expect(policy.resolve({ task: 'artifact.create', intent: 'idea' })).toMatchObject({
      required_skills: ['mm:planning'],
    });
    expect(policy.resolve({ task: 'artifact.create', intent: 'bug' })).toMatchObject({
      required_skills: ['mm:issue-triage'],
    });
    expect(policy.resolve({ task: 'implementation.run' })).toMatchObject({
      required_skills: ['superpowers:writing-plans', 'superpowers:subagent-driven-development'],
    });
    expect(policy.resolve({ task: 'question.answer' })).toMatchObject({
      required_skills: [],
    });
  });
});
