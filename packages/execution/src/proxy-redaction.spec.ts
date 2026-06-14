import { describe, expect, it } from 'vitest';
import { redactKnownSecretText, redactProxyHeaders } from './proxy-redaction.js';

describe('proxy redaction', () => {
  it('redacts request credential header names case-insensitively', () => {
    expect(redactProxyHeaders({
      direction: 'request',
      headers: {
        Authorization: 'Bearer secret-token',
        'api-key': 'secret-key',
        'x-api-key': 'secret-x-key',
        'content-type': 'application/json'
      },
      knownSecretValues: ['secret-token', 'secret-key', 'secret-x-key']
    })).toEqual({
      Authorization: '[redacted]',
      'api-key': '[redacted]',
      'x-api-key': '[redacted]',
      'content-type': 'application/json'
    });
  });

  it('redacts response credential-bearing headers', () => {
    expect(redactProxyHeaders({
      direction: 'response',
      headers: {
        'set-cookie': 'session=secret-cookie',
        'www-authenticate': 'Bearer realm="secret"',
        'proxy-authenticate': 'Basic realm="secret"',
        authorization: 'Bearer secret-token',
        'content-type': 'text/event-stream'
      },
      knownSecretValues: ['secret-cookie', 'secret-token']
    })).toEqual({
      'set-cookie': '[redacted]',
      'www-authenticate': '[redacted]',
      'proxy-authenticate': '[redacted]',
      authorization: '[redacted]',
      'content-type': 'text/event-stream'
    });
  });

  it('redacts known secret sentinel values from captured text', () => {
    expect(redactKnownSecretText('before secret-token after', {
      knownSecretValues: ['secret-token']
    })).toBe('before [redacted] after');
  });
});
