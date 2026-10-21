import { describe, expect, it } from 'vitest';
import { createOpenAIAgentAdapter } from '@autocatalyst/openai-agent-adapter';
import { createClaudeAgentAdapter } from '@autocatalyst/claude-agent-adapter';

// Proves that adapter modules and their owned SDK dependencies are resolvable
// from the control-plane runtime. Adapter-package tests separately import
// the real SDKs to verify dependency ownership through pnpm package boundaries.
describe('provider runtime dependencies', () => {
  it('control-plane runtime can load agent adapters and their SDK dependencies', () => {
    expect(createOpenAIAgentAdapter).toBeTypeOf('function');
    expect(createClaudeAgentAdapter).toBeTypeOf('function');
  });
});
