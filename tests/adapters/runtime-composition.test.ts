import { describe, it, expect, vi } from 'vitest';
import { resolveAiConfig } from '../../src/core/config.js';
import type { WorkflowConfig, AiConfig } from '../../src/types/config.js';
import { buildDirectModelRunner, RoutingAwareDirectModelRunner } from '../../src/adapters/runtime-composition.js';
import { OpenAIDirectModelRunner } from '../../src/adapters/openai/direct-model-runner.js';
import { AnthropicDirectModelRunner } from '../../src/adapters/anthropic/direct-model-runner.js';
import type { ResolvedAiConfig } from '../../src/core/config.js';
import type { RuntimeLogger } from '../../src/adapters/runtime-composition.js';
import type { DirectModelRunner, DirectModelRunRequest } from '../../src/types/ai.js';

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

  it('returns RoutingAwareDirectModelRunner when both openai_direct and anthropic_direct profiles exist', () => {
    const resolvedAi: ResolvedAiConfig = {
      credentials: [{ name: 'cred', type: 'api_key', resolvedValue: 'sk-test' }],
      endpoints: [{ name: 'ep', protocol: 'openai', credential: 'cred' }],
      profiles: [
        { name: 'oai', endpoint: 'ep', runner: 'openai_direct', model: 'gpt-4o-mini' },
        { name: 'ant', endpoint: 'ep', runner: 'anthropic_direct', model: 'claude-haiku-4-5' },
      ],
      routing: { 'intent.classify': 'oai', 'pr.title_generate': 'ant' },
    } as unknown as ResolvedAiConfig;
    const runner = buildDirectModelRunner(resolvedAi, noopLogger);
    expect(runner).toBeInstanceOf(RoutingAwareDirectModelRunner);
  });
});

describe('RoutingAwareDirectModelRunner dispatch', () => {
  function makeRunner(result: string): DirectModelRunner {
    return { run: vi.fn().mockResolvedValue({ text: result, raw: {} }) };
  }

  it('dispatches to the runner registered for request.profile.id', async () => {
    const openaiRunner = makeRunner('openai-result');
    const anthropicRunner = makeRunner('anthropic-result');
    const runners = new Map<string, DirectModelRunner>([
      ['oai-profile', openaiRunner],
      ['ant-profile', anthropicRunner],
    ]);
    const wrapper = new RoutingAwareDirectModelRunner(runners, openaiRunner);

    const req: DirectModelRunRequest = {
      route: { task: 'pr.title_generate' },
      profile: { id: 'ant-profile', provider: 'anthropic', model: 'claude-haiku-4-5' },
      messages: [{ role: 'user', content: 'title' }],
    };
    const result = await wrapper.run(req);
    expect(result.text).toBe('anthropic-result');
    expect(anthropicRunner.run).toHaveBeenCalledWith(req);
    expect(openaiRunner.run).not.toHaveBeenCalled();
  });

  it('falls back to the default runner when profile.id is not in the map', async () => {
    const defaultRunner = makeRunner('default-result');
    const runners = new Map<string, DirectModelRunner>([['some-profile', makeRunner('other')]]);
    const wrapper = new RoutingAwareDirectModelRunner(runners, defaultRunner);

    const req: DirectModelRunRequest = {
      route: { task: 'intent.classify' },
      profile: { id: 'unknown-profile', provider: 'openai', model: 'gpt-4o' },
      messages: [{ role: 'user', content: 'classify' }],
    };
    const result = await wrapper.run(req);
    expect(result.text).toBe('default-result');
  });

  it('falls back to the default runner when no profile is present in the request', async () => {
    const defaultRunner = makeRunner('fallback');
    const wrapper = new RoutingAwareDirectModelRunner(new Map(), defaultRunner);

    const req: DirectModelRunRequest = {
      route: { task: 'intent.classify' },
      messages: [{ role: 'user', content: 'classify' }],
    };
    const result = await wrapper.run(req);
    expect(result.text).toBe('fallback');
  });
});
