import { describe, expect, it } from 'vitest';
import { applyProxyHeaderPolicy, mapLoopbackUrlToUpstream } from './proxy-header-policy.js';

describe('mapLoopbackUrlToUpstream', () => {
  it('preserves upstream base path plus loopback path and query', () => {
    const mapped = mapLoopbackUrlToUpstream(
      'http://127.0.0.1:41234/v1/messages?x=1',
      'https://gateway.example.test/anthropic'
    );
    expect(mapped.toString()).toBe('https://gateway.example.test/anthropic/v1/messages?x=1');
  });

  it('rejects absolute-form requests that override the upstream host', () => {
    expect(() => mapLoopbackUrlToUpstream(
      'http://127.0.0.1:41234/https://evil.example.test/v1/messages',
      'https://gateway.example.test/anthropic'
    )).toThrow(/proxy_request_malformed/u);
  });

  it('rejects invalid upstream base URL', () => {
    expect(() => mapLoopbackUrlToUpstream(
      'http://127.0.0.1:41234/v1/messages',
      'not-a-url'
    )).toThrow(/proxy_invalid_upstream/u);
  });
});

describe('applyProxyHeaderPolicy', () => {
  it('strips hop-by-hop headers before forwarding but preserves content-length', () => {
    const result = applyProxyHeaderPolicy({
      headers: {
        host: '127.0.0.1:41234',
        connection: 'keep-alive',
        'content-length': '99',
        'content-type': 'application/json'
      },
      endpoint: {}
    });
    expect(result.headers).toEqual({ 'content-length': '99', 'content-type': 'application/json' });
    expect(result.strippedHeaders).toEqual(expect.arrayContaining(['host', 'connection']));
    expect(result.strippedHeaders).not.toContain('content-length');
  });

  it('applies endpoint strip, exact token filters, additive rewrites, then auth injection', () => {
    const result = applyProxyHeaderPolicy({
      headers: {
        'x-api-key': 'sdk-default',
        'anthropic-beta': 'foo, gateway-beta, xgateway-beta, bar',
        'x-static': 'old'
      },
      endpoint: {
        authHeaderName: 'api-key',
        headersToStrip: ['x-api-key'],
        headersToRewrite: {
          'x-static': 'new',
          'x-added': 'added-value',
          'api-key': 'static-wrong-value'
        }
      },
      credential: 'secret-grove-key',
      headerValueFilters: [
        { headerName: 'anthropic-beta', removeValues: ['gateway-beta'] }
      ],
      forceIdentityAcceptEncoding: true
    });

    expect(result.headers).toEqual({
      'anthropic-beta': 'foo, xgateway-beta, bar',
      'x-static': 'new',
      'x-added': 'added-value',
      'api-key': 'secret-grove-key',
      'accept-encoding': 'identity'
    });
    expect(result.filteredHeaders).toContain('anthropic-beta');
    expect(result.injectedAuthHeaderName).toBe('api-key');
  });

  it('does not remove partial substring matches from token filters', () => {
    const result = applyProxyHeaderPolicy({
      headers: { 'anthropic-beta': 'xgateway-beta, gateway-beta' },
      endpoint: {},
      headerValueFilters: [{ headerName: 'anthropic-beta', removeValues: ['gateway-beta'] }]
    });
    // 'xgateway-beta' must NOT be removed (partial match forbidden)
    expect(result.headers['anthropic-beta']).toBe('xgateway-beta');
  });

  it('omits header entirely when all tokens are removed by filter', () => {
    const result = applyProxyHeaderPolicy({
      headers: { 'anthropic-beta': 'gateway-beta' },
      endpoint: {},
      headerValueFilters: [{ headerName: 'anthropic-beta', removeValues: ['gateway-beta'] }]
    });
    expect(result.headers['anthropic-beta']).toBeUndefined();
    expect(result.filteredHeaders).toContain('anthropic-beta');
  });

  it('does not remove tokens that differ only in case from removeValues (token matching is case-sensitive)', () => {
    const result = applyProxyHeaderPolicy({
      headers: { 'anthropic-beta': 'Gateway-Beta, gateway-beta' },
      endpoint: {},
      headerValueFilters: [{ headerName: 'anthropic-beta', removeValues: ['gateway-beta'] }]
    });
    // 'Gateway-Beta' must NOT be removed (case-sensitive token match)
    // 'gateway-beta' IS removed (exact match)
    expect(result.headers['anthropic-beta']).toBe('Gateway-Beta');
  });

  it('matches filter headerName case-insensitively against incoming headers', () => {
    const result = applyProxyHeaderPolicy({
      headers: { 'anthropic-beta': 'foo, gateway-beta' },
      endpoint: {},
      // Filter uses mixed case header name — should still match 'anthropic-beta'
      headerValueFilters: [{ headerName: 'Anthropic-Beta', removeValues: ['gateway-beta'] }]
    });
    expect(result.headers['anthropic-beta']).toBe('foo');
    expect(result.filteredHeaders).toContain('anthropic-beta');
  });
});
