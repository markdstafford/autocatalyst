import { afterEach, describe, expect, it, vi } from 'vitest';

import { patchPreferences, PREFERENCES_STORAGE_KEY, readPreferenceRecord, readPreferences } from '../theme/preferences.js';
import { ALL_RUNS, createRunViewsStore, normalizeRunViews } from './run-views.js';

const key = PREFERENCES_STORAGE_KEY;
const all = () => normalizeRunViews(undefined).state;
const raw = (runViews: unknown): void => localStorage.setItem(key, JSON.stringify({ runViews, themeMode: 'dark' }));

afterEach(() => vi.restoreAllMocks());

describe('run view normalization', () => {
  it('recovers absent or malformed envelopes and distinguishes unknown versions', () => {
    for (const value of [undefined, null, [], {}, { version: '2' }, { version: 0 }, { version: 1.5 }, { version: 1 }]) {
      expect(normalizeRunViews(value)).toEqual({ state: all(), unsupported: false });
    }
    expect(normalizeRunViews({ version: 2, views: 'unknown' })).toEqual({ state: all(), unsupported: true });
  });

  it('normalizes fields independently and appends a uniquely named built-in', () => {
    const { state } = normalizeRunViews({
      version: 1, activeViewId: 'missing', dismissedDefaultIds: [false, 'other', 'other', '  '],
      views: [
        { id: 'a', name: '  ALL RUNS  ', layout: false, builtIn: {} },
        { id: 'a', name: 'duplicate id' },
        { id: 'b', name: 'All runs (2)', layout: 'table' },
        { name: 'No id' }, { id: 'c', name: '' }, { id: 'd' }, { id: 'e', name: '💡'.repeat(61) }
      ]
    });
    expect(state).toEqual({
      version: 1, activeViewId: 'a', dismissedDefaultIds: ['other'],
      views: [
        { id: 'a', name: 'ALL RUNS', layout: 'table' },
        { id: 'b', name: 'All runs (2)', layout: 'table' },
        { ...ALL_RUNS, name: 'All runs (3)' }
      ]
    });
  });

  it('matches the built-in marker across renames and recovers from an empty dismissed state', () => {
    const renamed = { ...ALL_RUNS, name: 'Everything' };
    expect(normalizeRunViews({ ...all(), views: [renamed], dismissedDefaultIds: {} }).state.views).toEqual([renamed]);
    expect(normalizeRunViews({ ...all(), views: [], dismissedDefaultIds: [ALL_RUNS.builtIn] }).state).toEqual(all());
  });
});

describe('run view commands and persistence', () => {
  it('validates names without writing, writes once per change, and preserves identity and ordering', () => {
    patchPreferences({ bodyFont: 'system', sidebarOpen: false, sidePaneWidthPx: 530, detailPaneVisible: false });
    const store = createRunViewsStore();
    const writes = vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, 'setItem');
    expect(store.create('  ')).toMatch(/enter/i);
    expect(store.create('💡'.repeat(61))).toMatch(/60/);
    expect(store.create(' ALL RUNS ')).toMatch(/already exists/i);
    store.activate(ALL_RUNS.id);
    store.delete(ALL_RUNS.id);
    expect(writes).not.toHaveBeenCalled();

    expect(store.create(` ${'💡'.repeat(60)} `)).toBeUndefined();
    const id = store.getSnapshot().activeViewId;
    expect(id).not.toBe(ALL_RUNS.id);
    expect(store.getSnapshot().views[1]?.name).toBe('💡'.repeat(60));
    expect(store.rename(id, 'all runs')).toMatch(/already exists/i);
    store.rename(id, ' My Review ');
    store.rename(id, ' MY REVIEW ');
    store.rename(id, 'MY REVIEW');
    expect(writes).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().views).toEqual([ALL_RUNS, { id, layout: 'table', name: 'MY REVIEW' }]);
    expect(createRunViewsStore().getSnapshot()).toEqual(store.getSnapshot());
    expect(readPreferences()).toMatchObject({ bodyFont: 'system', sidebarOpen: false, sidePaneWidthPx: 530, detailPaneVisible: false });
  });

  it('deletes inactive and active targets, respects neighbors, and remembers renamed default dismissal', () => {
    const store = createRunViewsStore();
    store.rename(ALL_RUNS.id, 'Everything');
    store.create('Second');
    const second = store.getSnapshot().activeViewId;
    store.create('Third');
    const third = store.getSnapshot().activeViewId;
    store.delete(second);
    expect(store.getSnapshot().activeViewId).toBe(third);
    store.activate(ALL_RUNS.id);
    store.delete(ALL_RUNS.id);
    expect(store.getSnapshot().activeViewId).toBe(third);
    store.delete(third);
    expect(createRunViewsStore().getSnapshot().views.map((view) => view.name)).toEqual(['Third']);

    store.create('Fourth');
    store.delete(store.getSnapshot().activeViewId);
    expect(store.getSnapshot().activeViewId).toBe(third);
  });

  it.each([false, true])('protects unsupported formats until reload (already observed: %s)', (onLoad) => {
    const incompatible = { version: 4, items: [{ future: 3 }] };
    raw(onLoad ? incompatible : all());
    const store = createRunViewsStore();
    if (!onLoad) raw(incompatible);
    expect(store.getSnapshot()).toEqual(all());
    store.create('Temporary');
    const id = store.getSnapshot().activeViewId;
    store.rename(id, 'Temporary review');
    store.activate(ALL_RUNS.id);
    store.delete(ALL_RUNS.id);
    expect(store.getSnapshot().views.map((view) => view.name)).toEqual(['Temporary review']);
    expect(readPreferenceRecord()['runViews']).toEqual(incompatible);
    patchPreferences({ sidebarOpen: false });
    expect(readPreferenceRecord()).toMatchObject({ runViews: incompatible, sidebarOpen: false, themeMode: 'dark' });
    expect(createRunViewsStore().getSnapshot()).toEqual(all());
    raw(all()); // Even if another build restores v1, this tab stays in memory-only mode.
    store.rename(id, 'Still temporary');
    expect(readPreferenceRecord()['runViews']).toEqual(all());
  });

  it.each([all(), false, { version: 2, extra: 'preserve' }])('keeps raw runViews on unrelated patches: %j', (value) => {
    raw(value);
    expect(readPreferences().themeMode).toBe('dark');
    patchPreferences({ monoFont: 'system-mono' });
    expect(readPreferenceRecord()).toEqual({ runViews: value, themeMode: 'dark', monoFont: 'system-mono' });
  });

  it('recovers invalid JSON and aborts a patch if the key cannot be read', () => {
    localStorage.setItem(key, '{invalid');
    expect(createRunViewsStore().getSnapshot()).toEqual(all());
    patchPreferences({ sidebarOpen: false });
    expect(readPreferenceRecord()).toEqual({ sidebarOpen: false });

    const storage = Object.getPrototypeOf(localStorage) as Storage;
    const write = vi.spyOn(storage, 'setItem');
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const store = createRunViewsStore();
    expect(store.getSnapshot()).toEqual(all());
    store.create('Local only');
    expect(store.getSnapshot().views[1]?.name).toBe('Local only');
    expect(write).not.toHaveBeenCalled();
  });

  it('still applies commands in memory on quota or serialization failure', () => {
    const store = createRunViewsStore();
    vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    store.create('Temporary');
    expect(store.getSnapshot().views[1]?.name).toBe('Temporary');
    expect(createRunViewsStore().getSnapshot()).toEqual(all());
    const circular: Record<string, unknown> = {};
    circular['circular'] = circular;
    expect(patchPreferences({ runViews: circular })).toBe('failed');
  });
});
