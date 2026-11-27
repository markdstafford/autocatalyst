/** Browser-local schema, default resolution, and commands for named run views. */
import { useState, useSyncExternalStore } from 'react';

import { patchPreferences, readPreferenceRecord } from '../theme/preferences.js';

export interface RunView {
  readonly id: string;
  readonly name: string;
  readonly builtIn?: string;
  readonly layout: 'table';
}

export interface StoredRunViews {
  readonly version: 1;
  readonly views: readonly [RunView, ...RunView[]];
  readonly activeViewId: string;
  readonly dismissedDefaultIds: readonly string[];
}

type StarterView = RunView & { readonly builtIn: string };
const BUILT_IN_NAMESPACE = 'built-in:';
const MAX_NAME_LENGTH = 60;
const DEFAULTS: readonly [StarterView, ...StarterView[]] = [
  starter('all-runs', 'All runs')
];
export const ALL_RUNS = DEFAULTS[0];

function starter(builtIn: string, name: string): StarterView {
  return { id: BUILT_IN_NAMESPACE + builtIn, builtIn, name, layout: 'table' };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonblank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function versionOf(value: unknown): number | undefined {
  const version = record(value)?.['version'];
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : undefined;
}

function unsupportedVersion(value: unknown): boolean {
  const version = versionOf(value);
  return version !== undefined && version !== 1;
}

function hasName(views: readonly RunView[], name: string, exceptId?: string): boolean {
  return views.some((view) => view.id !== exceptId && view.name.toLowerCase() === name.toLowerCase());
}

function availableDefaultName(views: readonly RunView[], name: string): string {
  let candidate = name;
  for (let n = 2; hasName(views, candidate); n++) {
    const suffix = ` (${n})`;
    candidate = [...name].slice(0, MAX_NAME_LENGTH - suffix.length).join('') + suffix;
  }
  return candidate;
}

export function normalizeRunViews(value: unknown): {
  readonly state: StoredRunViews;
  readonly unsupported: boolean;
} {
  const envelope = record(value);
  const entries: unknown = envelope?.['views'];
  const views: RunView[] = [];
  const ids = new Set<string>();
  let dismissedDefaultIds: string[] = [];
  let activeId: unknown;
  if (versionOf(envelope) === 1 && Array.isArray(entries)) {
    activeId = envelope?.['activeViewId'];
    const dismissals: unknown = envelope?.['dismissedDefaultIds'];
    if (Array.isArray(dismissals)) {
      dismissedDefaultIds = [...new Set(dismissals.map(nonblank).filter((id) => id !== undefined))];
    }
    for (const value of entries as unknown[]) {
      const entry = record(value);
      const id = nonblank(entry?.['id']);
      const name = nonblank(entry?.['name'])?.trim();
      if (id === undefined || name === undefined || [...name].length > MAX_NAME_LENGTH || ids.has(id)) continue;
      const builtIn = nonblank(entry?.['builtIn']);
      views.push({ id, name, layout: 'table', ...(builtIn === undefined ? {} : { builtIn }) });
      ids.add(id);
    }
  }

  for (const entry of DEFAULTS) {
    if (dismissedDefaultIds.includes(entry.builtIn) || views.some((view) => view.builtIn === entry.builtIn)) continue;
    // Corrupt data can use a reserved id without a matching built-in marker.
    let id = entry.id;
    for (let n = 2; ids.has(id); n++) id = `${entry.id}:${n}`;
    views.push({ ...entry, id, name: availableDefaultName(views, entry.name) });
    ids.add(id);
  }
  if (views.length === 0) dismissedDefaultIds = dismissedDefaultIds.filter((id) => id !== ALL_RUNS.builtIn);
  const [first = ALL_RUNS, ...rest] = views;
  return {
    state: {
      version: 1,
      views: [first, ...rest],
      activeViewId: views.find((view) => view.id === activeId)?.id ?? first.id,
      dismissedDefaultIds
    },
    unsupported: unsupportedVersion(value)
  };
}

/** One store per mounted application lifetime. Side effects run in commands, not React updaters. */
export function createRunViewsStore() {
  const initial = normalizeRunViews(readPreferenceRecord()['runViews']);
  let state = initial.state;
  let memoryOnly = initial.unsupported;
  const listeners = new Set<() => void>();

  function commit(next: StoredRunViews): void {
    state = next;
    if (!memoryOnly) {
      memoryOnly = patchPreferences({ runViews: next }, (record) => !unsupportedVersion(record['runViews'])) === 'skipped';
    }
    for (const listener of listeners) listener();
  }

  function validateName(draft: string, exceptId?: string): string | undefined {
    const name = draft.trim();
    if (name.length === 0) return 'Enter a name.';
    if ([...name].length > MAX_NAME_LENGTH) return 'Use 60 characters or fewer.';
    if (hasName(state.views, name, exceptId)) return 'A view with this name already exists.';
    return undefined;
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate(id: string): void {
      if (id !== state.activeViewId && state.views.some((view) => view.id === id)) {
        commit({ ...state, activeViewId: id });
      }
    },
    create(draft: string): string | undefined {
      const error = validateName(draft);
      if (error !== undefined) return error;
      // The control plane can also be served over plain HTTP on a LAN.
      const entropy = crypto.getRandomValues(new Uint32Array(4));
      const id = `custom:${Array.from(entropy, (word) => word.toString(16).padStart(8, '0')).join('')}`;
      commit({ ...state, views: [...state.views, { id, name: draft.trim(), layout: 'table' }], activeViewId: id });
      return undefined;
    },
    rename(id: string, draft: string): string | undefined {
      const index = state.views.findIndex((view) => view.id === id);
      const target = state.views[index];
      if (target === undefined) return undefined;
      const error = validateName(draft, id);
      if (error !== undefined) return error;
      const name = draft.trim();
      if (target.name !== name) {
        const views: [RunView, ...RunView[]] = [...state.views];
        views[index] = { ...target, name };
        commit({ ...state, views });
      }
      return undefined;
    },
    delete(id: string): void {
      const index = state.views.findIndex((view) => view.id === id);
      const target = state.views[index];
      if (target === undefined || state.views.length === 1) return;
      const [first, ...rest] = state.views.filter((view) => view.id !== id);
      if (first === undefined) return;
      commit({
        ...state,
        views: [first, ...rest],
        activeViewId: state.activeViewId === id ? (state.views[index - 1] ?? first).id : state.activeViewId,
        dismissedDefaultIds: target.builtIn === undefined || state.dismissedDefaultIds.includes(target.builtIn)
          ? state.dismissedDefaultIds
          : [...state.dismissedDefaultIds, target.builtIn]
      });
    }
  };
}

export interface RunViewsState extends StoredRunViews {
  readonly activeView: RunView;
  readonly commands: ReturnType<typeof createRunViewsStore>;
}

export function useRunViews(): RunViewsState {
  const [commands] = useState(createRunViewsStore);
  const state = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  return {
    ...state,
    activeView: state.views.find((view) => view.id === state.activeViewId) ?? state.views[0],
    commands
  };
}
