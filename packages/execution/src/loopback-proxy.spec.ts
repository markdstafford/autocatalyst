import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLoopbackProxy, type ProxyUpstreamFailureRecord } from './loopback-proxy.js';

const TRANSIENT_STATUSES = [408, 429, 500, 502, 503, 504, 529];

interface CapturedLog { readonly event: string; readonly fields: unknown; }

function captureConnectionLogger(): {
  logger: { info(e: string, f: unknown): void; warn(e: string, f: unknown): void; error(e: string, f: unknown): void };
  infos: CapturedLog[];
  warns: CapturedLog[];
  errors: CapturedLog[];
} {
  const infos: CapturedLog[] = [];
  const warns: CapturedLog[] = [];
  const errors: CapturedLog[] = [];
  return {
    logger: {
      info: (event, fields) => { infos.push({ event, fields }); },
      warn: (event, fields) => { warns.push({ event, fields }); },
      error: (event, fields) => { errors.push({ event, fields }); }
    },
    infos,
    warns,
    errors
  };
}

function failureRecords(warns: CapturedLog[]): ProxyUpstreamFailureRecord[] {
  return warns.filter((w) => w.event === 'proxy.upstream_failure').map((w) => w.fields as ProxyUpstreamFailureRecord);
}

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
    // With no endpoint.maxRetries, the monotonic proxy budget controls retries. Advance the injected
    // monotonic clock past the 60s budget immediately so the single attempt exhausts without real delay.
    let mono = 0;
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: 'http://127.0.0.1:9',
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      sleep: async () => undefined,
      monotonicNow: () => { const v = mono; mono += 70_000; return v; }
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

  it('honors Retry-After: 30 up to requestTimeoutMs without capping at 5s', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      if (attempts === 1) {
        res.writeHead(429, { 'retry-after': '30' });
        res.end('retry later');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 1 },
      requestTimeoutMs: 600_000,
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      sleep: async (ms) => { sleeps.push(ms); },
      jitter: () => 0
    });
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    // Should be 30000ms, not capped at the old 5000ms hard limit
    expect(sleeps).toEqual([30_000]);
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
    try {
      await fetch(`${proxy.baseUrl}/stream`);
    } catch {
      // fetch aborts when upstream destroys mid-stream; the attempt count is what matters
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(1);
    await proxy.close();
    await upstream.close();
  });

  it('returns a safe 502 when a transient 429 retry is followed by a pre-header socket error', async () => {
    // Regression: responseCommitted was set to true by the 429 response callback even for
    // transient responses. When the next retry attempt hit a transport error, the error handler
    // saw responseCommitted=true and returned early, leaving the client request hanging.
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      if (attempts === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'overloaded' }));
        return;
      }
      // Destroy socket before writing any response headers (pre-header transport error)
      req.socket.destroy();
    });

    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 1 },
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      sleep: async () => undefined,
      jitter: () => 0
    });

    const response = await fetch(`${proxy.baseUrl}/test`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' } });
    expect(attempts).toBe(2);

    await proxy.close();
    await upstream.close();
  });

  it('cancels pending retry when downstream client disconnects during sleep', async () => {
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'overloaded' }));
    });

    // Capture the sleep resolve callback so we can abort during sleep
    let resolveSleep: (() => void) | undefined;

    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 1 },
      telemetryContext: { runId: 'run_1', step: 'spec.author' },
      sleep: () => new Promise<void>((resolve) => { resolveSleep = resolve; }),
      jitter: () => 0
    });

    // Make a request but don't await it — we'll disconnect during sleep
    const ctrl = new AbortController();
    const fetchPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      body: '{}',
      signal: ctrl.signal
    });

    // Wait until the sleep is registered (after first 429)
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (resolveSleep !== undefined) { clearInterval(poll); resolve(); }
      }, 5);
    });

    // Abort the downstream client connection
    ctrl.abort();
    try { await fetchPromise; } catch { /* expected AbortError */ }

    // Allow a tick for the 'close' event to propagate
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Now resolve the sleep — attempt() should be a no-op
    resolveSleep!();

    // Allow a tick for the scheduled attempt() to run (if it were going to)
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Upstream should only have been called once (the 429), not a second time
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

describe('createLoopbackProxy — safe failure records, monotonic budget, unrecovered evidence', () => {
  it('records retrying attempts then exhausted for a persistently transient upstream', async () => {
    const upstream = await startFakeUpstream((req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporary' }));
    });
    const cap = captureConnectionLogger();
    let mono = 0;
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'implementation.build', profileName: 'grove-cp3' },
      logger: cap.logger,
      retryBudget: { budgetMs: 1000, transientHttpStatuses: TRANSIENT_STATUSES, baseDelayMs: 250, maximumDelayMs: 5000 },
      sleep: async (ms) => { mono += ms; },
      jitter: () => 0,
      monotonicNow: () => mono
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);

    const records = failureRecords(cap.warns);
    expect(records.length).toBeGreaterThanOrEqual(2);
    const last = records[records.length - 1]!;
    expect(last.outcome).toBe('exhausted');
    expect(last.status).toBe(503);
    expect(last.responseStarted).toBe(false);
    expect(last.bodyBytesStreamed).toBe(0);
    expect(last.profileName).toBe('grove-cp3');
    expect(last.upstreamOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(records.slice(0, -1).every((r) => r.outcome === 'retrying')).toBe(true);
    // Monotonic elapsed advances across attempts.
    expect(last.elapsedMs).toBeGreaterThan(0);

    const evidence = proxy.unrecoveredFailureRecord();
    expect(evidence?.outcome).toBe('exhausted');

    await proxy.close();
    await upstream.close();
  });

  it('emits a retry-success info record and clears unrecovered evidence after a transient blip', async () => {
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      if (attempts === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'blip' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const cap = captureConnectionLogger();
    let mono = 0;
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      logger: cap.logger,
      retryBudget: { budgetMs: 60000, transientHttpStatuses: TRANSIENT_STATUSES, baseDelayMs: 250, maximumDelayMs: 5000 },
      sleep: async (ms) => { mono += ms; },
      jitter: () => 0,
      monotonicNow: () => mono
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);

    const records = failureRecords(cap.warns);
    expect(records.length).toBe(1);
    expect(records[0]!.outcome).toBe('retrying');

    const successRecords = cap.infos.filter((i) => i.event === 'proxy.upstream_retry_success');
    expect(successRecords.length).toBe(1);
    expect((successRecords[0]!.fields as { attempt: number }).attempt).toBe(2);

    // A completed upstream response clears the unrecovered evidence.
    expect(proxy.unrecoveredFailureRecord()).toBeUndefined();

    await proxy.close();
    await upstream.close();
  });

  it('a retrying record never qualifies as unrecovered evidence mid-flight', async () => {
    let released: (() => void) | undefined;
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      if (attempts === 1) {
        res.writeHead(503, {});
        res.end('blip');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      // Pause during the retry sleep so we can inspect evidence while a 'retrying' record is the latest.
      sleep: () => new Promise<void>((resolve) => { released = resolve; }),
      jitter: () => 0
    });

    const fetchPromise = fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => { if (released !== undefined) { clearInterval(poll); resolve(); } }, 5);
    });
    // Mid-flight: a 'retrying' record is the latest, but it must not qualify as unrecovered evidence.
    expect(proxy.unrecoveredFailureRecord()).toBeUndefined();
    released!();
    const response = await fetchPromise;
    expect(response.status).toBe(200);

    await proxy.close();
    await upstream.close();
  });

  it('records a timeout outcome without retrying and exposes it as unrecovered evidence', async () => {
    const held: import('node:http').ServerResponse[] = [];
    const upstream = await startFakeUpstream((req, res) => {
      req.resume();
      held.push(res); // never respond — force a request timeout
    });
    const cap = captureConnectionLogger();
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      logger: cap.logger,
      requestTimeoutMs: 60,
      sleep: async () => undefined
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);

    const records = failureRecords(cap.warns);
    expect(records.length).toBe(1);
    expect(records[0]!.outcome).toBe('timeout');
    expect(records[0]!.responseStarted).toBe(false);
    expect(proxy.unrecoveredFailureRecord()?.outcome).toBe('timeout');

    held.forEach((res) => res.end());
    await proxy.close();
    await upstream.close();
  });

  it('records a mid_stream failure (responseStarted, streamed bytes) and does not proxy-retry it', async () => {
    let attempts = 0;
    let destroyUpstream: (() => void) | undefined;
    const upstream = await startFakeUpstream((_req, res) => {
      attempts += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: partial\n\n');
      destroyUpstream = () => res.destroy();
    });
    const cap = captureConnectionLogger();
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 3 },
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      logger: cap.logger,
      sleep: async () => undefined
    });

    const fetchPromise = fetch(`${proxy.baseUrl}/events`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    destroyUpstream?.();
    try { await fetchPromise; } catch { /* stream aborts mid-flight */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    const records = failureRecords(cap.warns);
    const midStream = records.find((r) => r.outcome === 'mid_stream');
    expect(midStream).toBeDefined();
    expect(midStream!.responseStarted).toBe(true);
    expect(midStream!.bodyBytesStreamed).toBeGreaterThan(0);
    // No proxy retry after the response started.
    expect(attempts).toBe(1);
    expect(proxy.unrecoveredFailureRecord()?.outcome).toBe('mid_stream');

    await proxy.close();
    await upstream.close();
  });

  it('uses the injected monotonic clock for the budget so a wall-clock jump cannot consume it', async () => {
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      if (attempts === 1) {
        res.writeHead(503, {});
        res.end('blip');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    // Monotonic time barely advances even though the (simulated 10-minute) sleep "passed" a lot of
    // wall-clock time. Budget decisions use the monotonic clock, so the retry still fits and succeeds.
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      sleep: async () => undefined, // represents ~10 minutes of wall-clock sleep/wake
      jitter: () => 0,
      monotonicNow: () => 5 // monotonic clock essentially unmoved
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);

    await proxy.close();
    await upstream.close();
  });

  it('caps proxy attempts at endpoint.maxRetries even when monotonic budget remains', async () => {
    let attempts = 0;
    const upstream = await startFakeUpstream((req, res) => {
      attempts += 1;
      req.resume();
      res.writeHead(503, {});
      res.end('temporary');
    });
    const cap = captureConnectionLogger();
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: { maxRetries: 1 },
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      logger: cap.logger,
      // Large budget; the maxRetries cap must stop retries first.
      retryBudget: { budgetMs: 60000, maxRetries: 1, transientHttpStatuses: TRANSIENT_STATUSES, baseDelayMs: 250, maximumDelayMs: 5000 },
      sleep: async () => undefined,
      jitter: () => 0
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    expect(attempts).toBe(2); // initial + 1 retry
    expect(failureRecords(cap.warns).at(-1)?.outcome).toBe('exhausted');

    await proxy.close();
    await upstream.close();
  });

  it('never leaks a sentinel secret from request header or body into failure records', async () => {
    const sentinel = 'sk-SENTINEL-LEAK-TEST-0001';
    const upstream = await startFakeUpstream((req, res) => {
      req.resume();
      res.writeHead(503, {});
      res.end('temporary');
    });
    const cap = captureConnectionLogger();
    let mono = 0;
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {},
      credential: sentinel,
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      logger: cap.logger,
      retryBudget: { budgetMs: 800, transientHttpStatuses: TRANSIENT_STATUSES, baseDelayMs: 250, maximumDelayMs: 5000 },
      sleep: async (ms) => { mono += ms; },
      jitter: () => 0,
      monotonicNow: () => mono
    });

    await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-secret': sentinel, authorization: `Bearer ${sentinel}` },
      body: JSON.stringify({ prompt: `uses ${sentinel}` })
    });

    const dump = JSON.stringify(cap.warns);
    expect(dump).not.toContain(sentinel);
    expect(failureRecords(cap.warns).length).toBeGreaterThan(0);

    await proxy.close();
    await upstream.close();
  });

  it('spends about the default 60s monotonic budget on a fully-down upstream (simulated clock, no real delay)', async () => {
    // Full network outage: every attempt returns a transient status and the proxy rides the default
    // 60000 ms budget via the injected monotonic clock. This is the per-request proxy term of the
    // worst-case formula (1 + SDK retries) × PROXY_RETRY_BUDGET_MS × (1 + RUNNER_SESSION_MAX_RETRIES).
    const upstream = await startFakeUpstream((req, res) => {
      req.resume();
      res.writeHead(503, {});
      res.end('down');
    });
    const cap = captureConnectionLogger();
    let mono = 0;
    const proxy = await createLoopbackProxy({
      upstreamBaseUrl: upstream.baseUrl,
      endpoint: {}, // no maxRetries => budget-controlled, default 60000 ms
      telemetryContext: { runId: 'run_1', step: 'implementation.build' },
      logger: cap.logger,
      sleep: async (ms) => { mono += ms; },
      jitter: () => 0,
      monotonicNow: () => mono
    });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(502);
    const last = failureRecords(cap.warns).at(-1)!;
    expect(last.outcome).toBe('exhausted');
    // The budget window is ~60s; we stop just before a delay would overshoot it.
    expect(last.elapsedMs).toBeGreaterThanOrEqual(55000);
    expect(last.elapsedMs).toBeLessThanOrEqual(60000);

    await proxy.close();
    await upstream.close();
  });
});
