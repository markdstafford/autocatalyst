import { describe, expect, it } from 'vitest';

import { asInternalSqliteDatabase, createSqliteDatabase, migrateSqliteDatabase, withTempDatabasePath } from '../sqlite.js';

function names(rows: unknown[]): string[] {
  return rows.map((row) => (row as { name: string }).name).sort();
}

describe('domain schema migrations', () => {
  it('creates all domain tables and key uniqueness indexes in a fresh database', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const internal = asInternalSqliteDatabase(database);

      const tables = names(internal.client.prepare("select name from sqlite_master where type = 'table' and name in (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").all(
        'projects', 'conversations', 'topics', 'messages', 'runs', 'artifacts', 'feedback', 'publications', 'pull_requests', 'run_steps', 'sessions', 'test_results'
      ));
      expect(tables).toEqual(['artifacts', 'conversations', 'feedback', 'messages', 'projects', 'publications', 'pull_requests', 'run_steps', 'runs', 'sessions', 'test_results', 'topics']);

      const indexes = names(internal.client.prepare("select name from sqlite_master where type = 'index' and name in (?, ?, ?)").all(
        'runs_one_active_per_topic', 'topics_one_main_per_conversation', 'pull_requests_one_per_run'
      ));
      expect(indexes).toEqual(['pull_requests_one_per_run', 'runs_one_active_per_topic', 'topics_one_main_per_conversation']);

      database.close();
    });
  });
});
