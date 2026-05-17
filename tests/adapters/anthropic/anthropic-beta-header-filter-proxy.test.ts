import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { startAnthropicBetaHeaderFilterProxy } from '../../../src/adapters/anthropic/anthropic-beta-header-filter-proxy.js';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

describe('Anthropic beta header filter proxy', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(server => close(server)));
    servers.length = 0;
  });

  test('removes configured beta values from proxied requests', async () => {
    const received: Array<{ url: string | undefined; headers: IncomingHttpHeaders; body: string }> = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'ok' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}/anthropic`, {
      stripBetaValues: ['advisor-tool-2026-03-01', 'context-management-2025-06-27'],
    });
    servers.push(proxy.server);

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': 'sk-test',
        'anthropic-beta': 'context-1m-2025-08-07, context-management-2025-06-27, advisor-tool-2026-03-01, task-budgets-2026-03-13',
      },
      body: JSON.stringify({ stream: false }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/anthropic/v1/messages');
    expect(received[0].body).toBe(JSON.stringify({ stream: false }));
    expect(received[0].headers['api-key']).toBe('sk-test');
    expect(received[0].headers['anthropic-beta']).toBe('context-1m-2025-08-07, task-budgets-2026-03-13');
  });

  test('omits anthropic-beta when configured strip values remove all beta values', async () => {
    const receivedHeaders: IncomingHttpHeaders[] = [];
    const upstream = createServer((req, res) => {
      receivedHeaders.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
      stripBetaValues: ['advisor-tool-2026-03-01'],
    });
    servers.push(proxy.server);

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'anthropic-beta': 'advisor-tool-2026-03-01' },
    });

    expect(response.status).toBe(200);
    expect(receivedHeaders).toHaveLength(1);
    expect(receivedHeaders[0]).not.toHaveProperty('anthropic-beta');
  });
});
