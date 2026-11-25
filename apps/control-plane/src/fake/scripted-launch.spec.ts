import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveFakeStatePaths } from './paths.js';
import { claimLaunchDelay, launchScript } from './scripted-launch.js';
import { scriptedPrelude } from './scripted-results.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('leaves malformed and nonmatching files untouched and grants exactly one matching claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-delay-'));
  roots.push(root);
  const paths = resolveFakeStatePaths(root);
  await mkdir(paths.delaysDir);
  const path = join(paths.delaysDir, 'issue-7.json');
  for (const value of ['null', 'bad json', '{}', '{"step":"work","ms":-1}', '{"step":"work","ms":1.2}',
    '{"step":"work","ms":9007199254740992}', '{"step":"wrong","ms":50}']) {
    await writeFile(path, value);
    expect(await claimLaunchDelay(paths, 7, 'work')).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe(value);
  }
  const valid = '{"step":"work","ms":2000}';
  await writeFile(path, valid);
  expect(await claimLaunchDelay(paths, -7, 'work')).toBeUndefined();
  expect(await claimLaunchDelay(paths, 7, '')).toBeUndefined();
  const claims = await Promise.all([claimLaunchDelay(paths, 7, 'work'), claimLaunchDelay(paths, 7, 'work')]);
  expect(claims.filter(ms => ms === 2000)).toHaveLength(1);
  expect(await claimLaunchDelay(paths, 7, 'work')).toBeUndefined();
  expect(await readFile(path + '.fired', 'utf8')).toBe(valid);
});

it('plays the prelude and waits before returning an injected failure', async () => {
  const controller = new AbortController();
  const events = scriptedPrelude();
  const stream = launchScript({ events, ms: 30, failed: true, signal: controller.signal,
    stillRunning: async () => true })({ prompt: '' })[Symbol.asyncIterator]();
  const started = performance.now();
  for (const event of events) expect(await stream.next()).toEqual({ value: event, done: false });
  await expect(stream.next()).rejects.toThrow('fake-mode scripted failure injected');
  expect(performance.now() - started).toBeGreaterThanOrEqual(30);
});

it('aborts a pending timer when the session closes, without emitting its conclusion', async () => {
  const controller = new AbortController();
  const stream = launchScript({ events: [...scriptedPrelude(), { type: 'result' }], ms: 5_000,
    failed: false, signal: controller.signal, stillRunning: async () => true })({ prompt: '' })[Symbol.asyncIterator]();
  for (let i = 0; i < 3; i += 1) expect((await stream.next()).done).toBe(false);
  const pending = stream.next();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await expect(stream.next()).resolves.toMatchObject({ done: true });
});

it('stops when a delayed run is no longer current', async () => {
  const events = [{ type: 'result' }];
  const stream = launchScript({ events, ms: 10, failed: false, signal: new AbortController().signal,
    stillRunning: async () => false })({ prompt: '' })[Symbol.asyncIterator]();
  await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
});
