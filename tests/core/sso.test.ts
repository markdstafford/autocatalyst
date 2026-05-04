import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedLlmSettings } from '../../src/core/config.js';
import type { RuntimeLogger } from '../../src/adapters/runtime-composition.js';

// Hoist mock variables so they're accessible inside vi.mock factories
const { mockCreate, MockAuthError } = vi.hoisted(() => {
  class MockAuthError extends Error {
    status = 401;
    constructor() {
      super('Authentication error');
      this.name = 'AuthenticationError';
    }
  }
  return { mockCreate: vi.fn(), MockAuthError };
});

vi.mock('../../src/core/sso.js', () => ({
  triggerSsoFlow: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const AnthropicMock = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  // Attach MockAuthError as a static property on the mock constructor.
  // isAnthropicAuthError in runtime-composition.ts checks:
  //   err instanceof Anthropic.AuthenticationError
  // After mocking, `Anthropic` in that file resolves to AnthropicMock (this mock's default export).
  // So `Anthropic.AuthenticationError` is this MockAuthError class, making `instanceof` work correctly.
  (AnthropicMock as Record<string, unknown>)['AuthenticationError'] = MockAuthError;
  return { default: AnthropicMock };
});

import { triggerSsoFlow } from '../../src/core/sso.js';
import { buildDirectModelRunner } from '../../src/adapters/runtime-composition.js';

const mockTriggerSsoFlow = vi.mocked(triggerSsoFlow);

function makeMockLogger() {
  type LogEntry = { level: string; obj: Record<string, unknown>; msg: string };
  const calls: LogEntry[] = [];
  const logger: RuntimeLogger = {
    info: (obj, msg) => calls.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => calls.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => calls.push({ level: 'error', obj, msg }),
    debug: (obj, msg) => calls.push({ level: 'debug', obj, msg }),
  };
  return { logger, calls };
}

const successResponse = { content: [{ type: 'text', text: 'ok' }] };
const dummyRequest = {
  route: { task: 'intent.classify' as const, stage: 'new_thread' as const },
  profile: { id: 'test', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: 'low' as const },
  messages: [{ role: 'user' as const, content: 'hello' }],
  max_tokens: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(successResponse);
  mockTriggerSsoFlow.mockResolvedValue('fresh-token');
});

// --- SSO flow initiation ---

describe('SSO flow initiation', () => {
  it('S1: calls triggerSsoFlow exactly once before first request when requiresSsoFlow:true', async () => {
    const { logger } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', requiresSsoFlow: true };
    const runner = buildDirectModelRunner(resolved, logger);

    await runner.run(dummyRequest);

    expect(mockTriggerSsoFlow).toHaveBeenCalledTimes(1);
    expect(mockTriggerSsoFlow).toHaveBeenCalledWith('anthropic', logger);
  });

  it('S2: uses token returned by triggerSsoFlow for subsequent Anthropic SDK calls', async () => {
    const { logger } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', requiresSsoFlow: true };
    mockTriggerSsoFlow.mockResolvedValue('fresh-token-xyz');
    const runner = buildDirectModelRunner(resolved, logger);

    await runner.run(dummyRequest);

    // S2 verifies the Anthropic constructor is called with the fresh token.
    // This is coupled to the per-request client construction in buildDirectModelRunner's SSO branch.
    // If that branch is refactored to cache the client, update this assertion to verify
    // the correct token is used via a different observable (e.g., mock call args or response routing).
    const AnthropicMock = (await import('@anthropic-ai/sdk')).default;
    expect(AnthropicMock).toHaveBeenCalledWith({ authToken: 'fresh-token-xyz' });
  });

  it('S3: does NOT call triggerSsoFlow before first request when ssoToken is pre-loaded', async () => {
    const { logger } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', ssoToken: 'pre-loaded-token' };
    const runner = buildDirectModelRunner(resolved, logger);

    await runner.run(dummyRequest);

    expect(mockTriggerSsoFlow).not.toHaveBeenCalled();
  });

  it('S4: emits service.config log at construction with provider:anthropic and auth:sso', () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', requiresSsoFlow: true };

    buildDirectModelRunner(resolved, logger);

    expect(calls.some(c => c.obj['event'] === 'service.config' && c.obj['provider'] === 'anthropic' && c.obj['auth'] === 'sso')).toBe(true);
  });
});

// --- 401 retry behavior ---

describe('401 retry behavior', () => {
  it('R1: on 401, logs sso.token.expired, calls triggerSsoFlow once, retries with new token', async () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', ssoToken: 'old-token' };
    mockCreate
      .mockRejectedValueOnce(new MockAuthError())
      .mockResolvedValueOnce(successResponse);
    mockTriggerSsoFlow.mockResolvedValue('new-token');

    const runner = buildDirectModelRunner(resolved, logger);
    await runner.run(dummyRequest);

    expect(calls.some(c => c.level === 'warn' && c.obj['event'] === 'sso.token.expired' && c.obj['provider'] === 'anthropic')).toBe(true);
    expect(mockTriggerSsoFlow).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('R2: two consecutive 401s — triggerSsoFlow called once; error propagates; no third createFn call', async () => {
    const { logger } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', ssoToken: 'old-token' };
    mockCreate.mockRejectedValue(new MockAuthError());

    const runner = buildDirectModelRunner(resolved, logger);
    await expect(runner.run(dummyRequest)).rejects.toThrow('Authentication error');

    expect(mockTriggerSsoFlow).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('R3: non-401 error propagates immediately without calling triggerSsoFlow', async () => {
    const { logger } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', ssoToken: 'token' };
    mockCreate.mockRejectedValueOnce(new Error('network error'));

    const runner = buildDirectModelRunner(resolved, logger);
    await expect(runner.run(dummyRequest)).rejects.toThrow('network error');

    expect(mockTriggerSsoFlow).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('R4: requiresSsoFlow:true + 401 after initial SSO — triggerSsoFlow called twice, createFn called twice', async () => {
    const { logger } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', requiresSsoFlow: true };
    mockCreate
      .mockRejectedValueOnce(new MockAuthError())
      .mockResolvedValueOnce(successResponse);
    mockTriggerSsoFlow
      .mockResolvedValueOnce('first-token')
      .mockResolvedValueOnce('second-token');

    const runner = buildDirectModelRunner(resolved, logger);
    await runner.run(dummyRequest);

    expect(mockTriggerSsoFlow).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// --- Log event assertions ---

describe('log event assertions', () => {
  it('L1: Anthropic SSO path emits service.config with provider:anthropic and auth:sso', () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', ssoToken: 'tok' };
    buildDirectModelRunner(resolved, logger);
    expect(calls.some(c => c.obj['event'] === 'service.config' && c.obj['provider'] === 'anthropic' && c.obj['auth'] === 'sso')).toBe(true);
  });

  it('L2: Anthropic API key path emits service.config with provider:anthropic and auth:api_key', () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'api_key', apiKey: 'sk-test' };
    buildDirectModelRunner(resolved, logger);
    expect(calls.some(c => c.obj['event'] === 'service.config' && c.obj['provider'] === 'anthropic' && c.obj['auth'] === 'api_key')).toBe(true);
  });

  it('L3: Bedrock IAM with no profile emits service.config with provider:bedrock and auth:iam', () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'bedrock', auth: 'iam' };
    buildDirectModelRunner(resolved, logger);
    expect(calls.some(c => c.obj['event'] === 'service.config' && c.obj['provider'] === 'bedrock' && c.obj['auth'] === 'iam')).toBe(true);
  });

  it('L4: Bedrock with named profile includes aws_profile in service.config log', () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'bedrock', auth: 'iam', awsProfile: 'my-profile' };
    buildDirectModelRunner(resolved, logger);
    expect(calls.some(c => c.obj['aws_profile'] === 'my-profile')).toBe(true);
  });

  it('L5: 401 mid-run emits sso.token.expired warn with provider:anthropic', async () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', ssoToken: 'token' };
    mockCreate
      .mockRejectedValueOnce(new MockAuthError())
      .mockResolvedValueOnce(successResponse);
    const runner = buildDirectModelRunner(resolved, logger);
    await runner.run(dummyRequest);
    expect(calls.some(c => c.level === 'warn' && c.obj['event'] === 'sso.token.expired' && c.obj['provider'] === 'anthropic')).toBe(true);
  });
});

// --- Security/redaction ---

describe('security: tokens must not appear in logs', () => {
  it('SEC1: SSO token obtained via triggerSsoFlow never appears in any log entry', async () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'sso', requiresSsoFlow: true };
    mockTriggerSsoFlow.mockResolvedValue('super-secret-sso-token');
    const runner = buildDirectModelRunner(resolved, logger);
    await runner.run(dummyRequest);

    const allLogText = JSON.stringify(calls);
    expect(allLogText).not.toContain('super-secret-sso-token');
  });

  it('SEC2: API key never appears in any log entry', () => {
    const { logger, calls } = makeMockLogger();
    const resolved: ResolvedLlmSettings = { provider: 'anthropic', auth: 'api_key', apiKey: 'sk-ant-super-secret' };
    buildDirectModelRunner(resolved, logger);

    const allLogText = JSON.stringify(calls);
    expect(allLogText).not.toContain('sk-ant-super-secret');
  });
});
