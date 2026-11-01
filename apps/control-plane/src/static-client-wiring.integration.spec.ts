import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from './main.js';
import { startControlPlaneServer, type ControlPlaneServerHandle } from './server.js';
import { readControlPlaneAppConfig } from './config.js';

const INDEX_HTML = '<!doctype html><html><head><title>fixture-client</title></head><body>app shell</body></html>';
const HASHED_ASSET = 'export const build = "fixture";';
const HASHED_ASSET_PATH = '/assets/index-Bx3k9aZq.js';

async function buildFixtureClientDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-wiring-client-'));
  await writeFile(join(dir, 'index.html'), INDEX_HTML, 'utf-8');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'index-Bx3k9aZq.js'), HASHED_ASSET, 'utf-8');
  return dir;
}

describe('static client production wiring (fixture directory)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    cleanups.length = 0;
  });

  afterEach(async () => {
    // Run cleanups in reverse registration order even if assertions threw.
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup().catch(() => {});
    }
  });

  it('serves the fixture client and preserves API auth via main() in normal mode', async () => {
    const clientDir = await buildFixtureClientDir();
    cleanups.push(() => rm(clientDir, { recursive: true, force: true }));
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-wiring-db-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));

    const handle = await main(['--port', '0'], {
      CONTROL_PLANE_PORT: '0',
      CONTROL_PLANE_DATABASE_PATH: join(stateDir, 'control-plane.sqlite'),
      CONTROL_PLANE_BEARER_TOKEN: 'wiring-token',
      CONTROL_PLANE_MASTER_SECRET: 'wiring-secret',
      AUTOCATALYST_CLIENT_DIR: clientDir
    });
    cleanups.push(() => handle.close());

    const base = `http://127.0.0.1:${handle.port}`;

    // Static index loads at / with no token.
    const indexRes = await fetch(`${base}/`);
    expect(indexRes.status).toBe(200);
    expect(await indexRes.text()).toBe(INDEX_HTML);
    expect(indexRes.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(indexRes.headers.get('cache-control')).toBe('no-cache');

    // Hashed asset loads with immutable caching.
    const assetRes = await fetch(`${base}${HASHED_ASSET_PATH}`);
    expect(assetRes.status).toBe(200);
    expect(await assetRes.text()).toBe(HASHED_ASSET);
    expect(assetRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // Unauthenticated API call still returns 401.
    const runsRes = await fetch(`${base}/v1/runs`);
    expect(runsRes.status).toBe(401);

    // No CORS header appears even with a foreign Origin.
    const originRes = await fetch(`${base}/`, { headers: { origin: 'https://evil.example' } });
    expect(originRes.status).toBe(200);
    expect(originRes.headers.get('access-control-allow-origin')).toBeNull();
  }, 60_000);

  it('serves the fixture client via main() in fake mode', async () => {
    const clientDir = await buildFixtureClientDir();
    cleanups.push(() => rm(clientDir, { recursive: true, force: true }));
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-wiring-fake-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));

    const handle = await main(['--port', '0', '--fake-mode', '--fake-state-dir', stateDir], {
      AUTOCATALYST_CLIENT_DIR: clientDir
    });
    cleanups.push(() => handle.close());

    const base = `http://127.0.0.1:${handle.port}`;
    const indexRes = await fetch(`${base}/`);
    expect(indexRes.status).toBe(200);
    expect(await indexRes.text()).toBe(INDEX_HTML);

    // Fake-mode bearer token still guards the API.
    const runsRes = await fetch(`${base}/v1/runs`);
    expect(runsRes.status).toBe(401);
  }, 60_000);

  it('serves SPA fallback over HTTP via startControlPlaneServer', async () => {
    const clientDir = await buildFixtureClientDir();
    cleanups.push(() => rm(clientDir, { recursive: true, force: true }));
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-wiring-start-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));

    const config = readControlPlaneAppConfig(['--port', '0'], {
      CONTROL_PLANE_PORT: '0',
      CONTROL_PLANE_DATABASE_PATH: join(stateDir, 'control-plane.sqlite'),
      CONTROL_PLANE_BEARER_TOKEN: 'start-token',
      CONTROL_PLANE_MASTER_SECRET: 'start-secret',
      AUTOCATALYST_CLIENT_DIR: clientDir
    });
    const handle: ControlPlaneServerHandle = await startControlPlaneServer(config);
    cleanups.push(() => handle.close());

    const base = `http://127.0.0.1:${handle.port}`;
    const deepLink = await fetch(`${base}/runs/123`, {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
    });
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toBe(INDEX_HTML);

    // A missing extensioned asset still 404s.
    const missing = await fetch(`${base}/assets/missing-Zz9.js`);
    expect(missing.status).toBe(404);
  }, 60_000);
});
