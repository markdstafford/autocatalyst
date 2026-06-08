import { describe, expect, it } from 'vitest';

import { errorResponseSchema } from './errors.js';
import {
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  probeResourceCollectionPath,
  probeResourceIdParamsSchema,
  probeResourceSchema,
  type CreateProbeResourceRequest,
  type ProbeResource,
  type ProbeResourceIdParams
} from './probe-resource.js';
import { eventsStreamPath, sseHeadersSchema, type SseHeaders } from './sse.js';

describe('probe-resource contract', () => {
  it('exports versioned route and status constants', () => {
    expect(probeResourceCollectionPath).toBe('/v1/probe-resources');
    expect(createProbeResourceSuccessStatusCode).toBe(201);
    expect(eventsStreamPath).toBe('/v1/events');
  });

  it('parses create requests and rejects invalid bodies', () => {
    const parsed = createProbeResourceRequestSchema.parse({ value: 'contract-path' });
    const typed: CreateProbeResourceRequest = parsed;

    expect(typed).toEqual({ value: 'contract-path' });
    expect(() => createProbeResourceRequestSchema.parse({ value: '' })).toThrow();
    expect(() => createProbeResourceRequestSchema.parse({ value: 42 })).toThrow();
  });

  it('parses id params and rejects empty ids', () => {
    const parsed = probeResourceIdParamsSchema.parse({ id: 'probe_123' });
    const typed: ProbeResourceIdParams = parsed;

    expect(typed).toEqual({ id: 'probe_123' });
    expect(() => probeResourceIdParamsSchema.parse({ id: '' })).toThrow();
  });

  it('parses probe resource responses and rejects invalid timestamps', () => {
    const resource = {
      id: 'probe_123',
      value: 'stored value',
      createdAt: '2026-06-08T12:00:00.000Z'
    };
    const parsed = probeResourceSchema.parse(resource);
    const typed: ProbeResource = parsed;

    expect(typed).toEqual(resource);
    expect(() =>
      probeResourceSchema.parse({ id: 'probe_123', value: 'stored value', createdAt: 'yesterday' })
    ).toThrow();
  });

  it('parses shared error envelopes', () => {
    expect(
      errorResponseSchema.parse({ error: { code: 'not_found', message: 'Probe resource not found' } })
    ).toEqual({ error: { code: 'not_found', message: 'Probe resource not found' } });
  });

  it('documents broad SSE header semantics', () => {
    const headers = sseHeadersSchema.parse({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    const typed: SseHeaders = headers;

    expect(typed['content-type']).toContain('text/event-stream');
  });
});
