import { describe, expect, test } from 'vitest';
import { DefaultAgentRoutingPolicy } from '../../../src/core/ai/routing-policy.js';
import type { AgentProfile } from '../../../src/types/ai.js';

describe('DefaultAgentRoutingPolicy', () => {
  const defaults: Record<string, AgentProfile> = {
    direct: { id: 'direct', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
    agent: { id: 'agent', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'medium' },
  };

  test('resolves exact task routes before provider defaults', () => {
    const policy = new DefaultAgentRoutingPolicy({
      defaults,
      routes: [
        {
          match: { task: 'implementation.run' },
          profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-opus-4-1', effort: 'high' },
        },
      ],
    });

    expect(policy.resolve({ task: 'implementation.run' })).toMatchObject({
      id: 'impl',
      provider: 'claude_agent_sdk',
      effort: 'high',
    });
    expect(policy.resolve({ task: 'artifact.create' })).toMatchObject({
      id: 'agent',
      provider: 'claude_agent_sdk',
      effort: 'medium',
    });
  });

  test('accepts stage intent and artifact kind metadata when matching routes', () => {
    const policy = new DefaultAgentRoutingPolicy({
      defaults,
      routes: [
        {
          match: {
            task: 'artifact.create',
            stage: 'new_thread',
            intent: 'bug',
            artifact_kind: 'bug_triage',
          },
          profile: { id: 'triage', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'high' },
        },
      ],
    });

    expect(policy.resolve({
      task: 'artifact.create',
      stage: 'new_thread',
      intent: 'bug',
      artifact_kind: 'bug_triage',
    })).toMatchObject({ id: 'triage', effort: 'high' });
    expect(policy.resolve({
      task: 'artifact.create',
      stage: 'new_thread',
      intent: 'idea',
      artifact_kind: 'feature_spec',
    })).toMatchObject({ id: 'agent', effort: 'medium' });
  });

  test('falls back predictably by task class', () => {
    const policy = new DefaultAgentRoutingPolicy({ defaults });

    expect(policy.resolve({ task: 'intent.classify' })).toMatchObject({ id: 'direct', provider: 'anthropic' });
    expect(policy.resolve({ task: 'question.answer' })).toMatchObject({ id: 'agent', provider: 'claude_agent_sdk' });
  });

  test('routes pr.title_generate to the direct defaults', () => {
    const policy = new DefaultAgentRoutingPolicy({ defaults });
    expect(policy.resolve({ task: 'pr.title_generate' })).toMatchObject({
      id: 'direct',
      provider: 'anthropic',
    });
  });
});
