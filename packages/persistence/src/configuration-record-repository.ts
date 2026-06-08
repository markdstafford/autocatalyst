import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type {
  ConfigurationRecord,
  ConfigurationRecordSettings,
  CreateConfigurationRecordRequest,
  UpdateConfigurationRecordRequest
} from '@autocatalyst/api-contract';

import type { ConfigurationRecordRepository } from '@autocatalyst/core';

import { configurationRecords } from './schema.js';
import { asInternalSqliteDatabase, type SqliteDatabase } from './sqlite.js';

function rowToRecord(row: {
  id: string;
  kind: string;
  providerKind: string;
  adapterId: string;
  settingsJson: string;
  createdAt: string;
  updatedAt: string;
}): ConfigurationRecord {
  const settings = JSON.parse(row.settingsJson) as ConfigurationRecordSettings;
  return {
    id: row.id,
    kind: row.kind as ConfigurationRecord['kind'],
    providerKind: row.providerKind,
    adapterId: row.adapterId,
    settings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export class DrizzleConfigurationRecordRepository implements ConfigurationRecordRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateConfigurationRecordRequest): Promise<ConfigurationRecord> {
    const now = new Date().toISOString();
    const record: ConfigurationRecord = {
      id: `cfg_${randomUUID()}`,
      kind: input.kind,
      providerKind: input.providerKind,
      adapterId: input.adapterId,
      settings: input.settings,
      createdAt: now,
      updatedAt: now
    };

    this.#database.drizzle.insert(configurationRecords).values({
      id: record.id,
      kind: record.kind,
      providerKind: record.providerKind,
      adapterId: record.adapterId,
      settingsJson: JSON.stringify(record.settings),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }).run();

    return record;
  }

  async list(): Promise<readonly ConfigurationRecord[]> {
    const rows = this.#database.drizzle
      .select()
      .from(configurationRecords)
      .all();

    return rows.map(rowToRecord);
  }

  async findById(id: string): Promise<ConfigurationRecord | null> {
    const rows = this.#database.drizzle
      .select()
      .from(configurationRecords)
      .where(eq(configurationRecords.id, id))
      .limit(1)
      .all();

    return rows[0] !== undefined ? rowToRecord(rows[0]) : null;
  }

  async update(id: string, input: UpdateConfigurationRecordRequest): Promise<ConfigurationRecord | null> {
    const existing = await this.findById(id);
    if (existing === null) {
      return null;
    }

    const updatedProviderKind = input.providerKind ?? existing.providerKind;
    const updatedAdapterId = input.adapterId ?? existing.adapterId;

    let updatedSettings: ConfigurationRecordSettings;
    if (input.settings !== undefined) {
      const merged: Record<string, unknown> = { ...existing.settings };
      if (input.settings.profileName !== undefined) {
        merged['profileName'] = input.settings.profileName;
      }
      if ('credentialSecretHandle' in input.settings) {
        if (input.settings.credentialSecretHandle === null) {
          delete merged['credentialSecretHandle'];
        } else if (input.settings.credentialSecretHandle !== undefined) {
          merged['credentialSecretHandle'] = input.settings.credentialSecretHandle;
        }
      }
      updatedSettings = merged as ConfigurationRecordSettings;
    } else {
      updatedSettings = existing.settings;
    }

    const updatedAt = new Date().toISOString();

    this.#database.drizzle
      .update(configurationRecords)
      .set({
        providerKind: updatedProviderKind,
        adapterId: updatedAdapterId,
        settingsJson: JSON.stringify(updatedSettings),
        updatedAt
      })
      .where(eq(configurationRecords.id, id))
      .run();

    return {
      id: existing.id,
      kind: existing.kind,
      providerKind: updatedProviderKind,
      adapterId: updatedAdapterId,
      settings: updatedSettings,
      createdAt: existing.createdAt,
      updatedAt
    };
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (existing === null) {
      return false;
    }

    this.#database.drizzle
      .delete(configurationRecords)
      .where(eq(configurationRecords.id, id))
      .run();

    return true;
  }
}
