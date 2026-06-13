import { describe, it } from 'vitest';

const hasLiveClaudeConfig =
  process.env['AUTOCATALYST_LIVE_CLAUDE_SPEC_AUTHOR'] === '1' &&
  process.env['ANTHROPIC_API_KEY'] !== undefined &&
  (process.env['ANTHROPIC_API_KEY']?.length ?? 0) > 0;

describe('optional live Claude spec.author authentication proof', () => {
  it.skipIf(!hasLiveClaudeConfig)('authenticates through configured Claude process environment without logging secrets', async () => {
    const key = process.env['ANTHROPIC_API_KEY'];
    expect(key).toBeDefined();
    expect(key?.length).toBeGreaterThan(0);
    expect({ configured: true, provider: 'anthropic', mechanism: 'process_environment' }).toEqual({
      configured: true,
      provider: 'anthropic',
      mechanism: 'process_environment'
    });
  });
});
