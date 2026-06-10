import { describe, expect, it } from 'vitest';

import type { RunnerEndpointSettings } from '@autocatalyst/api-contract';

import {
  applyRequestAlteration,
  buildClaudeProcessLaunchEnvironment,
  claudeProviderOwnedEnvironmentVariables,
  defaultMaxRetries,
  defaultRequestTimeoutMs,
  isTransientProviderFailure,
  maximumMaxRetries,
  maximumRequestTimeoutMs,
  ProviderAlterationError,
  redactProcessLaunchConfigForLog,
  redactProviderRequestForLog,
  redactProviderResponseForLog,
  validateHttpHeaderName,
  type ClaudeProcessLaunchInput,
  type ClaudeProcessLaunchResult,
  type ProviderCapabilityDegradation,
  type ProviderRequest
} from './request-alteration.js';

// ---------------------------------------------------------------------------
// 1. Fetch alteration order: strip → rewrite → auth injection
// ---------------------------------------------------------------------------
describe('applyRequestAlteration — alteration order', () => {
  it('strips before rewrite so a stripped header is never rewritten', () => {
    const endpoint: RunnerEndpointSettings = {
      headersToStrip: ['x-strip-me'],
      headersToRewrite: { 'x-strip-me': 'should-never-appear' },
      authHeaderName: 'x-auth'
    };
    const result = applyRequestAlteration({
      request: {
        url: 'https://api.example.com/v1/messages',
        method: 'POST',
        headers: { 'x-strip-me': 'original-value', 'x-keep': 'kept' }
      },
      endpoint,
      credential: 'test-credential'
    });
    expect(result.request.headers['x-strip-me']).toBeUndefined();
    expect(result.request.headers['x-keep']).toBe('kept');
    expect(result.request.headers['x-auth']).toBe('Bearer test-credential');
  });

  it('applies rewrite before auth injection so auth is injected after rewrite', () => {
    const endpoint: RunnerEndpointSettings = {
      headersToRewrite: { 'x-before-auth': 'rewritten' },
      authHeaderName: 'x-auth'
    };
    const result = applyRequestAlteration({
      request: {
        url: 'https://api.example.com/v1/messages',
        method: 'POST',
        headers: { 'x-before-auth': 'original' }
      },
      endpoint,
      credential: 'my-token'
    });
    expect(result.request.headers['x-before-auth']).toBe('rewritten');
    expect(result.request.headers['x-auth']).toBe('Bearer my-token');
  });

  it('does not add a header when headersToRewrite references a header not present in the request', () => {
    const endpoint: RunnerEndpointSettings = {
      headersToRewrite: { 'x-absent-header': 'should-not-appear' }
    };
    const result = applyRequestAlteration({
      request: {
        url: 'https://api.example.com/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      },
      endpoint
    });
    expect(result.request.headers['x-absent-header']).toBeUndefined();
    expect(result.request.headers['content-type']).toBe('application/json');
  });

  it('uses raw auth scheme when authScheme is raw', () => {
    const endpoint: RunnerEndpointSettings = {
      authHeaderName: 'x-api-key'
    };
    const result = applyRequestAlteration({
      request: { url: 'https://api.example.com/v1/messages', method: 'POST' },
      endpoint,
      credential: 'raw-key',
      authScheme: 'raw'
    });
    expect(result.request.headers['x-api-key']).toBe('raw-key');
  });
});

// ---------------------------------------------------------------------------
// 2. baseUrl parsing
// ---------------------------------------------------------------------------
describe('applyRequestAlteration — baseUrl parsing', () => {
  it('preserves request path and query when baseUrl is set', () => {
    const endpoint: RunnerEndpointSettings = {
      baseUrl: 'https://proxy.internal.example.com/prefix'
    };
    const result = applyRequestAlteration({
      request: {
        url: 'https://api.anthropic.com/v1/messages?version=2023-06-01',
        method: 'POST'
      },
      endpoint
    });
    expect(result.request.url).toMatch(/^https:\/\/proxy\.internal\.example\.com/);
    expect(result.request.url).toContain('/prefix/v1/messages');
    expect(result.request.url).toContain('version=2023-06-01');
  });

  it('throws ProviderAlterationError with invalid_base_url when baseUrl is not a valid URL', () => {
    const endpoint: RunnerEndpointSettings = {
      baseUrl: 'not-a-url'
    };
    expect(() =>
      applyRequestAlteration({
        request: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
        endpoint
      })
    ).toThrow(ProviderAlterationError);
  });
});

// ---------------------------------------------------------------------------
// 3. No-alteration pass-through
// ---------------------------------------------------------------------------
describe('applyRequestAlteration — no-alteration pass-through', () => {
  it('passes through unchanged request with safe default timeout and retry when endpoint is empty', () => {
    const result = applyRequestAlteration({
      request: {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      },
      endpoint: {}
    });
    expect(result.request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(result.request.headers['content-type']).toBe('application/json');
    expect(result.timeoutMs).toBe(defaultRequestTimeoutMs);
    expect(result.retryPolicy.maxRetries).toBe(defaultMaxRetries);
  });
});

// ---------------------------------------------------------------------------
// 4. Header name validation
// ---------------------------------------------------------------------------
describe('validateHttpHeaderName', () => {
  it.each([
    ['authorization', true],
    ['x-api-key', true],
    ['X-Custom-Header', true],
    ['content-type', true],
    ['x-header with space', false],
    ['x-header\ttab', false],
    ['x-header@bad', false],
    ['', false]
  ])('validateHttpHeaderName(%s) returns %s', (name, expected) => {
    expect(validateHttpHeaderName(name)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 5. Retry classification
// ---------------------------------------------------------------------------
describe('isTransientProviderFailure', () => {
  it.each([408, 429, 500, 502, 503, 504])('returns true for HTTP %s', (status) => {
    expect(isTransientProviderFailure({ kind: 'http_status', status })).toBe(true);
  });

  it.each([400, 401, 403, 404])('returns false for HTTP %s', (status) => {
    expect(isTransientProviderFailure({ kind: 'http_status', status })).toBe(false);
  });

  it('returns true for transport_error kind', () => {
    expect(isTransientProviderFailure({ kind: 'transport_error', code: 'ECONNRESET' })).toBe(true);
    expect(isTransientProviderFailure({ kind: 'transport_error' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Claude process launch mapping
// ---------------------------------------------------------------------------
describe('buildClaudeProcessLaunchEnvironment', () => {
  const baseMaterializedEnv = {
    variables: {
      HOME: '/home/user',
      PATH: '/usr/bin:/bin',
      SOME_USER_VAR: 'user-value',
      ANTHROPIC_API_KEY: 'old-key-should-be-stripped'
    },
    secretVariableNames: ['SOME_SECRET']
  };

  it('strips provider-owned variables from materialized env', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: {},
      credential: 'new-credential',
      materializedEnvironment: baseMaterializedEnv
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    for (const varName of claudeProviderOwnedEnvironmentVariables) {
      // Only the mapped ones should be present; the old materialized values should not survive
      // unless added by the function itself
      const presentInMaterialized = varName in baseMaterializedEnv.variables;
      if (presentInMaterialized) {
        // Should be overwritten by the function's own logic (not the old materialized value)
        if (result.environment[varName] !== undefined) {
          expect(result.environment[varName]).not.toBe(baseMaterializedEnv.variables[varName as keyof typeof baseMaterializedEnv.variables]);
        }
      }
    }
    // User variables should remain
    expect(result.environment['HOME']).toBe('/home/user');
    expect(result.environment['PATH']).toBe('/usr/bin:/bin');
  });

  it('maps baseUrl to ANTHROPIC_BASE_URL', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: { baseUrl: 'https://proxy.example.com' },
      credential: 'cred',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    expect(result.environment['ANTHROPIC_BASE_URL']).toBe('https://proxy.example.com');
  });

  it('maps credential to ANTHROPIC_AUTH_TOKEN when authEnvironmentVariable is ANTHROPIC_AUTH_TOKEN', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: { authEnvironmentVariable: 'ANTHROPIC_AUTH_TOKEN' },
      credential: 'my-auth-token',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    expect(result.environment['ANTHROPIC_AUTH_TOKEN']).toBe('my-auth-token');
    expect(result.environment['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(result.secretVariableNames).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('maps credential to ANTHROPIC_API_KEY when authEnvironmentVariable is ANTHROPIC_API_KEY', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: { authEnvironmentVariable: 'ANTHROPIC_API_KEY' },
      credential: 'my-api-key',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    expect(result.environment['ANTHROPIC_API_KEY']).toBe('my-api-key');
    expect(result.environment['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(result.secretVariableNames).toContain('ANTHROPIC_API_KEY');
  });

  it('defaults to ANTHROPIC_API_KEY when authEnvironmentVariable is not set', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: {},
      credential: 'default-key',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    expect(result.environment['ANTHROPIC_API_KEY']).toBe('default-key');
    expect(result.secretVariableNames).toContain('ANTHROPIC_API_KEY');
  });

  it('maps header rewrites to ANTHROPIC_CUSTOM_HEADERS as JSON string', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: {
        headersToRewrite: { 'x-custom': 'value1', 'x-other': 'value2' }
      },
      credential: 'cred',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    const customHeaders = JSON.parse(result.environment['ANTHROPIC_CUSTOM_HEADERS'] as string) as Record<string, string>;
    expect(customHeaders['x-custom']).toBe('value1');
    expect(customHeaders['x-other']).toBe('value2');
  });

  it('maps timeout to API_TIMEOUT_MS bounded by maximum', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: { requestTimeoutMs: 999_999_999 }, // exceeds max
      credential: 'cred',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    expect(result.environment['API_TIMEOUT_MS']).toBe(String(maximumRequestTimeoutMs));
  });

  it('maps retries to CLAUDE_CODE_MAX_RETRIES bounded by maximum', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: { maxRetries: 999 }, // exceeds max
      credential: 'cred',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    expect(result.environment['CLAUDE_CODE_MAX_RETRIES']).toBe(String(maximumMaxRetries));
  });

  it('strips ANTHROPIC_AUTH_TOKEN from materialized env even when credential is mapped to ANTHROPIC_API_KEY', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: { authEnvironmentVariable: 'ANTHROPIC_API_KEY' },
      credential: 'new-key',
      materializedEnvironment: {
        variables: {
          HOME: '/home/user',
          ANTHROPIC_AUTH_TOKEN: 'old-auth-token-must-be-stripped',
          ANTHROPIC_API_KEY: 'old-api-key-must-be-stripped'
        },
        secretVariableNames: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    // The old ANTHROPIC_AUTH_TOKEN from materializedEnvironment must not survive
    expect(result.environment['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    // The credential is mapped to ANTHROPIC_API_KEY with the new value
    expect(result.environment['ANTHROPIC_API_KEY']).toBe('new-key');
  });

  it('does not mutate the input environment', () => {
    const originalVars = { HOME: '/home/user', ANTHROPIC_API_KEY: 'old' };
    const input: ClaudeProcessLaunchInput = {
      endpoint: { baseUrl: 'https://proxy.example.com' },
      credential: 'new',
      materializedEnvironment: { variables: { ...originalVars }, secretVariableNames: [] }
    };
    buildClaudeProcessLaunchEnvironment(input);
    expect(input.materializedEnvironment.variables['HOME']).toBe('/home/user');
    expect(input.materializedEnvironment.variables['ANTHROPIC_API_KEY']).toBe('old');
  });
});

// ---------------------------------------------------------------------------
// 7. Unsupported Claude header strip (degradation metadata)
// ---------------------------------------------------------------------------
describe('buildClaudeProcessLaunchEnvironment — header strip degradation', () => {
  it('produces degradation metadata for headersToStrip when not required', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: {
        headersToStrip: ['x-remove-this'],
        requiredAlterations: { headerStrip: false }
      },
      credential: 'cred',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    const degradation = result.degradedCapabilities.find((d: ProviderCapabilityDegradation) => d.capability === 'header_strip');
    expect(degradation).toBeDefined();
    expect(degradation?.required).toBe(false);
  });

  it('returns ProviderAlterationError for headersToStrip when requiredAlterations.headerStrip is true', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: {
        headersToStrip: ['x-critical-header'],
        requiredAlterations: { headerStrip: true }
      },
      credential: 'cred',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    expect(() => buildClaudeProcessLaunchEnvironment(input)).toThrow(ProviderAlterationError);
    try {
      buildClaudeProcessLaunchEnvironment(input);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAlterationError);
      expect((err as ProviderAlterationError).code).toBe('unsupported_required_capability');
    }
  });

  it('produces no degradation when headersToStrip is empty or absent', () => {
    const input: ClaudeProcessLaunchInput = {
      endpoint: {},
      credential: 'cred',
      materializedEnvironment: { variables: {}, secretVariableNames: [] }
    };
    const result = buildClaudeProcessLaunchEnvironment(input);
    const degradation = result.degradedCapabilities.find((d: ProviderCapabilityDegradation) => d.capability === 'header_strip');
    expect(degradation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Redaction
// ---------------------------------------------------------------------------
const KNOWN_SECRET = 'known-secret-value-that-must-not-leak';

describe('redaction — known secrets must not appear in log projections', () => {
  it('does not expose secret in redacted request log projection', () => {
    const request: ProviderRequest = {
      url: `https://api.example.com/v1/messages?key=${KNOWN_SECRET}`,
      method: 'POST',
      headers: { authorization: `Bearer ${KNOWN_SECRET}`, 'content-type': 'application/json' },
      body: { prompt: `Message: ${KNOWN_SECRET}` }
    };
    const redacted = redactProviderRequestForLog({
      request,
      knownSecretValues: [KNOWN_SECRET],
      sensitiveHeaderNames: ['authorization']
    });
    expect(JSON.stringify(redacted).includes(KNOWN_SECRET)).toBe(false);
  });

  it('does not expose secret in redacted response log projection', () => {
    const redacted = redactProviderResponseForLog({
      statusCode: 200,
      headers: { 'set-cookie': `session=${KNOWN_SECRET}`, 'content-type': 'application/json' },
      knownSecretValues: [KNOWN_SECRET]
    });
    expect(JSON.stringify(redacted).includes(KNOWN_SECRET)).toBe(false);
  });

  it('does not expose secret in redacted retry/failure log projection', () => {
    // Failure is represented via a request redaction — combine with retry context
    const request: ProviderRequest = {
      url: 'https://api.example.com/v1/messages',
      method: 'POST',
      headers: { 'x-api-key': KNOWN_SECRET }
    };
    const redacted = redactProviderRequestForLog({
      request,
      knownSecretValues: [KNOWN_SECRET],
      sensitiveHeaderNames: ['x-api-key']
    });
    expect(JSON.stringify(redacted).includes(KNOWN_SECRET)).toBe(false);
  });

  it('returns [non-serializable body] for a body with circular references', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular; // circular reference
    const redacted = redactProviderRequestForLog({
      request: {
        url: 'https://api.example.com/v1/messages',
        method: 'POST',
        body: circular
      }
    });
    const redactedObj = redacted as Record<string, unknown>;
    expect(redactedObj['body']).toBe('[non-serializable body]');
  });

  it('does not expose secret in redacted process launch config log projection', () => {
    const launchResult: ClaudeProcessLaunchResult = {
      environment: {
        HOME: '/home/user',
        ANTHROPIC_API_KEY: KNOWN_SECRET,
        ANTHROPIC_BASE_URL: 'https://proxy.example.com'
      },
      secretVariableNames: ['ANTHROPIC_API_KEY'],
      degradedCapabilities: []
    };
    const redacted = redactProcessLaunchConfigForLog({
      launchResult,
      knownSecretValues: [KNOWN_SECRET]
    });
    expect(JSON.stringify(redacted).includes(KNOWN_SECRET)).toBe(false);
  });
});
