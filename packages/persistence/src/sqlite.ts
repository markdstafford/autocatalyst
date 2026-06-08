import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export interface SqliteDatabase {
  readonly path: string;
  readonly _brand: 'SqliteDatabase';
  close(): void;
}

export interface InternalSqliteDatabase extends SqliteDatabase {
  readonly client: Database.Database;
  readonly drizzle: ReturnType<typeof drizzle<typeof schema>>;
}

export function createSqliteDatabase(options: { path: string }): SqliteDatabase {
  if (options.path.trim().length === 0) {
    throw new Error('SQLite database path is required.');
  }

  const client = new Database(options.path);
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });

  const internal: InternalSqliteDatabase = {
    path: options.path,
    _brand: 'SqliteDatabase',
    client,
    drizzle: db,
    close() {
      client.close();
    }
  };
  return internal;
}

export function asInternalSqliteDatabase(database: SqliteDatabase): InternalSqliteDatabase {
  const candidate = database as Partial<InternalSqliteDatabase>;
  if (candidate.client === undefined || candidate.drizzle === undefined) {
    throw new Error('Invalid SQLite database handle.');
  }
  return candidate as InternalSqliteDatabase;
}

export async function migrateSqliteDatabase(database: SqliteDatabase): Promise<void> {
  const internal = asInternalSqliteDatabase(database);
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  // PRAGMA foreign_keys changes are no-ops inside a transaction; disable/re-enable outside
  internal.client.pragma('foreign_keys = OFF');
  try {
    migrate(internal.drizzle, { migrationsFolder });
  } finally {
    internal.client.pragma('foreign_keys = ON');
  }
}

export async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-persistence-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkSqliteDatabaseReachability(database: SqliteDatabase): Promise<boolean> {
  try {
    const internal = asInternalSqliteDatabase(database);
    internal.client.prepare('select 1 as reachable').get();
    return true;
  } catch {
    return false;
  }
}
