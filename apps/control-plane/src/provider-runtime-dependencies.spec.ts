import { describe, expect, it } from 'vitest';

describe('provider runtime dependencies', () => {
  it('control-plane runtime can import agent adapters and their SDK dependencies', async () => {
    const [openaiAdapter, openaiAgents, openaiClient, claudeAdapter, claudeSdk] = await Promise.all([
      import('@autocatalyst/openai-agent-adapter'),
      import('@openai/agents'),
      import('openai'),
      import('@autocatalyst/claude-agent-adapter'),
      import('@anthropic-ai/claude-agent-sdk')
    ]);

    expect(openaiAdapter.createOpenAIAgentAdapter).toBeTypeOf('function');
    expect(openaiAgents.Runner).toBeTypeOf('function');
    expect(openaiClient.default).toBeTypeOf('function');
    expect(claudeAdapter.createClaudeAgentAdapter).toBeTypeOf('function');
    expect(claudeSdk).toBeDefined();
  });
});
