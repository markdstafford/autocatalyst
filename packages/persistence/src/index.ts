export interface PersistenceScaffold {
  readonly packageName: '@autocatalyst/persistence';
  readonly storageEngine: 'sqlite';
}

export function createPersistenceScaffold(): PersistenceScaffold {
  return {
    packageName: '@autocatalyst/persistence',
    storageEngine: 'sqlite'
  };
}
