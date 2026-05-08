import { describe, it, expect } from 'vitest';
import { resolveAiConfig } from '../../src/core/config.js';
import type { WorkflowConfig, AiConfig } from '../../src/types/config.js';

function makeWorkflowConfig(ai: Partial<AiConfig>): WorkflowConfig {
  return { ai } as unknown as WorkflowConfig;
}

function validAi(): AiConfig {
  return {
    credentials: [{ name: 'my-key', type: 'api_key', value: '${MY_KEY}' }],
    endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'my-key' }],
    profiles: [{ name: 'p', endpoint: 'ep', model: 'haiku', runner: 'anthropic_direct' }],
    routing: { 'intent.classify': 'p' },
  };
}

/**
 * Startup sequence integration tests (ST1–ST5).
 *
 * Tests verify that resolveAiConfig errors propagate before any agent work begins.
 */
describe('startup sequence: resolveAiConfig error propagation', () => {
  it('ST1: absent ai: section throws before agent work; message contains "ai: section is required"', () => {
    expect(() => resolveAiConfig({} as WorkflowConfig, {})).toThrow('ai: section is required');
  });

  it('ST2: unknown endpoint credential throws before agent work with the invalid name', () => {
    const ai = validAi();
    ai.endpoints[0].credential = 'missing';
    expect(() => resolveAiConfig(makeWorkflowConfig(ai), { MY_KEY: 'sk' })).toThrow("unknown credential 'missing'");
  });

  it('ST3: valid config with api_key and env var set resolves successfully', () => {
    const result = resolveAiConfig(makeWorkflowConfig(validAi()), { MY_KEY: 'sk-test' });
    expect(result.credentials[0].resolvedValue).toBe('sk-test');
  });

  it('ST4: valid config resolves routing map in result', () => {
    const result = resolveAiConfig(makeWorkflowConfig(validAi()), { MY_KEY: 'sk-test' });
    expect(result.routing['intent.classify']).toBe('p');
  });
});

/**
 * ST5: Code-level audit — no direct AC_ANTHROPIC_API_KEY read in buildDirectModelRunner or startup path.
 */
describe('ST5: no direct env reads outside resolveAiConfig', () => {
  it('buildDirectModelRunner source does not contain direct AC_ANTHROPIC_API_KEY read', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(
      join(import.meta.dirname, '../../src/adapters/runtime-composition.ts'),
      'utf-8',
    );
    const fnStart = source.indexOf('export function buildDirectModelRunner');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart);
    expect(fnBody).not.toContain("env['AC_ANTHROPIC_API_KEY']");
    expect(fnBody).not.toContain('env["AC_ANTHROPIC_API_KEY"]');
  });
});
