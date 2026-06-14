import http from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createLoopbackProxy } from './loopback-proxy.js';

async function startFakeUpstream(handler: http.RequestListener): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('missing address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/upstream`,
    close: async () => { server.close(); await once(server, 'close'); }
  };
}

describe('createLoopbackProxy', () => {
  it('binds to loopback random port and closes cleanly', async () => {
    const upstream = await startFakeUpstream((_req, res) => res.end('{}'));
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'spec.author' }
    });

    expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(proxy.requestCount()).toBe(0);
    await proxy.close();
    await upstream.close();
  });

  it('preserves path/query and injects api-key while stripping configured headers', async () => {
    const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = [];
    const upstream = await startFakeUpstream((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json', 'connection': 'close' });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { authHeaderName: 'api-key', headersToStrip: ['x-api-key'] },
      credential: 'secret-grove-key',
      telemetryContext: { runId: 'run_1', step: 'spec.author' }
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages?x=1`, { headers: { 'x-api-key': 'sdk-default' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen[0]?.url).toBe('/upstream/v1/messages?x=1');
    expect(seen[0]?.headers['api-key']).toBe('secret-grove-key');
    expect(seen[0]?.headers['x-api-key']).toBeUndefined();

    await proxy.close();
    await upstream.close();
  });

  it('returns a safe 502 JSON envelope on upstream transport failure', async () => {
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: 'http://127.0.0.1:9',
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'spec.author' }
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' }
    });

    await proxy.close();
  });

  it('streams chunks without buffering the full response', async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('chunk-1\n');
      setTimeout(() => {
        res.write('chunk-2\n');
        res.end();
      }, 25);
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'spec.author' }
    });

    const response = await fetch(`${proxy.baseUrl}/stream`);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('chunk-1\n');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('chunk-2\n');

    await proxy.close();
    await upstream.close();
  });
});
