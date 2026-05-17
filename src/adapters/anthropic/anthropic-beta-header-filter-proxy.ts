import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface AnthropicBetaHeaderFilterProxy {
  baseUrl: string;
  server: Server;
  close: () => Promise<void>;
}

export interface AnthropicBetaHeaderFilterProxyOptions {
  stripBetaValues: string[];
}

/**
 * Starts a loopback proxy that removes configured beta header values before forwarding requests.
 *
 * @param targetBaseUrl Anthropic-compatible upstream base URL.
 * @param options Beta header values to remove from proxied requests.
 * @returns Proxy handle with a loopback base URL and close function.
 */
export async function startAnthropicBetaHeaderFilterProxy(
  targetBaseUrl: string,
  options: AnthropicBetaHeaderFilterProxyOptions,
): Promise<AnthropicBetaHeaderFilterProxy> {
  const targetBase = new URL(targetBaseUrl);
  const stripBetaValues = normalizedStripBetaValues(options.stripBetaValues);
  const server = createServer((req, res) => {
    handleProxyRequest(req, res, targetBase, stripBetaValues).catch(err => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'proxy_error',
          message: `Failed to proxy Anthropic request: ${String(err)}`,
        },
      }));
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', (err) => {
      server.close();
      reject(new Error(`Anthropic beta header filter proxy failed to bind: ${err.message}`));
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Anthropic beta header filter proxy did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    close: () => closeServer(server),
  };
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetBase: URL,
  stripBetaValues: ReadonlySet<string>,
): Promise<void> {
  const targetUrl = targetUrlForRequest(targetBase, req.url);
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: requestHeaders(req.headers, stripBetaValues),
    body: await requestBody(req),
  });

  res.writeHead(response.status, response.statusText, responseHeaders(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', reject)
      .pipe(res)
      .on('error', reject)
      .on('finish', resolve);
  });
}

function targetUrlForRequest(targetBase: URL, requestUrl: string | undefined): URL {
  const incoming = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  const target = new URL(targetBase.toString());
  const basePath = target.pathname.replace(/\/$/, '');
  target.pathname = `${basePath}${incoming.pathname}`;
  target.search = incoming.search;
  return target;
}

function requestHeaders(headers: IncomingHttpHeaders, stripBetaValues: ReadonlySet<string>): Headers {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lowerName)) continue;
    if (lowerName === 'accept-encoding') {
      forwarded.set('accept-encoding', 'identity');
      continue;
    }
    if (lowerName === 'anthropic-beta') {
      const filtered = filteredAnthropicBetaHeader(value, stripBetaValues);
      if (filtered) forwarded.set(name, filtered);
      continue;
    }
    appendHeaderValues(forwarded, name, value);
  }
  if (!forwarded.has('accept-encoding')) forwarded.set('accept-encoding', 'identity');
  return forwarded;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) {
      forwarded[name] = value;
    }
  });
  return forwarded;
}

function filteredAnthropicBetaHeader(value: string | string[] | undefined, stripBetaValues: ReadonlySet<string>): string | undefined {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const filtered = values
    .flatMap(headerValue => headerValue.split(','))
    .map(beta => beta.trim())
    .filter(beta => beta.length > 0 && !stripBetaValues.has(beta));
  return filtered.length > 0 ? filtered.join(', ') : undefined;
}

function normalizedStripBetaValues(values: string[]): ReadonlySet<string> {
  return new Set(values.map(value => value.trim()).filter(value => value.length > 0));
}

function appendHeaderValues(headers: Headers, name: string, value: string | string[] | undefined): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) headers.append(name, item);
    return;
  }
  headers.set(name, value);
}

async function requestBody(req: IncomingMessage): Promise<ArrayBuffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}
