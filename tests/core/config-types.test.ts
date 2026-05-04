/**
 * Type-level tests for LlmSettings and SsoProvider.
 * Verified at compile time via `tsc --noEmit` — no runtime assertions needed.
 * Import the test to ensure it participates in type-checking.
 */
import { describe, it } from 'vitest';
import type { WorkflowConfig, SsoProvider, LlmSettings } from '../../src/types/config.js';

// T1: WorkflowConfig with anthropic SSO satisfies the type
const _t1: WorkflowConfig = {
  llm_settings: { provider: 'anthropic', auth: 'sso' },
} satisfies WorkflowConfig;
void _t1;

// T2: WorkflowConfig with bedrock and aws_profile satisfies the type
const _t2: WorkflowConfig = {
  llm_settings: { provider: 'bedrock', aws_profile: 'my-profile' },
} satisfies WorkflowConfig;
void _t2;

// T3: 'anthropic' satisfies SsoProvider
const _t3: SsoProvider = 'anthropic';
void _t3;

// T4: WorkflowConfig without llm_settings does NOT satisfy the type
// @ts-expect-error — llm_settings is required
const _t4: WorkflowConfig = {} satisfies WorkflowConfig;
void _t4;

describe('LlmSettings and SsoProvider compile-time types', () => {
  it('type assertions are verified at compile time via tsc --noEmit', () => {
    // All assertions are compile-time only (see module-level constants above).
  });
});
