import { describe, it, expect, vi } from 'vitest';
import type { ResolvedAgentRunnerProfile, ResolvedAgentCredentialReference, AgentConnectionTelemetryContext } from './agent-provider-adapter.js';
import { ProviderConfigurationError, ProviderConnectionError } from './agent-provider-adapter.js';
import type { AgentConnectionFactoryOptions, ProviderCredentialResolver, ProcessLaunchConfigInput } from './connection.js';
import { createAgentConnection } from './connection.js';
import { ClassifiedProviderFailureError } from './errors.js';

// ---------------------------------------------------------------------------
// Sentinel no-leak helper
// ---------------------------------------------------------------------------

function expectNoSentinels(serialized: string): void {
  expect(serialized).not.toContain('sk-test-secret');
  expect(serialized).not.toContain('authorization: Bearer');
  expect(serialized).not.toContain('/Users/mark/private');
  expect(serialized).not.toContain('sec_secret_handle_value');
  expect(serialized).not.toContain('raw SDK diagnostic');
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function captureLogger() {
  const entries: unknown[] = [];
  return {
    entries,
    logger: {
      info: (event: string, fields: unknown) => entries.push({ level: 'info', event, fields }),
      warn: (event: string, fields: unknown) => entries.push({ level: 'warn', event, fields }),
      error: (event: string, fields: unknown) => entries.push({ level: 'error', event, fields })
    }
  };
}

function makeFetchProfile(): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: 'anthropic',
    adapterId: 'claude-adapter',
    profileName: 'test-fetch',
    model: { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku' },
    inferenceSettings: {},
    endpoint: {
      baseUrl: 'https://api.anthropic.com',
      authHeaderName: 'x-api-key'
    },
    connectionMechanism: 'fetch_transport'
  };
}

function makeProcessProfile(): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: 'anthropic',
    adapterId: 'claude-adapter',
    profileName: 'test-process',
    model: { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku' },
    inferenceSettings: {},
    endpoint: {
      baseUrl: 'https://api.anthropic.com',
      authEnvironmentVariable: 'ANTHROPIC_API_KEY'
    },
    connectionMechanism: 'process_environment'
  };
}

function makeCredentialRef(overrides: Partial<ResolvedAgentCredentialReference> = {}): ResolvedAgentCredentialReference {
  return {
    required: true,
    secretHandle: 'my-secret-handle',
    authTarget: 'header',
    ...overrides
  };
}

function makeTelemetry(): AgentConnectionTelemetryContext {
  return {
    runId: 'run-123',
    phase: 'execute',
    step: 'step-1'
  };
}

function makeOptions(
  overrides: Partial<AgentConnectionFactoryOptions> = {}
): AgentConnectionFactoryOptions {
  return {
    profile: makeFetchProfile(),
    credentialReference: makeCredentialRef(),
    credentialResolver: {
      resolveCredential: async () => 'test-secret-value'
    },
    telemetryContext: makeTelemetry(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Test: Credential resolution
// ---------------------------------------------------------------------------

describe('createAgentConnection — credential resolution', () => {
  it('resolves credential through credentialResolver.resolveCredential(secretHandle)', async () => {
    const resolveCredential = vi.fn().mockResolvedValue('resolved-secret');
    const credentialResolver: ProviderCredentialResolver = { resolveCredential };

    await createAgentConnection(makeOptions({ credentialResolver }));

    expect(resolveCredential).toHaveBeenCalledWith('my-secret-handle');
    expect(resolveCredential).not.toHaveBeenCalledWith(expect.objectContaining({ env: expect.anything() }));
  });

  it('does NOT read from process.env', async () => {
    const originalEnv = process.env['MY_SECRET'];
    process.env['MY_SECRET'] = 'env-secret-value';

    const resolveCredential = vi.fn().mockResolvedValue('resolver-value');
    const credentialResolver: ProviderCredentialResolver = { resolveCredential };

    const connection = await createAgentConnection(makeOptions({ credentialResolver }));

    // credentialResolved should be true (resolver returned a value)
    expect(connection.credentialResolved).toBe(true);
    // The resolver was used, not process.env
    expect(resolveCredential).toHaveBeenCalledTimes(1);

    // Restore
    if (originalEnv === undefined) {
      delete process.env['MY_SECRET'];
    } else {
      process.env['MY_SECRET'] = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Missing credential
// ---------------------------------------------------------------------------

describe('createAgentConnection — missing credential', () => {
  it('throws ClassifiedProviderFailureError(provider_auth_failed) when required=true and resolver returns undefined', async () => {
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => undefined
    };

    await expect(
      createAgentConnection(makeOptions({ credentialResolver }))
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ClassifiedProviderFailureError &&
        err.failureReason === 'provider_auth_failed'
      );
    });
  });

  it('throws ClassifiedProviderFailureError(provider_auth_failed) when required=true and no secretHandle', async () => {
    const credentialRef = makeCredentialRef({ required: true, secretHandle: undefined });
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => undefined
    };

    await expect(
      createAgentConnection(makeOptions({ credentialReference: credentialRef, credentialResolver }))
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ClassifiedProviderFailureError &&
        err.failureReason === 'provider_auth_failed'
      );
    });
  });

  it('does NOT throw when required=false and resolver returns undefined', async () => {
    const credentialRef = makeCredentialRef({ required: false, secretHandle: 'optional-handle' });
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => undefined
    };

    const connection = await createAgentConnection(makeOptions({ credentialReference: credentialRef, credentialResolver }));
    expect(connection.credentialResolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: Locked secret store
// ---------------------------------------------------------------------------

describe('createAgentConnection — locked secret store', () => {
  it('wraps resolver throws into ProviderConfigurationError(secret_store_locked)', async () => {
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => { throw new Error('Vault is sealed'); }
    };

    await expect(
      createAgentConnection(makeOptions({ credentialResolver }))
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProviderConfigurationError &&
        err.code === 'secret_store_locked'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test: Fetch transport availability
// ---------------------------------------------------------------------------

describe('createAgentConnection — fetch transport availability', () => {
  it('createFetchTransport() succeeds for fetch_transport profile', async () => {
    const connection = await createAgentConnection(makeOptions({ profile: makeFetchProfile() }));
    expect(() => connection.createFetchTransport()).not.toThrow();
  });

  it('createFetchTransport() throws ProviderConnectionError(unsupported_connection_mechanism) for process_environment profile', async () => {
    const connection = await createAgentConnection(makeOptions({ profile: makeProcessProfile() }));
    expect(() => connection.createFetchTransport()).toSatisfy((_err: unknown) => {
      // It should throw
      return true; // verified below
    });

    expect(() => connection.createFetchTransport()).toThrowError();

    let thrown: unknown;
    try {
      connection.createFetchTransport();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderConnectionError);
    expect((thrown as ProviderConnectionError).code).toBe('unsupported_connection_mechanism');
  });
});

// ---------------------------------------------------------------------------
// Test: Process launch config availability
// ---------------------------------------------------------------------------

describe('createAgentConnection — process launch config availability', () => {
  const sampleInput: ProcessLaunchConfigInput = {
    materializedEnvironment: {
      variables: { PATH: '/usr/bin', SOME_VAR: 'some-value' },
      secretVariableNames: []
    }
  };

  it('createProcessLaunchConfig() succeeds for process_environment profile', async () => {
    const connection = await createAgentConnection(makeOptions({ profile: makeProcessProfile() }));
    await expect(connection.createProcessLaunchConfig(sampleInput)).resolves.toBeDefined();
  });

  it('createProcessLaunchConfig() throws ProviderConnectionError(unsupported_connection_mechanism) for fetch_transport profile', async () => {
    const connection = await createAgentConnection(makeOptions({ profile: makeFetchProfile() }));

    let thrown: unknown;
    try {
      await connection.createProcessLaunchConfig(sampleInput);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderConnectionError);
    expect((thrown as ProviderConnectionError).code).toBe('unsupported_connection_mechanism');
  });
});

// ---------------------------------------------------------------------------
// Test: Fetch transport applies alteration
// ---------------------------------------------------------------------------

describe('createAgentConnection — fetch transport applies alteration', () => {
  it('uses applyRequestAlteration to modify headers/auth/baseUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const profile: ResolvedAgentRunnerProfile = {
      ...makeFetchProfile(),
      endpoint: {
        baseUrl: 'https://custom.api.example.com',
        authHeaderName: 'x-api-key'
      }
    };

    const connection = await createAgentConnection(
      makeOptions({ profile, fetch: mockFetch })
    );
    const transport = connection.createFetchTransport();

    await transport.fetch({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'claude-3-5-haiku-20241022' }
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Base URL should be rewritten
    expect(calledUrl).toContain('custom.api.example.com');
    // Auth header should be injected
    const headers = calledInit?.headers as Record<string, string> | undefined;
    if (headers) {
      const headerEntries = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]);
      const apiKeyEntry = headerEntries.find(([k]) => k === 'x-api-key');
      expect(apiKeyEntry).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Fetch retry — stops at max and throws retry_exhausted
// ---------------------------------------------------------------------------

describe('createAgentConnection — fetch retry', () => {
  it('stops at max retries and throws ProviderConnectionError(transient_provider_failure)', async () => {
    // 429 is transient — should retry and eventually exhaust
    const mockFetch = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));

    const profile: ResolvedAgentRunnerProfile = {
      ...makeFetchProfile(),
      endpoint: {
        baseUrl: 'https://api.anthropic.com',
        authHeaderName: 'x-api-key',
        maxRetries: 2
      }
    };

    const connection = await createAgentConnection(makeOptions({ profile, fetch: mockFetch }));
    const transport = connection.createFetchTransport();

    let thrown: unknown;
    try {
      await transport.fetch({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST'
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ProviderConnectionError);
    expect((thrown as ProviderConnectionError).code).toBe('transient_provider_failure');

    // The known secret must NOT appear in the error message or safeDetails
    const errorStr = JSON.stringify(thrown);
    expect(errorStr).not.toContain('test-secret-value');
  });

  it('does not include known secret in retry_exhausted error', async () => {
    const secretValue = 'super-secret-key-abc123';
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => secretValue
    };

    const mockFetch = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    const profile: ResolvedAgentRunnerProfile = {
      ...makeFetchProfile(),
      endpoint: { baseUrl: 'https://api.anthropic.com', authHeaderName: 'x-api-key', maxRetries: 1 }
    };

    const connection = await createAgentConnection(makeOptions({ profile, credentialResolver, fetch: mockFetch }));
    const transport = connection.createFetchTransport();

    let thrown: unknown;
    try {
      await transport.fetch({ url: 'https://api.anthropic.com/v1/messages', method: 'POST' });
    } catch (e) {
      thrown = e;
    }

    const errorStr = JSON.stringify({ message: (thrown as Error).message, details: (thrown as ProviderConnectionError).safeDetails });
    expect(errorStr).not.toContain(secretValue);
  });
});

// ---------------------------------------------------------------------------
// Test: Credential secret absent from fetch-attempt log entries
// ---------------------------------------------------------------------------

describe('createAgentConnection — credential secret absent from log entries', () => {
  it('does not include credential secret in any fetch-attempt log entry', async () => {
    const knownSecret = 'known-secret-value-for-log-test';
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => knownSecret
    };

    const { entries, logger } = captureLogger();

    // First response is a transient 429, second is a 200 — both paths emit log entries
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const profile: ResolvedAgentRunnerProfile = {
      ...makeFetchProfile(),
      endpoint: {
        baseUrl: 'https://api.anthropic.com',
        authHeaderName: 'x-api-key',
        maxRetries: 1
      }
    };

    const connection = await createAgentConnection(
      makeOptions({ profile, credentialResolver, logger, fetch: mockFetch })
    );
    const transport = connection.createFetchTransport();

    await transport.fetch({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'claude-3-5-haiku-20241022' }
    });

    // At least one log entry should have been emitted
    expect(entries.length).toBeGreaterThan(0);

    // The raw credential value must not appear in any log entry
    const logStr = JSON.stringify(entries);
    expect(logStr.includes(knownSecret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: Non-transient response
// ---------------------------------------------------------------------------

describe('createAgentConnection — non-transient response', () => {
  const genericNonTransientStatuses = [400, 403, 404];

  for (const status of genericNonTransientStatuses) {
    it(`throws ProviderConnectionError(non_transient_provider_failure) for status ${status} without leaking body`, async () => {
      const sensitiveBody = `{"error":"secret-value-in-body","key":"leak-me-${status}"}`;
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(sensitiveBody, { status, headers: { 'content-type': 'application/json' } })
      );

      const connection = await createAgentConnection(makeOptions({ fetch: mockFetch }));
      const transport = connection.createFetchTransport();

      let thrown: unknown;
      try {
        await transport.fetch({ url: 'https://api.anthropic.com/v1/messages', method: 'POST' });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(ProviderConnectionError);
      expect((thrown as ProviderConnectionError).code).toBe('non_transient_provider_failure');

      // Must not leak response body
      const errorStr = JSON.stringify(thrown);
      expect(errorStr).not.toContain('leak-me');
      expect(errorStr).not.toContain(sensitiveBody);
    });
  }
});

// ---------------------------------------------------------------------------
// Test: Claude process launch config — secure logging
// ---------------------------------------------------------------------------

describe('createAgentConnection — process launch config', () => {
  const sampleInput: ProcessLaunchConfigInput = {
    materializedEnvironment: {
      variables: { PATH: '/usr/bin:/bin', HOME: '/home/user', MY_APP_VAR: 'app-value' },
      secretVariableNames: []
    }
  };

  it('returns ProcessLaunchConfig with full environment for adapter use', async () => {
    const connection = await createAgentConnection(makeOptions({ profile: makeProcessProfile() }));
    const config = await connection.createProcessLaunchConfig(sampleInput);

    // Should have environment with ANTHROPIC_API_KEY set
    expect(config.environment['ANTHROPIC_API_KEY']).toBeDefined();
    // secretVariableNames should include the credential var
    expect(config.secretVariableNames).toContain('ANTHROPIC_API_KEY');
    // redacted is a JSON-safe projection
    expect(config.redacted).toBeDefined();
  });

  it('does NOT include raw credential in logs', async () => {
    const secretValue = 'my-very-secret-api-key-xyz';
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => secretValue
    };

    const { entries, logger } = captureLogger();

    const connection = await createAgentConnection(
      makeOptions({ profile: makeProcessProfile(), credentialResolver, logger })
    );
    await connection.createProcessLaunchConfig(sampleInput);

    // Check logs do not contain the raw secret
    const logStr = JSON.stringify(entries);
    expect(logStr).not.toContain(secretValue);
  });

  it('strips provider-owned env vars and overlays endpoint vars', async () => {
    const envWithProviderVars: ProcessLaunchConfigInput = {
      materializedEnvironment: {
        variables: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'old-key-should-be-stripped',
          ANTHROPIC_BASE_URL: 'old-url-should-be-stripped',
          MY_VAR: 'keep-me'
        },
        secretVariableNames: ['ANTHROPIC_API_KEY']
      }
    };

    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => 'new-resolved-key'
    };

    const connection = await createAgentConnection(
      makeOptions({ profile: makeProcessProfile(), credentialResolver })
    );
    const config = await connection.createProcessLaunchConfig(envWithProviderVars);

    // Provider-owned key should be replaced by the resolved credential
    expect(config.environment['ANTHROPIC_API_KEY']).toBe('new-resolved-key');
    // Base URL from endpoint should be set
    expect(config.environment['ANTHROPIC_BASE_URL']).toBe('https://api.anthropic.com');
    // MY_VAR should be preserved
    expect(config.environment['MY_VAR']).toBe('keep-me');
  });

  it('records degradation metadata for unsupported header strip', async () => {
    const profileWithHeaderStrip: ResolvedAgentRunnerProfile = {
      ...makeProcessProfile(),
      endpoint: {
        ...makeProcessProfile().endpoint,
        headersToStrip: ['x-custom-header']
      }
    };

    const connection = await createAgentConnection(makeOptions({ profile: profileWithHeaderStrip }));
    const config = await connection.createProcessLaunchConfig(sampleInput);

    expect(config.degradedCapabilities).toHaveLength(1);
    expect(config.degradedCapabilities[0]?.capability).toBe('header_strip');
  });
});

// ---------------------------------------------------------------------------
// Test: HTTP 401 classified as provider_auth_failed
// ---------------------------------------------------------------------------

describe('createAgentConnection — HTTP 401 classified as provider_auth_failed', () => {
  it('classifies HTTP 401 as provider_auth_failed without leaking response body or credential', async () => {
    const { entries, logger } = captureLogger();

    const rawBody = 'raw body sk-test-secret /Users/mark/private authorization: Bearer sec_secret_handle_value raw SDK diagnostic';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(rawBody, { status: 401 })
    );

    const connection = await createAgentConnection(makeOptions({ fetch: mockFetch, logger }));
    const transport = connection.createFetchTransport();

    let thrown: unknown;
    try {
      await transport.fetch({ url: 'https://api.anthropic.com/v1/messages', method: 'POST' });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ClassifiedProviderFailureError);
    expect((thrown as ClassifiedProviderFailureError).failureReason).toBe('provider_auth_failed');

    // Logs must not contain the raw response body or sensitive tokens
    const logStr = JSON.stringify(entries);
    expect(logStr).not.toContain('raw body');
    expectNoSentinels(logStr);
    expectNoSentinels(JSON.stringify(thrown));

    // Logs must record the classified reason
    expect(logStr).toContain('provider_auth_failed');
  });
});

// ---------------------------------------------------------------------------
// Test: Missing required credentials classified as provider_auth_failed
// ---------------------------------------------------------------------------

describe('createAgentConnection — missing required credentials classified', () => {
  it('classifies missing required credentials as provider_auth_failed', async () => {
    const credentialResolver: ProviderCredentialResolver = {
      resolveCredential: async () => undefined
    };

    await expect(
      createAgentConnection(makeOptions({ credentialResolver }))
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ClassifiedProviderFailureError &&
        err.failureReason === 'provider_auth_failed'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers for proxy tests
// ---------------------------------------------------------------------------

function makeProcessProfileWith(endpointOverrides: Partial<import('@autocatalyst/api-contract').RunnerEndpointSettings>): ResolvedAgentRunnerProfile {
  const base = makeProcessProfile();
  return {
    ...base,
    endpoint: { ...base.endpoint, ...endpointOverrides }
  };
}

// ---------------------------------------------------------------------------
// Test: Proxy selection — process launch config uses loopback URL
// ---------------------------------------------------------------------------

describe('createAgentConnection — proxy selection', () => {
  it('uses loopback base URL in Claude process launch config when proxyMode is required', async () => {
    const connection = await createAgentConnection({
      profile: makeProcessProfileWith({
        baseUrl: 'https://gateway.example.test/anthropic',
        authHeaderName: 'api-key',
        proxyMode: 'required',
        headersToStrip: ['x-api-key']
      }),
      credentialReference: { required: true, secretHandle: 'sec_123' },
      credentialResolver: { resolveCredential: async () => 'secret-grove-key' },
      telemetryContext: makeTelemetry(),
      proxyFactory: async () => ({
        baseUrl: 'http://127.0.0.1:45678',
        startedAt: '2026-06-13T00:00:00.000Z',
        requestCount: () => 0,
        close: async () => undefined
      })
    });

    const launch = await connection.createProcessLaunchConfig({
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    });

    expect(launch.environment['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:45678');
    expect(launch.secretVariableNames).toContain('ANTHROPIC_CUSTOM_HEADERS');
  });

  it('starts proxy lazily once for parallel process launch config calls', async () => {
    let starts = 0;
    const connection = await createAgentConnection({
      profile: makeProcessProfileWith({
        baseUrl: 'https://gateway.example.test',
        proxyMode: 'required'
      }),
      credentialReference: { required: false },
      credentialResolver: { resolveCredential: async () => undefined },
      telemetryContext: makeTelemetry(),
      proxyFactory: async () => {
        starts += 1;
        return { baseUrl: 'http://127.0.0.1:45678', startedAt: new Date().toISOString(), requestCount: () => 0, close: async () => undefined };
      }
    });

    await Promise.all([
      connection.createProcessLaunchConfig({ materializedEnvironment: { variables: {}, secretVariableNames: [] } }),
      connection.createProcessLaunchConfig({ materializedEnvironment: { variables: {}, secretVariableNames: [] } })
    ]);

    expect(starts).toBe(1);
  });

  it('fails required proxy mode when no upstream baseUrl is configured', async () => {
    const connection = await createAgentConnection({
      profile: makeProcessProfileWith({ baseUrl: undefined, proxyMode: 'required' }),
      credentialReference: { required: false },
      credentialResolver: { resolveCredential: async () => undefined },
      telemetryContext: makeTelemetry()
    });

    await expect(connection.createProcessLaunchConfig({
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    })).rejects.toMatchObject({ code: 'unsupported_required_capability' });
  });

  it('auto-selects proxy for process_environment profile with authHeaderName only', async () => {
    // Grove auth-only subprocess: only authHeaderName is set, proxyMode defaults to auto.
    // Without this fix the stopgap path was used, which still injects ANTHROPIC_API_KEY
    // alongside the auth header and can produce a grove 401.
    let proxyStarted = false;
    const connection = await createAgentConnection({
      profile: makeProcessProfileWith({
        baseUrl: 'https://gateway.example.test/anthropic',
        authHeaderName: 'api-key'
        // proxyMode intentionally absent — defaults to 'auto'
      }),
      credentialReference: { required: true, secretHandle: 'sec_grove' },
      credentialResolver: { resolveCredential: async () => 'grove-key' },
      telemetryContext: makeTelemetry(),
      proxyFactory: async () => {
        proxyStarted = true;
        return { baseUrl: 'http://127.0.0.1:45679', startedAt: new Date().toISOString(), requestCount: () => 0, close: async () => undefined };
      }
    });

    await connection.createProcessLaunchConfig({
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    });

    expect(proxyStarted).toBe(true);
  });

  it('passes bounded timeout and retry policy into the loopback proxy', async () => {
    const proxyOptions: import('./loopback-proxy.js').LoopbackProxyOptions[] = [];

    const connection = await createAgentConnection({
      profile: makeProcessProfileWith({
        baseUrl: 'https://gateway.example.test/anthropic',
        proxyMode: 'required',
        requestTimeoutMs: 999999,
        maxRetries: 99
      }),
      credentialReference: { required: true, secretHandle: 'sec_123' },
      credentialResolver: { resolveCredential: async () => 'secret-grove-key' },
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      proxyFactory: async (options) => {
        proxyOptions.push(options);
        return { baseUrl: 'http://127.0.0.1:45678', startedAt: '2025-01-01T00:00:00.000Z', requestCount: () => 0, close: async () => undefined };
      }
    });

    await connection.createProcessLaunchConfig({ materializedEnvironment: { variables: {}, secretVariableNames: [] } });

    expect(proxyOptions[0]?.requestTimeoutMs).toBe(600000);
    expect(proxyOptions[0]?.retryPolicy?.maxRetries).toBe(5);
    expect(proxyOptions[0]?.retryPolicy?.transientHttpStatuses).toEqual([408, 429, 500, 502, 503, 504]);
  });

  it('does not auto-select proxy for process_environment profile with no proxy-requiring capabilities', async () => {
    let proxyStarted = false;
    const connection = await createAgentConnection({
      profile: {
        mode: 'agent',
        providerKind: 'anthropic',
        adapterId: 'claude-adapter',
        profileName: 'test-no-proxy',
        model: { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku' },
        inferenceSettings: {},
        endpoint: {
          baseUrl: 'https://api.anthropic.com',
          authEnvironmentVariable: 'ANTHROPIC_API_KEY'
          // no authHeaderName, headersToStrip, logging, filters, or proxyMode
        },
        connectionMechanism: 'process_environment'
      },
      credentialReference: { required: false },
      credentialResolver: { resolveCredential: async () => undefined },
      telemetryContext: makeTelemetry(),
      proxyFactory: async () => {
        proxyStarted = true;
        return { baseUrl: 'http://127.0.0.1:45680', startedAt: new Date().toISOString(), requestCount: () => 0, close: async () => undefined };
      }
    });

    await connection.createProcessLaunchConfig({
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    });

    expect(proxyStarted).toBe(false);
  });

  it('routes fetch transport through the proxy loopback URL when proxyMode is required', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const connection = await createAgentConnection({
      profile: {
        mode: 'agent',
        providerKind: 'anthropic',
        adapterId: 'claude-adapter',
        profileName: 'test-fetch-proxy',
        model: { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku' },
        inferenceSettings: {},
        endpoint: { baseUrl: 'https://gateway.example.test/anthropic', proxyMode: 'required' },
        connectionMechanism: 'fetch_transport'
      },
      credentialReference: { required: false },
      credentialResolver: { resolveCredential: async () => undefined },
      telemetryContext: makeTelemetry(),
      proxyFactory: async () => ({
        baseUrl: 'http://127.0.0.1:45678',
        startedAt: new Date().toISOString(),
        requestCount: () => 0,
        close: async () => undefined
      }),
      fetch: async (url, init) => {
        seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response('{}', { status: 200 });
      }
    });

    await connection.createFetchTransport().fetch({
      url: 'https://gateway.example.test/anthropic/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });

    // The base path /anthropic is stripped before rebasing so the loopback proxy
    // can re-add it without doubling (https://gateway.example.test/anthropic/anthropic/...)
    expect(seen[0]?.url).toBe('http://127.0.0.1:45678/v1/messages');
  });
});

// ---------------------------------------------------------------------------
// Test: Fetch transport log shape alignment
// ---------------------------------------------------------------------------

describe('createAgentConnection — fetch transport log shape', () => {
  it('logs fetch transport attempts with proxy-compatible request and response fields', async () => {
    const logs: Array<{ event: string; fields: unknown }> = [];
    const profile: ResolvedAgentRunnerProfile = {
      ...makeFetchProfile(),
      endpoint: {
        baseUrl: 'https://api.anthropic.com',
        authHeaderName: 'api-key',
        headersToStrip: ['x-api-key']
      }
    };
    const connection = await createAgentConnection({
      profile,
      credentialReference: { required: true, secretHandle: 'sec_123' },
      credentialResolver: { resolveCredential: async () => 'secret-grove-key' },
      telemetryContext: makeTelemetry(),
      logger: {
        info: (event, fields) => logs.push({ event, fields }),
        warn: (event, fields) => logs.push({ event, fields }),
        error: (event, fields) => logs.push({ event, fields })
      },
      fetch: async () =>
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer secret-grove-key'
          }
        })
    });

    await connection.createFetchTransport().fetch({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'x-api-key': 'sdk-default', 'content-type': 'application/json' },
      body: { prompt: 'secret-grove-key' }
    });

    const serialized = JSON.stringify(logs);
    expect(serialized).toContain('method');
    expect(serialized).toContain('"url"');
    expect(serialized).toContain('headers');
    expect(serialized).toContain('status');
    expect(serialized).not.toContain('secret-grove-key');
  });
});
