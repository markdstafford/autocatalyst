import type { Project } from '@autocatalyst/api-contract';
import type { ControlPlaneClient } from '@autocatalyst/sdk';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { hasBearerToken } from '../auth/token-store.js';
import { useControlPlaneClient } from '../client/client-provider.js';

interface Snapshot {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly projects: readonly Project[];
}

/** One directory per active SDK client. A write supersedes any read already in flight. */
export function createProjectDirectory(client: Pick<ControlPlaneClient, 'listProjects'>) {
  let snapshot: Snapshot = { phase: 'loading', projects: [] };
  const listeners = new Set<() => void>();
  const lookedUp = new Set<string>();
  const queuedLookups = new Set<string>();
  const published = new Map<string, Project>();
  let revision = 0;
  let pending = false;
  let active = true;

  function update(next: Snapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  const knows = (id: string): boolean => snapshot.projects.some((project) => project.id === id);

  async function refresh(): Promise<void> {
    if (!active || pending) return;
    pending = true;
    queuedLookups.clear();
    const read = ++revision;
    try {
      const { projects } = await client.listProjects();
      if (!active || read !== revision) return;
      const records = new Map(projects.map((project) => [project.id, project]));
      for (const [id, saved] of published) {
        const record = records.get(id);
        if (record === undefined || record.updatedAt < saved.updatedAt) {
          records.set(id, saved);
        } else {
          published.delete(id);
        }
      }
      update({ phase: 'ready', projects: [...records.values()] });
    } catch {
      if (active && read === revision && snapshot.phase !== 'ready') {
        update({ phase: 'error', projects: snapshot.projects });
      }
    } finally {
      if (read === revision) {
        pending = false;
        // An ID discovered during the read may not have existed when it began.
        // Give such IDs one follow-up if still unknown, not one request per poll.
        if ([...queuedLookups].some((id) => !knows(id))) void refresh();
        queuedLookups.clear();
      }
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    setActive(next: boolean): void { active = next; },
    start(): void {
      if (snapshot.phase === 'loading') void refresh();
    },
    refresh,
    lookup(ids: readonly string[]): void {
      for (const id of ids) {
        if (!lookedUp.has(id) && !knows(id)) {
          lookedUp.add(id);
          queuedLookups.add(id);
        }
      }
      if (queuedLookups.size > 0) void refresh();
    },
    publish(project: Project): void {
      if (!active) return;
      revision++;
      pending = false;
      published.set(project.id, project);
      const records = new Map(snapshot.projects.map((record) => [record.id, record]));
      records.set(project.id, project);
      update({ phase: 'ready', projects: [...records.values()] });
      void refresh();
    }
  };
}

type Directory = ReturnType<typeof createProjectDirectory>;
const DirectoryContext = createContext<Directory | undefined>(undefined);

export function ProjectDirectoryProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const client = useControlPlaneClient();
  const connected = hasBearerToken();
  const directory = useMemo(() => createProjectDirectory(client), [client]);
  useLayoutEffect(() => {
    directory.setActive(true);
    return () => directory.setActive(false);
  }, [directory]);
  useEffect(() => {
    if (connected) directory.start();
  }, [connected, directory]);
  return <DirectoryContext.Provider value={directory}>{children}</DirectoryContext.Provider>;
}

export function useProjectDirectory(): Snapshot & Pick<Directory, 'publish' | 'lookup' | 'refresh'> {
  const directory = useContext(DirectoryContext);
  if (directory === undefined) throw new Error('ProjectDirectoryProvider is required.');
  const snapshot = useSyncExternalStore(directory.subscribe, directory.getSnapshot);
  return { ...snapshot, publish: directory.publish, lookup: directory.lookup, refresh: directory.refresh };
}
