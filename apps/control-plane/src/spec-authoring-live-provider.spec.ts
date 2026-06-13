import { describe, expect, it } from 'vitest';

// Gate: requires AUTOCATALYST_LIVE_CLAUDE_SPEC_AUTHOR=1 and a real ANTHROPIC_API_KEY.
// When the gate is not met, all tests in this suite are skipped — CI always skips them.
//
// NOTE: This suite is a configuration-presence check only. It verifies that the expected
// environment variables are set and non-empty, which is a prerequisite for a live SDK call.
// It does NOT make a real authenticated SDK call. The actual first-run authentication proof
// is the human CP-1 run with real Grove credentials. If you need an automated authenticated
// call, wire a real ClaudeAgentAdapter session here and assert sanitized response metadata.
const hasLiveClaudeConfig =
  process.env['AUTOCATALYST_LIVE_CLAUDE_SPEC_AUTHOR'] === '1' &&
  process.env['ANTHROPIC_API_KEY'] !== undefined &&
  (process.env['ANTHROPIC_API_KEY']?.length ?? 0) > 0;

describe('optional live Claude spec.author credential configuration check (not an authentication proof)', () => {
  it.skipIf(!hasLiveClaudeConfig)('confirms ANTHROPIC_API_KEY is present in the process environment (prerequisite for live SDK call)', () => {
    const key = process.env['ANTHROPIC_API_KEY'];
    expect(key, 'ANTHROPIC_API_KEY must be set and non-empty').toBeDefined();
    expect(key?.length, 'ANTHROPIC_API_KEY must be non-empty').toBeGreaterThan(0);
    // This test proves the credential is configured in the process environment.
    // It does not make an authenticated SDK call. Authentication is proven by the
    // human CP-1 run with real Grove credentials.
  });
});
