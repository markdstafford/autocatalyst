import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type {
  ConfigurationRecord,
  ConfigurationRecordSettings,
  CreateConfigurationRecordRequest,
  UpdateConfigurationRecordRequest
} from '@autocatalyst/api-contract';
import { configurationRecordResponseSchema } from '@autocatalyst/api-contract';

import type { ConfigurationRecordRepository } from '@autocatalyst/core';

import { configurationRecords } from './schema.js';
import { asInternalSqliteDatabase, type SqliteDatabase } from './sqlite.js';

function rowToRecord(row: {
  id: string;
  tenant: string;
  kind: string;
  providerKind: string | null;
  adapterId: string | null;
  settingsJson: string;
  createdAt: string;
  updatedAt: string;
}): ConfigurationRecord {
  const settings = JSON.parse(row.settingsJson) as unknown;
  const candidate: Record<string, unknown> = {
    id: row.id,
    tenant: row.tenant,
    kind: row.kind,
    settings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  if (row.providerKind !== null) {
    candidate['providerKind'] = row.providerKind;
  }
  if (row.adapterId !== null) {
    candidate['adapterId'] = row.adapterId;
  }
  return configurationRecordResponseSchema.parse(candidate);
}

export class DrizzleConfigurationRecordRepository implements ConfigurationRecordRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateConfigurationRecordRequest): Promise<ConfigurationRecord> {
    const now = new Date().toISOString();
    const id = `cfg_${randomUUID()}`;

    const isProviderProfile = input.kind === 'provider_profile';

    this.#database.drizzle.insert(configurationRecords).values({
      id,
      tenant: input.tenant,
      kind: input.kind,
      providerKind: isProviderProfile ? input.providerKind : null,
      adapterId: isProviderProfile ? input.adapterId : null,
      settingsJson: JSON.stringify(input.settings),
      createdAt: now,
      updatedAt: now
    }).run();

    return rowToRecord({
      id,
      tenant: input.tenant,
      kind: input.kind,
      providerKind: isProviderProfile ? input.providerKind : null,
      adapterId: isProviderProfile ? input.adapterId : null,
      settingsJson: JSON.stringify(input.settings),
      createdAt: now,
      updatedAt: now
    });
  }

  async list(tenant: string): Promise<readonly ConfigurationRecord[]> {
    const rows = this.#database.drizzle
      .select()
      .from(configurationRecords)
      .where(eq(configurationRecords.tenant, tenant))
      .all();

    return rows.map(rowToRecord);
  }

  async findById(tenant: string, id: string): Promise<ConfigurationRecord | null> {
    const rows = this.#database.drizzle
      .select()
      .from(configurationRecords)
      .where(and(eq(configurationRecords.tenant, tenant), eq(configurationRecords.id, id)))
      .limit(1)
      .all();

    return rows[0] !== undefined ? rowToRecord(rows[0]) : null;
  }

  async update(tenant: string, id: string, input: UpdateConfigurationRecordRequest): Promise<ConfigurationRecord | null> {
    const existing = await this.findById(tenant, id);
    if (existing === null) {
      return null;
    }

    if (input.kind !== existing.kind) {
      throw new Error(`Cannot update configuration record kind ${existing.kind} with body kind ${input.kind}`);
    }

    if (input.kind === 'provider_profile') {
      // Provider profile update: patch providerKind, adapterId, and settings fields
      const existingProfile = existing as Extract<ConfigurationRecord, { kind: 'provider_profile' }>;
      const updatedProviderKind = input.providerKind ?? existingProfile.providerKind;
      const updatedAdapterId = input.adapterId ?? existingProfile.adapterId;

      let updatedSettings: ConfigurationRecordSettings;
      if (input.settings !== undefined) {
        const merged: Record<string, unknown> = { ...existingProfile.settings };
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
        updatedSettings = existingProfile.settings;
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
        .where(and(eq(configurationRecords.tenant, tenant), eq(configurationRecords.id, id)))
        .run();

      return {
        id: existing.id,
        tenant: existing.tenant,
        kind: 'provider_profile',
        providerKind: updatedProviderKind,
        adapterId: updatedAdapterId,
        settings: updatedSettings,
        createdAt: existing.createdAt,
        updatedAt
      } as ConfigurationRecord;
    }

    // model_routing_table update: replace settings as-is (full routing-table patch semantics in Task 2.2)
    const updatedSettings = input.settings !== undefined
      ? ({ ...existing.settings, ...input.settings } as ConfigurationRecordSettings)
      : existing.settings;

    const updatedAt = new Date().toISOString();

    this.#database.drizzle
      .update(configurationRecords)
      .set({
        settingsJson: JSON.stringify(updatedSettings),
        updatedAt
      })
      .where(and(eq(configurationRecords.tenant, tenant), eq(configurationRecords.id, id)))
      .run();

    return {
      id: existing.id,
      tenant: existing.tenant,
      kind: existing.kind,
      settings: updatedSettings,
      createdAt: existing.createdAt,
      updatedAt
    } as ConfigurationRecord;
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    const existing = await this.findById(tenant, id);
    if (existing === null) {
      return false;
    }

    this.#database.drizzle
      .delete(configurationRecords)
      .where(and(eq(configurationRecords.tenant, tenant), eq(configurationRecords.id, id)))
      .run();

    return true;
  }
}
