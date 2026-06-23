import { describe, expect, it } from 'vitest';
import { createOpenAIAgentAdapter } from '@autocatalyst/openai-agent-adapter';
import { createClaudeAgentAdapter } from '@autocatalyst/claude-agent-adapter';

// Proves that @openai/agents, openai, and @anthropic-ai/claude-agent-sdk are
// resolvable from the control-plane runtime: the adapter modules import these
// SDKs statically at load time. If this spec loads, those SDK deps resolved.
describe('provider runtime dependencies', () => {
  it('control-plane runtime can load agent adapters and their SDK dependencies', () => {
    expect(createOpenAIAgentAdapter).toBeTypeOf('function');
    expect(createClaudeAgentAdapter).toBeTypeOf('function');
  });
});
