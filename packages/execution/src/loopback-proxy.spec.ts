import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  it('rejects unsupported upstream schemes before the server starts', async () => {
    await expect(
      createLoopbackProxy({
        upstreamBaseUrl: 'ftp://files.example.test/bucket',
        endpoint: {},
        telemetryContext: { runId: 'run_1', step: 'spec.author' }
      })
    ).rejects.toThrow(/proxy_invalid_upstream/u);

    await expect(
      createLoopbackProxy({
        upstreamBaseUrl: 'ws://realtime.example.test',
        endpoint: {},
        telemetryContext: { runId: 'run_1', step: 'spec.author' }
      })
    ).rejects.toThrow(/proxy_invalid_upstream/u);
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

  it('writes redacted request and response dumps when logging is enabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-e2e-'));
    const upstream = await startFakeUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'authorization': 'Bearer upstream-secret' });
      res.end(JSON.stringify({ usage: { output_tokens: 7 }, text: 'ok' }));
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { authHeaderName: 'api-key' },
      credential: 'secret-grove-key',
      logging: { enabled: true, diagnosticRoot: root, bodyCaptureBytes: 64 },
      telemetryContext: { runId: 'run_1', step: 'spec.author' }
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'uses secret-grove-key' })
    });
    expect(response.status).toBe(200);
    await response.text();

    const files = await readdir(root);
    const requestFile = files.find((name) => name.endsWith('.request.json'))!;
    const responseFile = files.find((name) => name.endsWith('.response.json'))!;
    const requestDump = await readFile(path.join(root, requestFile), 'utf8');
    const responseDump = JSON.parse(await readFile(path.join(root, responseFile), 'utf8'));

    expect(requestDump).not.toContain('secret-grove-key');
    expect(responseDump.status).toBe(200);
    expect(responseDump.output_tokens).toBe(7);
    expect(responseDump.headers.authorization).toBe('[redacted]');
    expect(responseDump.timing_ms.total).toBeGreaterThanOrEqual(0);

    await proxy.close();
    await upstream.close();
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

  it('writes stream_state=aborted dump when client disconnects before stream ends', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-abort-'));
    let upstreamChunksSent = 0;
    let upstreamEnd: (() => void) | undefined;
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: chunk1\n\n');
      upstreamChunksSent++;
      // Hold open so the proxy never sees 'end' before client abort
      upstreamEnd = () => res.end();
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      logging: { enabled: true, diagnosticRoot: root }
    });

    // Abort the request after receiving the first chunk
    const ctrl = new AbortController();
    const fetchPromise = fetch(`${proxy.baseUrl}/events`, { signal: ctrl.signal });
    // Wait briefly for the first chunk to arrive, then abort
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    ctrl.abort();
    try { await fetchPromise; } catch { /* expected */ }

    // Allow a moment for abort/dump to be written
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const files = await readdir(root);
    const responseFile = files.find((name) => name.endsWith('.response.json'));
    expect(responseFile).toBeDefined();
    const responseDump = JSON.parse(await readFile(path.join(root, responseFile!), 'utf8'));
    expect(responseDump.stream_state).toBe('aborted');
    expect(upstreamChunksSent).toBeGreaterThan(0);

    upstreamEnd?.();
    await proxy.close();
    await upstream.close();
  });

  it('does not double-prefix upstream path when upstreamBaseUrl contains a path component', async () => {
    // Regression: the loopback proxy should forward /v1/messages to
    // upstream /anthropic/v1/messages, not /anthropic/anthropic/v1/messages.
    const seen: Array<{ url?: string }> = [];
    const upstream = await startFakeUpstream((req, res) => {
      seen.push({ url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    // upstream.baseUrl ends in /upstream (has a path); the proxy receives /v1/messages
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,  // e.g. http://127.0.0.1:PORT/upstream
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'spec.author' }
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`);
    expect(response.status).toBe(200);
    // Upstream should see /upstream/v1/messages, not /upstream/upstream/v1/messages
    expect(seen[0]?.url).toBe('/upstream/v1/messages');

    await proxy.close();
    await upstream.close();
  });

  it('writes stream_state=errored dump when upstream stream errors after headers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-error-'));
    let destroyUpstream: (() => void) | undefined;
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      // Simulate abrupt upstream disconnect mid-body
      destroyUpstream = () => res.destroy();
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      logging: { enabled: true, diagnosticRoot: root }
    });

    // Start request, then destroy the upstream while the response is in flight
    const fetchPromise = fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    destroyUpstream?.();
    try { await fetchPromise; } catch { /* expected */ }

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const files = await readdir(root);
    const responseFile = files.find((name) => name.endsWith('.response.json'));
    expect(responseFile).toBeDefined();
    const responseDump = JSON.parse(await readFile(path.join(root, responseFile!), 'utf8'));
    expect(responseDump.stream_state).toBe('errored');

    await proxy.close();
    await upstream.close();
  });

  it('retries a transient 429 response and succeeds on a later replayable attempt', async () => {
    let attempts = 0;
    const bodies: string[] = [];
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        bodies.push(body);
        if (attempts === 1) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'overloaded' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempts }));
      });
    });
    const sleeps: number[] = [];
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 2 },
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      sleep: async (ms) => { sleeps.push(ms); },
      jitter: () => 0
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, attempts: 2 });
    expect(attempts).toBe(2);
    expect(bodies).toEqual([JSON.stringify({ prompt: 'hello' }), JSON.stringify({ prompt: 'hello' })]);
    expect(sleeps).toEqual([250]);

    await proxy.close();
    await upstream.close();
  });

  it('returns a safe 502 envelope after transient retry exhaustion', async () => {
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporary' }));
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 1 },
      telemetryContext: { runId: 'run_1', step: 'implementation.build', role: 'reviewer' },
      sleep: async () => undefined,
      jitter: () => 0
    });
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' } });
    expect(attempts).toBe(2);
    await proxy.close();
    await upstream.close();
  });

  it('honors bounded Retry-After before retrying', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      if (attempts === 1) {
        res.writeHead(429, { 'retry-after': '2' });
        res.end('retry later');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 1 },
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      sleep: async (ms) => { sleeps.push(ms); },
      jitter: () => 0
    });
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([2000]);
    await proxy.close();
    await upstream.close();
  });

  it('rejects request bodies above the retry replay buffer cap without forwarding upstream', async () => {
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => { attempts += 1; req.resume(); res.end('{}'); });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 1 },
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      requestBodyBufferLimitBytes: 4
    });
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '12345' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'proxy_request_body_too_large', message: 'Provider proxy request body exceeded retry buffer limit.' } });
    expect(attempts).toBe(0);
    await proxy.close();
    await upstream.close();
  });

  it('does not retry after response streaming has started', async () => {
    let attempts = 0;
    const upstream = await startFakeUpstream((_req, res) => {
      attempts += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Flush chunk-1 first, THEN destroy — this ensures the proxy receives headers+data
      // before the socket reset, triggering the "streaming started" guard
      res.write('chunk-1\n', () => {
        res.destroy(new Error('stream failed after first byte'));
      });
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 3 },
      telemetryContext: { runId: 'run_1', step: 'implementation.build', role: 'reviewer' },
      sleep: async () => undefined
    });
    try { await fetch(`${proxy.baseUrl}/stream`); } catch { }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(1);
    await proxy.close();
    await upstream.close();
  });

  it('retries pre-header transport errors and succeeds on second attempt', async () => {
    let attempts = 0;
    const net = await import('node:net');
    const rawServer = net.createServer((socket) => {
      attempts += 1;
      if (attempts === 1) {
        socket.destroy();
        return;
      }
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes('\r\n\r\n')) {
          socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 10\r\n\r\n{"ok":true}');
          socket.end();
        }
      });
    });
    rawServer.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => rawServer.once('listening', resolve));
    const { port } = rawServer.address() as { port: number };

    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: `http://127.0.0.1:${port}/upstream`,
      endpoint: { maxRetries: 1 },
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      sleep: async () => undefined,
      jitter: () => 0
    });

    const response = await fetch(`${proxy.baseUrl}/test`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);

    await proxy.close();
    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });
});
