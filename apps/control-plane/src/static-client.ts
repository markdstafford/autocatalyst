import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * In-repo static client handler for the control plane.
 *
 * This feature serves a built web client from the same HTTP origin as the API,
 * using a small constrained handler rather than a static-file plugin so every
 * security rule (path containment, dotfile/symlink/directory rejection, cache
 * policy, SPA fallback, and default-404 preservation) is explicit and tested.
 *
 * It deliberately supports only `GET`. `HEAD` requests fall through to the
 * server's not-found handling (Fastify's default 404), matching the spec.
 */

export interface StaticClientOptions {
  readonly clientDirectory: string;
}

const ROOT_INDEX_PATH = '/index.html';
const INDEX_HTML = 'index.html';

const NO_CACHE = 'no-cache';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NOSNIFF = 'nosniff';

/** Content types for common built-client assets. Unknown extensions fall back to octet-stream. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

function contentTypeForPath(logicalPath: string): string {
  const ext = extname(logicalPath).toLowerCase();
  return CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}

/** True for `/health`, `/health/...`, `/v1`, and `/v1/...` — these keep API/default behavior. */
function isReservedApiPath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname.startsWith('/health/') ||
    pathname === '/v1' ||
    pathname.startsWith('/v1/')
  );
}

/** Strip the query string from a raw request URL, returning only the path portion. */
function pathnameOf(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf('?');
  const hashIndex = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (queryIndex >= 0) end = Math.min(end, queryIndex);
  if (hashIndex >= 0) end = Math.min(end, hashIndex);
  return rawUrl.slice(0, end);
}

/**
 * Decode a request path exactly once and reject unsafe inputs. Returns the decoded
 * absolute-style path (always starting with `/`) or `undefined` when the request
 * must be rejected (malformed encoding, NUL byte, backslash, dotfile segment,
 * directory request, or traversal).
 */
function decodeSafePathname(rawUrl: string): string | undefined {
  const encoded = pathnameOf(rawUrl);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined; // malformed percent-encoding
  }
  if (decoded.length === 0 || !decoded.startsWith('/')) {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return undefined;
  }
  // Directory requests (trailing slash) are not served; the root `/` is handled separately.
  if (decoded.endsWith('/')) {
    return undefined;
  }
  const segments = decoded.split('/').slice(1); // drop leading empty segment
  for (const segment of segments) {
    if (segment.length === 0) {
      return undefined; // empty segment (e.g. //)
    }
    if (segment.startsWith('.')) {
      return undefined; // dotfile or traversal segment (., .., .env)
    }
  }
  return decoded;
}

/**
 * A hashed asset is a file under `/assets/` whose basename has a final
 * dash- or dot-separated segment (before the extension) of at least 8 characters
 * drawn from `[A-Za-z0-9_-]`. Examples: `index-Bx3k9aZq.js`, `style.1a2b3c4d.css`.
 * Unhashed lookalikes such as `vendor-chunk.js` are not hashed.
 */
function isHashedAsset(logicalPath: string): boolean {
  if (!logicalPath.startsWith('/assets/')) {
    return false;
  }
  const base = logicalPath.slice(logicalPath.lastIndexOf('/') + 1);
  const ext = extname(base);
  if (ext.length === 0) {
    return false;
  }
  const stem = base.slice(0, base.length - ext.length);
  const parts = stem.split(/[-.]/u);
  if (parts.length < 2) {
    return false;
  }
  const last = parts[parts.length - 1] ?? '';
  return last.length >= 8 && /^[A-Za-z0-9_-]+$/u.test(last);
}

function isIndexHtmlPath(logicalPath: string): boolean {
  return logicalPath === ROOT_INDEX_PATH || logicalPath.endsWith(`/${INDEX_HTML}`);
}

function cacheControlFor(logicalPath: string): string {
  if (isIndexHtmlPath(logicalPath)) {
    return NO_CACHE;
  }
  if (isHashedAsset(logicalPath)) {
    return IMMUTABLE_CACHE;
  }
  return NO_CACHE;
}

async function sendFile(
  reply: FastifyReply,
  absolutePath: string,
  logicalPath: string
): Promise<void> {
  const body = await readFile(absolutePath);
  reply
    .header('x-content-type-options', NOSNIFF)
    .header('cache-control', cacheControlFor(logicalPath))
    .type(contentTypeForPath(logicalPath))
    .send(body);
}

/** Serve the configured root `index.html` with no-cache and nosniff. */
async function sendIndexHtml(reply: FastifyReply, clientDirectory: string): Promise<void> {
  const indexPath = join(clientDirectory, INDEX_HTML);
  await sendFile(reply, indexPath, ROOT_INDEX_PATH);
}

/**
 * Resolve a decoded request path to a real file inside the client directory.
 * Returns the absolute real path to read, or `undefined` when the file does not
 * exist, is not a regular file, or escapes the client directory via symlink or
 * lexical traversal.
 */
async function resolveContainedFile(
  clientDirectory: string,
  decodedPath: string
): Promise<string | undefined> {
  const candidate = resolve(clientDirectory, `.${decodedPath}`);
  const lexicalRel = relative(clientDirectory, candidate);
  if (lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) {
    return undefined;
  }

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(clientDirectory);
    realFile = await realpath(candidate);
  } catch {
    return undefined; // missing file or broken symlink
  }
  const realRel = relative(realRoot, realFile);
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    return undefined; // symlink target escapes the client directory
  }

  try {
    const stats = await stat(realFile);
    if (!stats.isFile()) {
      return undefined; // directories and special files are not served
    }
  } catch {
    return undefined;
  }
  return realFile;
}

/**
 * Determine whether a request is eligible for SPA fallback to `index.html`.
 * All must hold: method is GET; the path is not reserved for the API/health
 * routes; the `Accept` header explicitly names `text/html` (a wildcard-only
 * Accept is not enough); the path decodes cleanly with no dotfile segment; and
 * the final segment has no file extension.
 */
function isSpaFallbackEligible(request: FastifyRequest): boolean {
  if (request.method !== 'GET') {
    return false;
  }
  const decoded = decodeSafePathname(request.url);
  if (decoded === undefined) {
    return false;
  }
  if (isReservedApiPath(decoded)) {
    return false;
  }
  const accept = request.headers.accept;
  if (typeof accept !== 'string' || !accept.split(',').some((part) => part.trim().toLowerCase().startsWith('text/html'))) {
    return false;
  }
  const base = decoded.slice(decoded.lastIndexOf('/') + 1);
  return extname(base).length === 0;
}

/** Reproduce Fastify's default not-found response byte-for-byte. */
async function sendDefaultNotFound(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply
    .status(404)
    .type('application/json; charset=utf-8')
    .send(
      `{"message":"Route ${request.method}:${request.url} not found","error":"Not Found","statusCode":404}`
    );
}

/**
 * Build the server-level not-found handler for static-client serving. Serves the
 * SPA shell (`index.html`) for eligible extensionless HTML `GET` routes, and
 * otherwise reproduces Fastify's default 404 so API, health, extensioned-asset,
 * and non-GET misses keep today's exact status and body.
 */
export function createStaticClientNotFoundHandler(
  options: StaticClientOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { clientDirectory } = options;
  return async (request, reply) => {
    if (isSpaFallbackEligible(request)) {
      await sendIndexHtml(reply, clientDirectory);
      return;
    }
    await sendDefaultNotFound(request, reply);
  };
}

/**
 * Register `GET /` and `GET /*` static routes against the validated client
 * directory. Real files are served here; everything else (SPA fallback and
 * default-404 preservation) is deferred to the server-level not-found handler
 * via `reply.callNotFound()`.
 */
export function registerStaticClientRoutes(app: FastifyInstance, options: StaticClientOptions): void {
  const { clientDirectory } = options;

  app.get('/', async (request, reply) => {
    if (request.method === 'HEAD') {
      return reply.callNotFound();
    }
    await sendIndexHtml(reply, clientDirectory);
  });

  app.get('/*', async (request, reply) => {
    if (request.method === 'HEAD') {
      return reply.callNotFound();
    }
    const decoded = decodeSafePathname(request.url);
    if (decoded === undefined) {
      // Malformed, dotfile, directory, backslash, NUL, or traversal → default 404.
      return reply.callNotFound();
    }
    if (isReservedApiPath(decoded)) {
      // Unknown /v1 and /health paths keep Fastify's default behavior.
      return reply.callNotFound();
    }
    const realFile = await resolveContainedFile(clientDirectory, decoded);
    if (realFile === undefined) {
      return reply.callNotFound();
    }
    await sendFile(reply, realFile, decoded);
  });
}
