import { describe, expect, it } from 'vitest';

import { createSqliteDatabase, migrateSqliteDatabase, withTempDatabasePath } from './sqlite.js';
import { DrizzleConfigurationRecordRepository } from './configuration-record-repository.js';

const TEST_TENANT = 'tenant_dev';

describe('DrizzleConfigurationRecordRepository', () => {
  it('creates, lists, finds, updates, and deletes configuration records', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repository = new DrizzleConfigurationRecordRepository(database);

      const created = await repository.create({
        tenant: TEST_TENANT,
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: 'default', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }
      });
      expect(created.id).toMatch(/^cfg_/u);
      expect(created.settings).not.toHaveProperty('secretValue');
      expect(created.settings.profileName).toBe('default');
      expect(created.settings.credentialSecretHandle).toBe('sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');

      await expect(repository.findById(TEST_TENANT, created.id)).resolves.toEqual(created);
      const listed = await repository.list(TEST_TENANT);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(created);

      const updated = await repository.update(TEST_TENANT, created.id, {
        kind: 'provider_profile',
        settings: { profileName: 'renamed', credentialSecretHandle: null }
      });
      expect(updated?.settings.profileName).toBe('renamed');
      expect(updated?.settings.credentialSecretHandle).toBeUndefined();
      expect(updated?.createdAt).toBe(created.createdAt);
      expect(updated?.updatedAt).not.toBe(created.updatedAt);

      await expect(repository.delete(TEST_TENANT, created.id)).resolves.toBe(true);
      await expect(repository.findById(TEST_TENANT, created.id)).resolves.toBeNull();
      await expect(repository.delete(TEST_TENANT, created.id)).resolves.toBe(false);

      database.close();
    });
  });

  it('returns null for missing findById and false for missing delete', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repository = new DrizzleConfigurationRecordRepository(database);

      await expect(repository.findById(TEST_TENANT, 'cfg_missing')).resolves.toBeNull();
      await expect(repository.update(TEST_TENANT, 'cfg_missing', { kind: 'provider_profile', providerKind: 'new' })).resolves.toBeNull();
      await expect(repository.delete(TEST_TENANT, 'cfg_missing')).resolves.toBe(false);

      database.close();
    });
  });

  it('does not return records from a different tenant', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repository = new DrizzleConfigurationRecordRepository(database);

      const created = await repository.create({
        tenant: TEST_TENANT,
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: 'default' }
      });

      await expect(repository.findById('other_tenant', created.id)).resolves.toBeNull();
      const listed = await repository.list('other_tenant');
      expect(listed).toHaveLength(0);

      database.close();
    });
  });

  it('parses provider_profile and model_routing_table rows by kind', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repository = new DrizzleConfigurationRecordRepository(database);

      const providerProfile = await repository.create({
        tenant: 'tenant_a',
        kind: 'provider_profile',
        providerKind: 'anthropic',
        adapterId: 'claude-agent-sdk',
        settings: {
          profileName: 'Claude agent',
          credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
          model: { provider: 'anthropic', model: 'claude-sonnet-4' },
          inferenceSettings: {},
          endpoint: {}
        }
      });

      expect(providerProfile.kind).toBe('provider_profile');
      if (providerProfile.kind === 'provider_profile') {
        expect(providerProfile.providerKind).toBe('anthropic');
        expect(providerProfile.adapterId).toBe('claude-agent-sdk');
        expect(providerProfile.settings.profileName).toBe('Claude agent');
      }

      const routingTable = await repository.create({
        tenant: 'tenant_a',
        kind: 'model_routing_table',
        settings: { active: true, entries: [] }
      });

      expect(routingTable.kind).toBe('model_routing_table');
      if (routingTable.kind === 'model_routing_table') {
        expect('providerKind' in routingTable).toBe(false);
        expect('adapterId' in routingTable).toBe(false);
        expect(routingTable.settings.active).toBe(true);
        expect(routingTable.settings.entries).toEqual([]);
      }

      database.close();
    });
  });

  it('rejects kind/settings mismatch at the repository boundary', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const database = createSqliteDatabase({ path: databasePath });
      await migrateSqliteDatabase(database);
      const repository = new DrizzleConfigurationRecordRepository(database);

      // Create a legitimate routing table first
      const created = await repository.create({
        tenant: 'tenant_a',
        kind: 'model_routing_table',
        settings: { active: true, entries: [] }
      });

      // Attempt to update it with provider-profile kind
      await expect(repository.update('tenant_a', created.id, {
        kind: 'provider_profile',
        settings: { profileName: 'Wrong kind' }
      })).rejects.toThrow();

      database.close();
    });
  });

  describe('model_routing_table CRUD', () => {
    it('creates, finds, lists, and updates a routing table', async () => {
      await withTempDatabasePath(async (databasePath) => {
        const database = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(database);
        const repository = new DrizzleConfigurationRecordRepository(database);

        const created = await repository.create({
          tenant: 'tenant_a',
          kind: 'model_routing_table',
          settings: {
            active: true,
            tableName: 'Primary',
            version: 1,
            entries: [],
            roleDistinctRequirements: []
          }
        });

        expect(created.kind).toBe('model_routing_table');
        if (created.kind === 'model_routing_table') {
          expect(created.settings.active).toBe(true);
          expect(created.settings.tableName).toBe('Primary');
          expect(created.settings.version).toBe(1);
        }

        const found = await repository.findById('tenant_a', created.id);
        expect(found?.id).toBe(created.id);

        const listed = await repository.list('tenant_a');
        expect(listed.some((r) => r.id === created.id)).toBe(true);

        database.close();
      });
    });

    it('enforces at most one active routing table per tenant', async () => {
      await withTempDatabasePath(async (databasePath) => {
        const database = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(database);
        const repository = new DrizzleConfigurationRecordRepository(database);

        await repository.create({
          tenant: 'tenant_a',
          kind: 'model_routing_table',
          settings: { active: true, entries: [] }
        });

        await expect(repository.create({
          tenant: 'tenant_a',
          kind: 'model_routing_table',
          settings: { active: true, entries: [] }
        })).rejects.toThrow(/active model-routing table/i);

        // Different tenant should succeed
        const tenantB = await repository.create({
          tenant: 'tenant_b',
          kind: 'model_routing_table',
          settings: { active: true, entries: [] }
        });
        expect(tenantB.tenant).toBe('tenant_b');

        database.close();
      });
    });

    it('applies routing-table patch semantics correctly', async () => {
      await withTempDatabasePath(async (databasePath) => {
        const database = createSqliteDatabase({ path: databasePath });
        await migrateSqliteDatabase(database);
        const repository = new DrizzleConfigurationRecordRepository(database);

        const created = await repository.create({
          tenant: 'tenant_a',
          kind: 'model_routing_table',
          settings: {
            active: false,
            tableName: 'Initial',
            version: 1,
            entries: [],
            roleDistinctRequirements: [{ step: 's', mode: 'agent', roles: ['implementer', 'reviewer'], distinctBy: 'model' }]
          }
        });

        // Activate and update tableName
        const updated = await repository.update('tenant_a', created.id, {
          kind: 'model_routing_table',
          settings: { active: true, tableName: 'Updated' }
        });
        expect(updated?.kind === 'model_routing_table' && updated.settings.active).toBe(true);
        if (updated?.kind === 'model_routing_table') {
          expect(updated.settings.tableName).toBe('Updated');
          expect(updated.settings.version).toBe(1); // unchanged
          // roleDistinctRequirements should be preserved since not patched
          expect(updated.settings.roleDistinctRequirements).toHaveLength(1);
        }

        // Clear tableName with null
        const cleared = await repository.update('tenant_a', created.id, {
          kind: 'model_routing_table',
          settings: { tableName: null }
        });
        if (cleared?.kind === 'model_routing_table') {
          expect(cleared.settings.tableName).toBeUndefined();
          expect(cleared.settings.version).toBe(1); // version unchanged
        }

        // Whole-array replace entries
        const withEntries = await repository.update('tenant_a', created.id, {
          kind: 'model_routing_table',
          settings: {
            entries: [{
              id: 'route_1',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: 'cfg_123'
            }]
          }
        });
        if (withEntries?.kind === 'model_routing_table') {
          expect(withEntries.settings.entries).toHaveLength(1);
        }

        // Clear roleDistinctRequirements with null
        const withNullReqs = await repository.update('tenant_a', created.id, {
          kind: 'model_routing_table',
          settings: { roleDistinctRequirements: null }
        });
        if (withNullReqs?.kind === 'model_routing_table') {
          expect(withNullReqs.settings.roleDistinctRequirements).toBeUndefined();
        }

        database.close();
      });
    });
  });
});
