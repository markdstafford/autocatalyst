import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DrizzleProbeResourceRepository,
  checkSqliteDatabaseReachability,
  createSqliteDatabase,
  migrateSqliteDatabase
} from './index.js';

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-persistence-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('sqlite database lifecycle', () => {
  it('opens, migrates, checks reachability, and closes an isolated database', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);

      expect(database.path).toBe(databasePath);
      await expect(checkSqliteDatabaseReachability(database)).resolves.toBe(true);

      database.close();
      await expect(checkSqliteDatabaseReachability(database)).resolves.toBe(false);
    });
  });
});

describe('DrizzleProbeResourceRepository', () => {
  it('creates, reads, returns null for missing ids, and persists across reopen', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const firstDatabase = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(firstDatabase);
      const firstRepository = new DrizzleProbeResourceRepository(firstDatabase);

      const created = await firstRepository.create({ value: 'durable value' });

      expect(created.id).toMatch(/^probe_/u);
      expect(created.value).toBe('durable value');
      expect(() => new Date(created.createdAt).toISOString()).not.toThrow();
      await expect(firstRepository.findById(created.id)).resolves.toEqual(created);
      await expect(firstRepository.findById('missing')).resolves.toBeNull();

      firstDatabase.close();

      const reopenedDatabase = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(reopenedDatabase);
      const reopenedRepository = new DrizzleProbeResourceRepository(reopenedDatabase);

      await expect(reopenedRepository.findById(created.id)).resolves.toEqual(created);
      reopenedDatabase.close();
    });
  });
});
