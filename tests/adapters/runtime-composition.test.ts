import { describe, it, expect } from 'vitest';
import { resolveAiConfig } from '../../src/core/config.js';
import type { WorkflowConfig, AiConfig } from '../../src/types/config.js';
import { buildDirectModelRunner } from '../../src/adapters/runtime-composition.js';
import { OpenAIDirectModelRunner } from '../../src/adapters/openai/direct-model-runner.js';
import { AnthropicDirectModelRunner } from '../../src/adapters/anthropic/direct-model-runner.js';
import type { ResolvedAiConfig } from '../../src/core/config.js';
import type { RuntimeLogger } from '../../src/adapters/runtime-composition.js';

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

const noopLogger: RuntimeLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

function makeResolvedAi(overrides: {
  runner: 'openai_direct' | 'anthropic_direct';
  credentialType?: 'api_key' | 'bearer_token' | 'iam' | 'workload_identity';
  baseUrl?: string;
}): ResolvedAiConfig {
  const { runner, credentialType = 'api_key', baseUrl } = overrides;
  return {
    credentials: [{ name: 'cred', type: credentialType, resolvedValue: 'sk-test' }],
    endpoints: [{ name: 'ep', protocol: 'openai', credential: 'cred', ...(baseUrl ? { base_url: baseUrl } : {}) }],
    profiles: [{ name: 'p', endpoint: 'ep', runner, model: 'gpt-4o-mini' }],
    routing: { 'intent.classify': 'p' },
  } as unknown as ResolvedAiConfig;
}

describe('buildDirectModelRunner dispatch', () => {
  it('returns OpenAIDirectModelRunner when profile runner is openai_direct', () => {
    const runner = buildDirectModelRunner(makeResolvedAi({ runner: 'openai_direct' }), noopLogger);
    expect(runner).toBeInstanceOf(OpenAIDirectModelRunner);
  });

  it('returns AnthropicDirectModelRunner when profile runner is anthropic_direct (no regression)', () => {
    const resolvedAi: ResolvedAiConfig = {
      credentials: [{ name: 'cred', type: 'api_key', resolvedValue: 'sk-anthropic' }],
      endpoints: [{ name: 'ep', protocol: 'anthropic', credential: 'cred' }],
      profiles: [{ name: 'p', endpoint: 'ep', runner: 'anthropic_direct', model: 'claude-haiku-4-5' }],
      routing: { 'intent.classify': 'p' },
    } as unknown as ResolvedAiConfig;
    const runner = buildDirectModelRunner(resolvedAi, noopLogger);
    expect(runner).toBeInstanceOf(AnthropicDirectModelRunner);
  });

  it('throws when openai_direct profile uses a non-api_key credential', () => {
    expect(() =>
      buildDirectModelRunner(makeResolvedAi({ runner: 'openai_direct', credentialType: 'bearer_token' }), noopLogger),
    ).toThrow("Credential type 'bearer_token' is not supported for openai_direct runner");
  });

  it('throws when no openai_direct or anthropic_direct profile exists', () => {
    const resolvedAi: ResolvedAiConfig = {
      credentials: [],
      endpoints: [],
      profiles: [],
      routing: {},
    } as unknown as ResolvedAiConfig;
    expect(() => buildDirectModelRunner(resolvedAi, noopLogger)).toThrow(
      'No profile with runner "openai_direct" or "anthropic_direct" found',
    );
  });
});
