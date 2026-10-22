import Database from 'better-sqlite3';
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

  it('adds nullable failure_reason storage to runs', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const internal = asInternalSqliteDatabase(database);

      const columns = internal.client.prepare('PRAGMA table_info(runs)').all() as Array<{
        name: string;
        notnull: number;
        type: string;
      }>;

      const failureReason = columns.find((column) => column.name === 'failure_reason');
      expect(failureReason).toMatchObject({ name: 'failure_reason', notnull: 0 });
      expect(failureReason?.type.toUpperCase()).toBe('TEXT');

      database.close();
    });
  });

  it('adds a non-null sessions.sequence column with a unique (run_id, sequence) index', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const internal = asInternalSqliteDatabase(database);

      const columns = internal.client.prepare('PRAGMA table_info(sessions)').all() as Array<{
        name: string;
        notnull: number;
        type: string;
      }>;
      const sequence = columns.find((column) => column.name === 'sequence');
      expect(sequence).toMatchObject({ name: 'sequence', notnull: 1 });
      expect(sequence?.type.toUpperCase()).toBe('INTEGER');

      const indexes = names(internal.client.prepare("select name from sqlite_master where type = 'index' and name = ?").all(
        'sessions_run_sequence_idx'
      ));
      expect(indexes).toEqual(['sessions_run_sequence_idx']);

      // The (run_id, sequence) index must be unique.
      const indexInfo = internal.client.prepare("PRAGMA index_list(sessions)").all() as Array<{ name: string; unique: number }>;
      const seqIndex = indexInfo.find((entry) => entry.name === 'sessions_run_sequence_idx');
      expect(seqIndex?.unique).toBe(1);

      database.close();
    });
  });

  it('backfills per-run sessions.sequence values for a pre-0010 database', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Simulate a database already migrated through 0009 (sessions without `sequence`).
      // Drizzle applies a migration when lastAppliedTimestamp < migration.folderMillis; the
      // 0010 migration uses folderMillis=1792500000000, so marking everything before it as
      // applied causes only 0010 to run.
      const PRE_0010_TIMESTAMP = 1792499999999;
      const rawDb = new Database(databasePath);
      rawDb.exec(`
        CREATE TABLE runs (
          id text PRIMARY KEY NOT NULL, topic_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, work_kind text NOT NULL, current_step text NOT NULL,
          terminal integer NOT NULL, tracked_issue_json text, testing_guide_result_json text,
          failure_reason text, created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE TABLE sessions (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, phase text,
          step text NOT NULL, role text NOT NULL, round integer NOT NULL,
          model_json text NOT NULL, inference_settings_json text NOT NULL,
          started_at text NOT NULL, ended_at text, duration_ms integer,
          tokens_json text NOT NULL, usage_available integer NOT NULL,
          assistant_turn_count integer NOT NULL, tool_call_count integer NOT NULL,
          outcome text NOT NULL, cost_json text NOT NULL
        );
      `);
      rawDb.exec(`CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, hash text NOT NULL, created_at numeric)`);
      rawDb.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run('pre-0010-fixture', PRE_0010_TIMESTAMP);

      const now = new Date().toISOString();
      const model = JSON.stringify({ provider: 'openai', model: 'gpt-4.1' });
      const inference = JSON.stringify({});
      const tokens = JSON.stringify({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
      const costJson = JSON.stringify({ model: { provider: 'openai', model: 'gpt-4.1' }, usd: null, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
      rawDb.prepare(`INSERT INTO runs (id, topic_id, owner_json, tenant, work_kind, current_step, terminal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run_seq', 'topic_seq', '{}', 'tenant1', 'feature', 'spec.author', 0, now, now);
      const insertSession = rawDb.prepare(`INSERT INTO sessions (id, run_id, phase, step, role, round, model_json, inference_settings_json, started_at, ended_at, duration_ms, tokens_json, usage_available, assistant_turn_count, tool_call_count, outcome, cost_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      // Insert out of started_at order to prove the backfill orders by started_at, not rowid.
      insertSession.run('sess_b', 'run_seq', null, 'implementation.build', 'none', 0, model, inference, '2026-06-08T00:00:02.000Z', null, null, tokens, 1, 1, 0, 'succeeded', costJson);
      insertSession.run('sess_a', 'run_seq', null, 'spec.author', 'none', 0, model, inference, '2026-06-08T00:00:01.000Z', null, null, tokens, 1, 1, 0, 'succeeded', costJson);
      rawDb.close();

      const database = createSqliteDatabase({ path: databasePath });
      try {
        await migrateSqliteDatabase(database);
        const internal = asInternalSqliteDatabase(database);
        const rows = internal.client.prepare('SELECT id, sequence FROM sessions ORDER BY sequence').all() as Array<{ id: string; sequence: number }>;
        expect(rows).toEqual([
          { id: 'sess_a', sequence: 1 },
          { id: 'sess_b', sequence: 2 }
        ]);
      } finally {
        database.close();
      }
    });
  });

  it('upgrades a pre-0004 database with valid domain data without foreign key errors', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Simulate a pre-0004 database: tables without FK constraints, plus a __drizzle_migrations
      // entry that tells Drizzle migrations 0000-0003 are already applied.
      //
      // Drizzle applies a migration when: lastAppliedTimestamp < migration.folderMillis
      // From _journal.json, migration 0004 has folderMillis=1780936276312.
      // Setting created_at=1780935000000 causes Drizzle to skip 0000-0003 and apply only 0004.
      const PRE_0004_TIMESTAMP = 1780935000000;

      const rawDb = new Database(databasePath);

      // Pre-0004 schema: all domain tables from migrations 0002+0003, no FK constraints
      rawDb.exec(`
        CREATE TABLE probe_resources (
          id text PRIMARY KEY NOT NULL, value text NOT NULL, created_at text NOT NULL
        );
        CREATE TABLE configuration_records (
          id text PRIMARY KEY NOT NULL, kind text NOT NULL, provider_kind text NOT NULL,
          adapter_id text NOT NULL, settings_json text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE TABLE secret_store_metadata (
          id text PRIMARY KEY NOT NULL, encryption_version text NOT NULL, kdf_name text NOT NULL,
          kdf_params_json text NOT NULL, kdf_salt text NOT NULL, sentinel_nonce text NOT NULL,
          sentinel_ciphertext text NOT NULL, sentinel_auth_tag text NOT NULL,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE TABLE secrets (
          handle text PRIMARY KEY NOT NULL, ciphertext text NOT NULL, nonce text NOT NULL,
          auth_tag text NOT NULL, encryption_version text NOT NULL, created_at text NOT NULL
        );
        CREATE TABLE projects (
          id text PRIMARY KEY NOT NULL, owner_json text NOT NULL, tenant text NOT NULL,
          display_name text NOT NULL, repo_url text NOT NULL, host_repository_json text NOT NULL,
          workspace_root_override text, issue_tracker_setting_json text,
          code_host_setting_json text, credential_refs_json text NOT NULL,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE TABLE conversations (
          id text PRIMARY KEY NOT NULL, project_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, identity text NOT NULL, channel_json text, active_topic_id text,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE INDEX conversations_project_created_idx ON conversations (project_id, created_at);
        CREATE TABLE topics (
          id text PRIMARY KEY NOT NULL, conversation_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, title text NOT NULL, kind text NOT NULL,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE INDEX topics_conversation_created_idx ON topics (conversation_id, created_at);
        CREATE UNIQUE INDEX topics_one_main_per_conversation ON topics (conversation_id) WHERE topics.kind = 'main';
        CREATE TABLE runs (
          id text PRIMARY KEY NOT NULL, topic_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, work_kind text NOT NULL, current_step text NOT NULL,
          terminal integer NOT NULL, tracked_issue_json text, testing_guide_result_json text,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE INDEX runs_topic_created_idx ON runs (topic_id, created_at);
        CREATE UNIQUE INDEX runs_one_active_per_topic ON runs (topic_id) WHERE runs.terminal = 0;
        CREATE TABLE artifacts (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, kind text NOT NULL, canonical_record text NOT NULL,
          location text NOT NULL, cached_status text NOT NULL, linked_issue_json text,
          publication_refs_json text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE INDEX artifacts_run_created_idx ON artifacts (run_id, created_at);
        CREATE TABLE feedback (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, target text NOT NULL, status text NOT NULL,
          title text NOT NULL, body text NOT NULL, anchor_json text,
          thread_json text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE INDEX feedback_run_status_idx ON feedback (run_id, status);
        CREATE INDEX feedback_run_target_idx ON feedback (run_id, target);
        CREATE TABLE messages (
          id text PRIMARY KEY NOT NULL, topic_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, author_json text NOT NULL, direction text NOT NULL,
          body text NOT NULL, intent text, created_at text NOT NULL
        );
        CREATE INDEX messages_topic_created_idx ON messages (topic_id, created_at);
        CREATE TABLE publications (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, provider text NOT NULL, url text NOT NULL,
          label text NOT NULL, fronted_resource_json text NOT NULL,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE INDEX publications_run_created_idx ON publications (run_id, created_at);
        CREATE TABLE pull_requests (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, owner_json text NOT NULL,
          tenant text NOT NULL, provider text NOT NULL, number integer NOT NULL,
          url text NOT NULL, state text NOT NULL, branch text NOT NULL,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE UNIQUE INDEX pull_requests_one_per_run ON pull_requests (run_id);
        CREATE TABLE run_steps (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, phase text,
          step text NOT NULL, role text NOT NULL, started_at text NOT NULL,
          ended_at text, duration_ms integer, occurrence_json text NOT NULL
        );
        CREATE INDEX run_steps_run_started_idx ON run_steps (run_id, started_at);
        CREATE TABLE sessions (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, phase text,
          step text NOT NULL, role text NOT NULL, round integer NOT NULL,
          model_json text NOT NULL, inference_settings_json text NOT NULL,
          started_at text NOT NULL, ended_at text, duration_ms integer,
          tokens_json text NOT NULL, usage_available integer NOT NULL,
          assistant_turn_count integer NOT NULL, tool_call_count integer NOT NULL,
          outcome text NOT NULL, cost_json text NOT NULL
        );
        CREATE INDEX sessions_run_started_idx ON sessions (run_id, started_at);
        CREATE INDEX sessions_run_step_role_idx ON sessions (run_id, step, role);
        CREATE TABLE test_results (
          id text PRIMARY KEY NOT NULL, run_id text NOT NULL, tester_json text NOT NULL,
          outcome text NOT NULL, evidence_json text, feedback_refs_json text NOT NULL,
          created_at text NOT NULL, updated_at text NOT NULL
        );
        CREATE INDEX test_results_run_created_idx ON test_results (run_id, created_at);
      `);

      // Mark 0000-0003 as applied so Drizzle only runs 0004
      rawDb.exec(`CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, hash text NOT NULL, created_at numeric)`);
      rawDb.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run('pre-0004-fixture', PRE_0004_TIMESTAMP);

      // Insert a valid parent/child chain across the FK hierarchy
      const now = new Date().toISOString();
      rawDb.prepare(`INSERT INTO projects (id, owner_json, tenant, display_name, repo_url, host_repository_json, credential_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('proj_upgrade', '{}', 'tenant1', 'Upgrade Test', 'https://example.com/repo', '{}', '[]', now, now);
      rawDb.prepare(`INSERT INTO conversations (id, project_id, owner_json, tenant, identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('conv_upgrade', 'proj_upgrade', '{}', 'tenant1', 'upgrade-conv', now, now);
      rawDb.prepare(`INSERT INTO topics (id, conversation_id, owner_json, tenant, title, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('topic_upgrade', 'conv_upgrade', '{}', 'tenant1', 'Upgrade Topic', 'main', now, now);
      rawDb.prepare(`INSERT INTO runs (id, topic_id, owner_json, tenant, work_kind, current_step, terminal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run_upgrade', 'topic_upgrade', '{}', 'tenant1', 'feature', 'spec.author', 0, now, now);
      rawDb.prepare(`INSERT INTO artifacts (id, run_id, owner_json, tenant, kind, canonical_record, location, cached_status, publication_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('artifact_upgrade', 'run_upgrade', '{}', 'tenant1', 'patch', 'rec', '/path', 'pending', '[]', now, now);
      rawDb.close();

      // Upgrade through the real API — with the fix this must succeed
      const database = createSqliteDatabase({ path: databasePath });
      try {
        await migrateSqliteDatabase(database);

        const internal = asInternalSqliteDatabase(database);
        expect(internal.client.prepare('SELECT id FROM projects WHERE id = ?').get('proj_upgrade')).toBeDefined();
        expect(internal.client.prepare('SELECT id FROM artifacts WHERE id = ?').get('artifact_upgrade')).toBeDefined();
      } finally {
        database.close();
      }
    });
  });
});
