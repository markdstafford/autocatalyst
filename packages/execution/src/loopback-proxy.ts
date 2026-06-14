import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import type { RunnerEndpointSettings } from '@autocatalyst/api-contract';
import type { AgentConnectionTelemetryContext } from './agent-provider-adapter.js';
import { applyProxyHeaderPolicy, mapLoopbackUrlToUpstream, type HeaderValueFilter } from './proxy-header-policy.js';
import type { ProxyRequestLoggingOptions } from './proxy-request-logging.js';
import type { ProviderConnectionLogger } from './connection.js';

export type ProxyFailureCode =
  | 'proxy_start_failed'
  | 'proxy_upstream_failed'
  | 'proxy_invalid_upstream'
  | 'proxy_logging_disabled'
  | 'proxy_request_malformed'
  | 'unsupported_required_capability';

export interface SafeProxyErrorEnvelope {
  readonly error: { readonly code: ProxyFailureCode; readonly message: string };
}

export interface LoopbackProxyOptions {
  readonly upstreamBaseUrl: string;
  readonly endpoint: RunnerEndpointSettings;
  readonly credential?: string;
  readonly headerValueFilters?: readonly HeaderValueFilter[];
  readonly telemetryContext: AgentConnectionTelemetryContext;
  readonly requestTimeoutMs?: number;
  readonly logging?: ProxyRequestLoggingOptions;
  readonly logger?: ProviderConnectionLogger;
}

export interface LoopbackProxyHandle {
  readonly baseUrl: string;
  readonly startedAt: string;
  requestCount(): number;
  close(): Promise<void>;
}

const hopByHopResponseHeaders = new Set([
  'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function sendJsonError(res: http.ServerResponse, status: number, envelope: SafeProxyErrorEnvelope): void {
  if (res.headersSent) return;
  const body = JSON.stringify(envelope);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export async function createLoopbackProxy(options: LoopbackProxyOptions): Promise<LoopbackProxyHandle> {
  const { upstreamBaseUrl, endpoint, credential, headerValueFilters } = options;

  // Validate upstream URL eagerly
  new URL(upstreamBaseUrl);

  let requestCounter = 0;
  let closed = false;

  const server = http.createServer((req, res) => {
    requestCounter += 1;

    // Map loopback URL to upstream
    const absoluteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url ?? '/'}`;
    let upstreamUrl: URL;
    try {
      upstreamUrl = mapLoopbackUrlToUpstream(absoluteUrl, upstreamBaseUrl);
    } catch {
      sendJsonError(res, 400, { error: { code: 'proxy_request_malformed', message: 'Proxy received a malformed request.' } });
      return;
    }

    // Build forwarded headers
    const { headers: forwardHeaders } = applyProxyHeaderPolicy({
      headers: req.headers as Record<string, string | string[] | undefined>,
      endpoint,
      credential,
      headerValueFilters,
      forceIdentityAcceptEncoding: options.logging?.enabled === true
    });

    const isHttps = upstreamUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    const upstreamReq = requestModule.request(
      upstreamUrl,
      {
        method: req.method,
        headers: forwardHeaders
      },
      (upstreamRes) => {
        // Strip hop-by-hop headers from upstream response
        const safeHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!hopByHopResponseHeaders.has(name.toLowerCase()) && value !== undefined) {
            safeHeaders[name] = value;
          }
        }

        res.writeHead(upstreamRes.statusCode ?? 200, safeHeaders);

        // Stream chunks with backpressure
        upstreamRes.on('data', (chunk: Buffer) => {
          const ok = res.write(chunk);
          if (!ok) {
            upstreamRes.pause();
            res.once('drain', () => upstreamRes.resume());
          }
        });

        upstreamRes.on('end', () => res.end());
      }
    );

    if (options.requestTimeoutMs) {
      upstreamReq.setTimeout(options.requestTimeoutMs, () => {
        upstreamReq.destroy();
      });
    }

    upstreamReq.on('error', () => {
      sendJsonError(res, 502, { error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' } });
    });

    // Destroy upstream if client disconnects
    res.on('close', () => upstreamReq.destroy());

    // Pipe request body to upstream
    req.pipe(upstreamReq);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const startedAt = new Date().toISOString();

  return {
    baseUrl,
    startedAt,
    requestCount: () => requestCounter,
    close: async () => {
      if (closed) return;
      closed = true;
      server.close();
      await once(server, 'close');
    }
  };
}
