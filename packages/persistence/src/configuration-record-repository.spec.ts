import { describe, expect, it } from 'vitest';

import { createSqliteDatabase, migrateSqliteDatabase, withTempDatabasePath } from './sqlite.js';
import { DrizzleConfigurationRecordRepository } from './configuration-record-repository.js';

describe('DrizzleConfigurationRecordRepository', () => {
  it('creates, lists, finds, updates, and deletes configuration records', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repository = new DrizzleConfigurationRecordRepository(database);

      const created = await repository.create({
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: 'default', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }
      });
      expect(created.id).toMatch(/^cfg_/u);
      expect(created.settings).not.toHaveProperty('secretValue');
      expect(created.settings.profileName).toBe('default');
      expect(created.settings.credentialSecretHandle).toBe('sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');

      await expect(repository.findById(created.id)).resolves.toEqual(created);
      const listed = await repository.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(created);

      const updated = await repository.update(created.id, {
        settings: { profileName: 'renamed', credentialSecretHandle: null }
      });
      expect(updated?.settings.profileName).toBe('renamed');
      expect(updated?.settings.credentialSecretHandle).toBeUndefined();
      expect(updated?.createdAt).toBe(created.createdAt);
      expect(updated?.updatedAt).not.toBe(created.updatedAt);

      await expect(repository.delete(created.id)).resolves.toBe(true);
      await expect(repository.findById(created.id)).resolves.toBeNull();
      await expect(repository.delete(created.id)).resolves.toBe(false);

      database.close();
    });
  });

  it('returns null for missing findById and false for missing delete', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repository = new DrizzleConfigurationRecordRepository(database);

      await expect(repository.findById('cfg_missing')).resolves.toBeNull();
      await expect(repository.update('cfg_missing', { providerKind: 'new' })).resolves.toBeNull();
      await expect(repository.delete('cfg_missing')).resolves.toBe(false);

      database.close();
    });
  });
});
