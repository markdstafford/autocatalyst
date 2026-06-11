import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type {
  ConfigurationRecord,
  ConfigurationRecordSettings,
  CreateConfigurationRecordRequest,
  ModelRoutingTableSettings,
  UpdateConfigurationRecordRequest,
  UpdateModelRoutingTableSettings
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

function applyRoutingTableSettingsPatch(
  existing: ModelRoutingTableSettings,
  patch: UpdateModelRoutingTableSettings
): ModelRoutingTableSettings {
  const result: Record<string, unknown> = { active: existing.active };

  // active: set if provided
  if (patch.active !== undefined) {
    result['active'] = patch.active;
  }

  // tableName: null = clear, string = set, undefined = keep
  if (patch.tableName !== undefined) {
    if (patch.tableName !== null) result['tableName'] = patch.tableName;
    // null = omit (cleared)
  } else if (existing.tableName !== undefined) {
    result['tableName'] = existing.tableName;
  }

  // version: null = clear, number = set, undefined = keep
  if (patch.version !== undefined) {
    if (patch.version !== null) result['version'] = patch.version;
  } else if (existing.version !== undefined) {
    result['version'] = existing.version;
  }

  // entries: whole-array replacement when present, keep existing if absent
  result['entries'] = patch.entries !== undefined ? patch.entries : existing.entries;

  // roleDistinctRequirements: null = clear (omit field), array = set, undefined = keep
  if (patch.roleDistinctRequirements !== undefined) {
    if (patch.roleDistinctRequirements !== null) {
      result['roleDistinctRequirements'] = patch.roleDistinctRequirements;
    }
    // null = omit (cleared)
  } else if (existing.roleDistinctRequirements !== undefined) {
    result['roleDistinctRequirements'] = existing.roleDistinctRequirements;
  }

  return result as unknown as ModelRoutingTableSettings;
}

export class DrizzleConfigurationRecordRepository implements ConfigurationRecordRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  private async assertSingleActiveRoutingTable(tenant: string, excludeId?: string): Promise<void> {
    const allRecords = await this.list(tenant);
    const activeRoutingTables = allRecords.filter(
      (record) => record.kind === 'model_routing_table' && record.settings.active === true && record.id !== excludeId
    );
    if (activeRoutingTables.length > 0) {
      throw new Error(`Tenant ${tenant} already has an active model-routing table.`);
    }
  }

  async create(input: CreateConfigurationRecordRequest): Promise<ConfigurationRecord> {
    const now = new Date().toISOString();
    const id = `cfg_${randomUUID()}`;

    if (input.kind === 'model_routing_table' && input.settings.active === true) {
      await this.assertSingleActiveRoutingTable(input.tenant);
    }

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

    // model_routing_table update: proper patch semantics with active-uniqueness enforcement
    const existingTable = existing as Extract<ConfigurationRecord, { kind: 'model_routing_table' }>;
    const patch = input.settings ?? {} as UpdateModelRoutingTableSettings;

    // Check active uniqueness if activating
    if (patch.active === true) {
      await this.assertSingleActiveRoutingTable(tenant, id);
    }

    const updatedSettings = applyRoutingTableSettingsPatch(existingTable.settings, patch);
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
      kind: 'model_routing_table',
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
