import { describe, expect, it } from 'vitest';

import { asInternalSqliteDatabase } from '../sqlite.js';
import { createSqliteDatabase, migrateSqliteDatabase, withTempDatabasePath } from '../index.js';

describe('SQLite foreign key enforcement', () => {
  it('rejects a conversation with a non-existent project_id', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      try {
        const internal = asInternalSqliteDatabase(database);
        expect(() => {
          internal.client
            .prepare(
              `INSERT INTO conversations (id, project_id, owner_json, tenant, identity, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              'conv_test',
              'proj_nonexistent',
              '{}',
              'tenant_1',
              'test-identity',
              new Date().toISOString(),
              new Date().toISOString()
            );
        }).toThrow('FOREIGN KEY constraint failed');
      } finally {
        database.close();
      }
    });
  });

  it('rejects a topic with a non-existent conversation_id', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      try {
        const internal = asInternalSqliteDatabase(database);
        expect(() => {
          internal.client
            .prepare(
              `INSERT INTO topics (id, conversation_id, owner_json, tenant, title, kind, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              'topic_test',
              'conv_nonexistent',
              '{}',
              'tenant_1',
              'Test Topic',
              'main',
              new Date().toISOString(),
              new Date().toISOString()
            );
        }).toThrow('FOREIGN KEY constraint failed');
      } finally {
        database.close();
      }
    });
  });

  it('rejects a run with a non-existent topic_id', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      try {
        const internal = asInternalSqliteDatabase(database);
        expect(() => {
          internal.client
            .prepare(
              `INSERT INTO runs (id, topic_id, owner_json, tenant, work_kind, current_step, terminal, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              'run_test',
              'topic_nonexistent',
              '{}',
              'tenant_1',
              'feature',
              'spec.author',
              0,
              new Date().toISOString(),
              new Date().toISOString()
            );
        }).toThrow('FOREIGN KEY constraint failed');
      } finally {
        database.close();
      }
    });
  });

  it('rejects an artifact with a non-existent run_id', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      try {
        const internal = asInternalSqliteDatabase(database);
        expect(() => {
          internal.client
            .prepare(
              `INSERT INTO artifacts (id, run_id, owner_json, tenant, kind, canonical_record, location, cached_status, publication_refs_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              'artifact_test',
              'run_nonexistent',
              '{}',
              'tenant_1',
              'patch',
              'rec',
              '/some/path',
              'pending',
              '[]',
              new Date().toISOString(),
              new Date().toISOString()
            );
        }).toThrow('FOREIGN KEY constraint failed');
      } finally {
        database.close();
      }
    });
  });
});
