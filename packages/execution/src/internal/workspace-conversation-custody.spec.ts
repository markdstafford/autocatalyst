import { describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireNativeHistoryLease, createPrivateConversationScope, releaseNativeHistoryLease, type WorkspaceConversationWriter
} from './workspace-conversation-custody.js';

const writer: WorkspaceConversationWriter = {
  version: 1, tenant: 'tenant', runId: 'run_1', generation: 'generation_1',
  writerIdentity: 'native_1', descendantGroup: 'local_group_1'
};

async function withScope(
  work: (paths: { home: string; scope: string; root: string }) => Promise<void>
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-history-lease-')));
  try {
    const home = join(root, 'provider-home');
    const run = join(root, writer.runId);
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(run, { mode: 0o700 })]);
    const { scope } = await createPrivateConversationScope(run, writer);
    await work({ home, scope, root });
  } finally { await rm(root, { force: true, recursive: true }); }
}

describe('native history lease', () => {
  it.each([
    { provider: 'codex', paths: ['sessions', 'archived_sessions'] },
    { provider: 'claude', paths: ['projects'] }
  ] as const)('routes $provider history without moving its login', async ({ provider, paths }) => {
    await withScope(async ({ home, scope }) => {
      const signIn = join(home, 'fixture-auth');
      await writeFile(signIn, 'authentication stays here', { mode: 0o600 });
      const lease = await acquireNativeHistoryLease({ home, scope, provider, writer });
      expect(await lease?.verify()).toBe(true);
      for (const name of paths) expect(await readlink(join(home, name))).toBe(join(scope, name));

      const member = paths[0];
      await writeFile(join(home, member, 'round.jsonl'), 'synthetic history', { mode: 0o600 });
      expect(await acquireNativeHistoryLease({ home, scope, provider, writer })).toBeUndefined();
      expect(await releaseNativeHistoryLease({ home, writerExited: async () => false })).toBe(false);
      expect(await lease?.verify()).toBe(true);

      const writerExited = vi.fn(async () => true);
      expect(await releaseNativeHistoryLease({ home, writerExited })).toBe(true);
      expect(writerExited).toHaveBeenCalledExactlyOnceWith(writer);
      for (const name of paths) await expect(lstat(join(home, name))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(signIn, 'utf8')).toBe('authentication stays here');
      expect(await readFile(join(scope, member, 'round.jsonl'), 'utf8')).toBe('synthetic history');

      const nextWriter = { ...writer, writerIdentity: 'native_2' };
      expect(await acquireNativeHistoryLease({ home, scope, provider, writer: nextWriter })).toBeUndefined();
      const previousWriterExited = vi.fn(async () => true);
      const next = await acquireNativeHistoryLease({ home, scope, provider, writer: nextWriter, previousWriterExited });
      expect(await next?.verify()).toBe(true);
      expect(previousWriterExited).toHaveBeenCalledExactlyOnceWith(writer);
      expect(JSON.parse(await readFile(join(scope, 'owner.json'), 'utf8'))).toEqual(nextWriter);
      expect(await lease?.verify()).toBe(false);
    });
  });

  it('finishes a release interrupted after an earlier link was removed', async () => {
    await withScope(async ({ home, scope }) => {
      expect(await acquireNativeHistoryLease({ home, scope, provider: 'codex', writer })).toBeDefined();
      await rename(join(home, '.autocatalyst-history-lease'), join(home, '.autocatalyst-history-retiring'));
      await unlink(join(home, 'sessions'));
      expect(await acquireNativeHistoryLease({ home, scope, provider: 'codex', writer })).toBeUndefined();
      expect(await releaseNativeHistoryLease({ home, writerExited: async () => true })).toBe(true);
      expect(await acquireNativeHistoryLease({ home, scope, provider: 'codex', writer })).toBeDefined();
    });
  });

  it('refuses to use history owned by a different workspace generation', async () => {
    await withScope(async ({ home, scope }) => {
      expect(await acquireNativeHistoryLease({
        home, scope, provider: 'claude', writer: { ...writer, generation: 'replacement' }
      })).toBeUndefined();
      await expect(lstat(join(home, '.autocatalyst-history-lease'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('refuses a normal history directory and never unlinks a replaced link', async () => {
    await withScope(async ({ home, scope, root }) => {
      const anchor = join(home, 'projects');
      await mkdir(anchor);
      expect(await acquireNativeHistoryLease({ home, scope, provider: 'claude', writer })).toBeUndefined();
      expect((await lstat(anchor)).isDirectory()).toBe(true);

      const second = join(root, 'second-home');
      await mkdir(second, { mode: 0o700 });
      const lease = await acquireNativeHistoryLease({ home: second, scope, provider: 'claude', writer });
      expect(await lease?.verify()).toBe(true);
      await unlink(join(second, 'projects'));
      await symlink(anchor, join(second, 'projects'));
      expect(await lease?.verify()).toBe(false);
      expect(await releaseNativeHistoryLease({ home: second, writerExited: async () => true })).toBe(false);
      expect(await readlink(join(second, 'projects'))).toBe(anchor);
    });
  });
});
