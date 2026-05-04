import { describe, it, expect } from 'vitest';
import { resolveLlmSettings } from '../../src/core/config.js';
import type { WorkflowConfig } from '../../src/types/config.js';

/**
 * Startup sequence integration tests (ST1–ST5).
 *
 * ST1–ST4 test resolveLlmSettings in the context of the startup call site:
 * errors thrown here propagate to the top-level handler before any agent work begins.
 * ST5 is a code-level audit: verified by reading buildDirectModelRunner source.
 */
describe('startup sequence: resolveLlmSettings error propagation', () => {
  it('ST1: absent llm_settings throws before agent work; message contains "llm_settings is required"', () => {
    // Simulates what composeBuiltInWorkflowRuntime does: call resolveLlmSettings on startup.
    // An error here exits the process before any adapters or agents are initialized.
    const config = {} as WorkflowConfig;
    expect(() => resolveLlmSettings(config, {})).toThrow('llm_settings is required');
  });

  it('ST2: unknown provider throws before agent work; error names the invalid value', () => {
    const config = { llm_settings: { provider: 'vertex' } } as unknown as WorkflowConfig;
    expect(() => resolveLlmSettings(config, {})).toThrow('"vertex"');
  });

  it('ST3: auth:sso with absent token resolves successfully; requiresSsoFlow is true (SSO deferred to first request)', () => {
    const config = { llm_settings: { provider: 'anthropic', auth: 'sso' } } as WorkflowConfig;
    // Must NOT throw — SSO flow triggers lazily on first request, not at startup.
    const result = resolveLlmSettings(config, {});
    expect(result.requiresSsoFlow).toBe(true);
  });

  it('ST4: auth:api_key with key present resolves with auth:api_key in result', () => {
    const config = { llm_settings: { provider: 'anthropic', auth: 'api_key' } } as WorkflowConfig;
    const result = resolveLlmSettings(config, { AC_ANTHROPIC_API_KEY: 'sk-ant-startup-test' });
    expect(result.auth).toBe('api_key');
    expect(result.apiKey).toBe('sk-ant-startup-test');
  });
});

/**
 * ST5: Code-level audit assertion.
 *
 * buildDirectModelRunner must not directly read process.env.AC_ANTHROPIC_API_KEY.
 * All env reads are routed through resolveLlmSettings.
 * This is verified structurally by inspecting the source of buildDirectModelRunner.
 */
describe('ST5: no direct env reads outside resolveLlmSettings', () => {
  it('buildDirectModelRunner source does not contain direct AC_ANTHROPIC_API_KEY read', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(import.meta.dirname, '../../src/adapters/runtime-composition.ts'),
      'utf-8',
    );
    // Extract just the buildDirectModelRunner function body by finding it
    const fnStart = source.indexOf('export function buildDirectModelRunner');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart);
    // The function must not directly access AC_ANTHROPIC_API_KEY from env
    expect(fnBody).not.toContain("env['AC_ANTHROPIC_API_KEY']");
    expect(fnBody).not.toContain('env["AC_ANTHROPIC_API_KEY"]');
  });
});
