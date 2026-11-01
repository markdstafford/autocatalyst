import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStaticClientNotFoundHandler, registerStaticClientRoutes } from './static-client.js';

const INDEX_HTML = '<!doctype html><html><head><title>fixture</title></head><body>app</body></html>';
const HASHED_JS = 'console.log("hashed");';
const UNHASHED_JS = 'console.log("vendor");';

/**
 * Build a fixture client directory with a representative set of files, plus a
 * minimal control-plane-like app: a public `/health` route, one protected-style
 * `/v1/...` route, and (optionally) the static client routes + not-found handler.
 */
async function buildFixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-static-fixture-'));
  await writeFile(join(dir, 'index.html'), INDEX_HTML, 'utf-8');
  await writeFile(join(dir, 'favicon.ico'), 'ICON', 'utf-8');
  await writeFile(join(dir, 'manifest.webmanifest'), '{"name":"fixture"}', 'utf-8');
  await writeFile(join(dir, '.env'), 'SECRET=should-not-serve', 'utf-8');
  const assets = join(dir, 'assets');
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'index-Bx3k9aZq.js'), HASHED_JS, 'utf-8');
  await writeFile(join(assets, 'style.1a2b3c4d.css'), 'body{}', 'utf-8');
  await writeFile(join(assets, 'vendor-chunk.js'), UNHASHED_JS, 'utf-8');
  const nested = join(assets, 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'index.html'), '<p>nested</p>', 'utf-8');
  return dir;
}

function buildApp(clientDirectory: string | undefined): FastifyInstance {
  const app = Fastify();
  app.get('/health', async () => ({ status: 'ok' }));
  app.register(async (protectedApp) => {
    protectedApp.get('/v1/runs', async () => ({ runs: [] }));
  });
  if (clientDirectory !== undefined) {
    registerStaticClientRoutes(app, { clientDirectory });
    app.setNotFoundHandler(createStaticClientNotFoundHandler({ clientDirectory }));
  }
  return app;
}

describe('static-client handler', () => {
  let clientDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    clientDir = await buildFixtureDir();
    app = buildApp(clientDir);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(clientDir, { recursive: true, force: true });
  });

  describe('serving root and assets', () => {
    it('serves index.html at / with no-cache, nosniff, and html content type', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX_HTML);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('serves /index.html with no-cache', async () => {
      const res = await app.inject({ method: 'GET', url: '/index.html' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('serves a Vite-style hashed asset with immutable caching', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/index-Bx3k9aZq.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(HASHED_JS);
      expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('serves a dot-hashed asset with immutable caching', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/style.1a2b3c4d.css' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('serves an unhashed lookalike asset with no-cache', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/vendor-chunk.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(UNHASHED_JS);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('serves favicon and manifest with no-cache and correct content types', async () => {
      const favicon = await app.inject({ method: 'GET', url: '/favicon.ico' });
      expect(favicon.statusCode).toBe(200);
      expect(favicon.headers['content-type']).toBe('image/x-icon');
      expect(favicon.headers['cache-control']).toBe('no-cache');

      const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
      expect(manifest.headers['cache-control']).toBe('no-cache');
    });

    it('serves a nested index.html as an ordinary file with no-cache', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/nested/index.html' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('<p>nested</p>');
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('ignores query strings when resolving files', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/index-Bx3k9aZq.js?v=1' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(HASHED_JS);
    });
  });

  describe('SPA fallback', () => {
    const htmlAccept = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

    it('returns index.html for /runs with an explicit text/html Accept', async () => {
      const res = await app.inject({ method: 'GET', url: '/runs', headers: htmlAccept });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX_HTML);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    });

    it('returns index.html for a deep extensionless route', async () => {
      const res = await app.inject({ method: 'GET', url: '/runs/123/detail', headers: htmlAccept });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX_HTML);
    });

    it('does not fall back when Accept is */* only', async () => {
      const res = await app.inject({ method: 'GET', url: '/runs', headers: { accept: '*/*' } });
      expect(res.statusCode).toBe(404);
    });

    it('does not fall back for a missing extensioned asset with text/html Accept', async () => {
      const res = await app.inject({ method: 'GET', url: '/missing.js', headers: htmlAccept });
      expect(res.statusCode).toBe(404);
    });

    it('does not fall back for a missing extensioned asset with */* Accept', async () => {
      const res = await app.inject({ method: 'GET', url: '/missing.js', headers: { accept: '*/*' } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('containment and blocked paths', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['encoded traversal', '/%2e%2e/%2e%2e/etc/passwd'],
      ['double-encoded traversal', '/%252e%252e/secret'],
      ['dotfile', '/.env'],
      ['directory request', '/assets/'],
      ['empty nested segment', '/assets//index-Bx3k9aZq.js']
    ];

    for (const [name, url] of cases) {
      it(`returns 404 for ${name}`, async () => {
        const res = await app.inject({ method: 'GET', url, headers: { accept: '*/*' } });
        expect(res.statusCode).toBe(404);
      });
    }

    it('returns 404 for a backslash path', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets%5Csecret', headers: { accept: '*/*' } });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for a NUL byte path', async () => {
      const res = await app.inject({ method: 'GET', url: '/index.html%00.js', headers: { accept: '*/*' } });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for a dotfile even when Accept includes text/html', async () => {
      const res = await app.inject({ method: 'GET', url: '/.env', headers: { accept: 'text/html,*/*' } });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('SECRET=should-not-serve');
    });

    it('returns 404 for a symlink whose target escapes the client directory', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'));
      try {
        await writeFile(join(outside, 'secret.txt'), 'outside-secret', 'utf-8');
        await symlink(join(outside, 'secret.txt'), join(clientDir, 'assets', 'escape.txt'));
        const res = await app.inject({ method: 'GET', url: '/assets/escape.txt', headers: { accept: '*/*' } });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('outside-secret');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('HEAD and method handling', () => {
    it('keeps default 404 for HEAD /', async () => {
      const res = await app.inject({ method: 'HEAD', url: '/' });
      expect(res.statusCode).toBe(404);
    });

    it('keeps default 404 for HEAD of an existing asset', async () => {
      const res = await app.inject({ method: 'HEAD', url: '/assets/index-Bx3k9aZq.js' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('precedence and default 404 preservation', () => {
    it('keeps /health and /v1 routes working', async () => {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      const runs = await app.inject({ method: 'GET', url: '/v1/runs' });
      expect(runs.statusCode).toBe(200);
    });

    it('preserves Fastify default 404 byte-for-byte for unknown API/non-GET routes', async () => {
      const baseline = buildApp(undefined);
      await baseline.ready();
      try {
        const probes: ReadonlyArray<{ method: 'GET' | 'POST'; url: string }> = [
          { method: 'GET', url: '/v1/unknown' },
          { method: 'POST', url: '/anything' },
          { method: 'GET', url: '/health/extra' }
        ];
        for (const probe of probes) {
          const withoutStatic = await baseline.inject(probe);
          const withStatic = await app.inject(probe);
          expect(withStatic.statusCode).toBe(withoutStatic.statusCode);
          expect(withStatic.body).toBe(withoutStatic.body);
          expect(withStatic.headers['content-type']).toBe(withoutStatic.headers['content-type']);
        }
      } finally {
        await baseline.close();
      }
    });
  });
});
