import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScratchAgentModelMemoryStore } from './scratch-model-memory.js';

const roots: string[] = [];
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'ac-model-memory-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const snapshot = { providerKind: 'openai', adapterId: 'openai-agents-sdk', state: { previousResponseId: 'resp_1' } };

describe('scratch model memory', () => {
  it('persists across store instances and replaces snapshots atomically', async () => {
    const scratchRoot = await scratch();
    const store = createScratchAgentModelMemoryStore({ scratchRoot, key: 'reviewer' });
    expect(await store.load()).toBeNull();
    await store.save(snapshot);
    const nextSession = createScratchAgentModelMemoryStore({ scratchRoot, key: 'reviewer' });
    expect(await nextSession.load()).toEqual(snapshot);
    const updated = { ...snapshot, state: { previousResponseId: 'resp_2' } };
    await nextSession.save(updated);
    expect(await store.load()).toEqual(updated);
    expect(await readdir(scratchRoot)).toHaveLength(1);
  });

  it('hashes arbitrary keys into contained filenames and isolates slots', async () => {
    const scratchRoot = await scratch();
    const first = createScratchAgentModelMemoryStore({ scratchRoot, key: '../../reviewer/secret-profile' });
    const other = createScratchAgentModelMemoryStore({ scratchRoot, key: 'other-provider' });
    await first.save(snapshot);
    expect(await other.load()).toBeNull();
    expect(await readdir(scratchRoot)).toEqual([expect.stringMatching(/^model-memory-[a-f0-9]{64}\.json$/)]);
  });

  it('starts fresh after scratch is recreated', async () => {
    const scratchRoot = await scratch();
    const store = createScratchAgentModelMemoryStore({ scratchRoot, key: 'reviewer' });
    await store.save(snapshot);
    await rm(scratchRoot, { recursive: true });
    await mkdir(scratchRoot);
    expect(await store.load()).toBeNull();
    await store.save(snapshot);
    expect(await store.load()).toEqual(snapshot);
  });

  it.each(['{broken', '{"providerKind":"openai","adapterId":"adapter"}', '{"providerKind":1,"adapterId":"adapter","state":{}}'])('ignores malformed snapshots: %s', async raw => {
    const scratchRoot = await scratch();
    const onWarning = vi.fn();
    const store = createScratchAgentModelMemoryStore({ scratchRoot, key: 'reviewer', onWarning });
    await store.save(snapshot);
    const [filename] = await readdir(scratchRoot);
    await writeFile(join(scratchRoot, filename!), raw);
    expect(await store.load()).toBeNull();
    expect(onWarning).toHaveBeenCalledWith('load');
  });

  it('degrades on read/write failures even if diagnostics throw', async () => {
    const scratchRoot = join(await scratch(), 'not-a-directory');
    await writeFile(scratchRoot, 'sentinel');
    const onWarning = vi.fn(() => { throw new Error('logger failed'); });
    const store = createScratchAgentModelMemoryStore({ scratchRoot, key: 'reviewer', onWarning });
    expect(await store.load()).toBeNull();
    await expect(store.save(snapshot)).resolves.toBeUndefined();
    expect(onWarning.mock.calls).toEqual([['load'], ['save']]);
    expect(await readFile(scratchRoot, 'utf8')).toBe('sentinel');
  });

  it('never exposes a partial JSON file to concurrent readers', async () => {
    const scratchRoot = await scratch();
    const store = createScratchAgentModelMemoryStore({ scratchRoot, key: 'reviewer' });
    await store.save(snapshot);
    const observations = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      await store.save({ ...snapshot, state: { previousResponseId: `resp_${i}`, padding: 'x'.repeat(8192) } });
      return store.load();
    }));
    expect(observations.every(value => value?.providerKind === 'openai')).toBe(true);
    expect(await readdir(scratchRoot)).toHaveLength(1);
  });
});
