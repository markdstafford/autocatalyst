import { describe, expect, it, vi } from 'vitest';

import { SecretStoreLockedError } from '@autocatalyst/core';

import { createSqliteDatabase, migrateSqliteDatabase, withTempDatabasePath, asInternalSqliteDatabase } from './sqlite.js';
import { SecretStoreUnlockError, SqliteSecretStore } from './secret-store.js';

describe('SqliteSecretStore', () => {
  it('rejects createSecret before unlock', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const store = new SqliteSecretStore(database);

      await expect(store.createSecret({ value: 'sk-before-unlock' })).rejects.toThrow(SecretStoreLockedError);

      database.close();
    });
  });

  it('unlocks and creates secret handles in the correct format', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const store = new SqliteSecretStore(database);

      await store.unlock('correct horse battery staple');
      // Second unlock is idempotent
      await store.unlock('correct horse battery staple');

      const created = await store.createSecret({ value: 'sk-live-secret' });
      expect(created.handle).toMatch(/^sec_[A-Za-z0-9_-]{32}$/u);

      // Plaintext must NOT be stored in the secrets table
      const internal = asInternalSqliteDatabase(database);
      const row = internal.client
        .prepare('select ciphertext, nonce, auth_tag from secrets where handle = ?')
        .get(created.handle) as { ciphertext: string; nonce: string; auth_tag: string };

      expect(row).toBeDefined();
      expect(row.ciphertext).not.toContain('sk-live-secret');
      expect(JSON.stringify(row)).not.toContain('sk-live-secret');

      database.close();
    });
  });

  it('rejects unlock with wrong master secret and leaves store locked', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // First, create and unlock store with correct secret
      const firstDatabase = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(firstDatabase);
      const first = new SqliteSecretStore(firstDatabase);
      await first.unlock('right-secret');
      await first.createSecret({ value: 'sk-value' });
      firstDatabase.close();

      // Now open the same DB with wrong secret
      const secondDatabase = createSqliteDatabase({ path: databasePath });
      const second = new SqliteSecretStore(secondDatabase);
      await expect(second.unlock('wrong-secret')).rejects.toThrow(SecretStoreUnlockError);
      await expect(second.createSecret({ value: 'sk-after-fail' })).rejects.toThrow(SecretStoreLockedError);

      secondDatabase.close();
    });
  });

  it('retries handle generation on collision', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);

      // Provide deterministic random bytes to force a collision on first attempt
      const firstBytes = Buffer.alloc(24, 1);
      const secondBytes = Buffer.alloc(24, 2);
      const mockRandomBytes = vi.fn()
        .mockReturnValueOnce(firstBytes)
        .mockReturnValueOnce(firstBytes)   // collision on second create
        .mockReturnValueOnce(secondBytes);

      const store = new SqliteSecretStore(database, { randomBytes: mockRandomBytes });
      await store.unlock('master');

      const handle1 = (await store.createSecret({ value: 'val1' })).handle;
      const handle2 = (await store.createSecret({ value: 'val2' })).handle;
      expect(handle1).not.toBe(handle2);

      database.close();
    });
  });
});
