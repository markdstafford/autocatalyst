import { describe, expect, it } from 'vitest';

import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';
import type { DrizzleDomainRepositories, SqliteDatabase } from '../index.js';

const ownerA = { id: 'user_a', kind: 'human', tenantId: 'tenant_a', displayName: 'Ada' } as const;
const ownerB = { id: 'user_b', kind: 'human', tenantId: 'tenant_b', displayName: 'Bea' } as const;

async function withRepositories(
  run: (repos: DrizzleDomainRepositories, database: SqliteDatabase) => Promise<void>
): Promise<void> {
  await withTempDatabasePath(async (databasePath) => {
    const database = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(database);
    try {
      await run(createDrizzleDomainRepositories(database), database);
    } finally {
      database.close();
    }
  });
}

function createInput(owner: typeof ownerA, tenant: string, name: string) {
  return {
    owner,
    tenant,
    displayName: `Project ${name}`,
    repoUrl: `https://github.com/example/${name}`,
    hostRepository: { provider: 'github', owner: 'example', name },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  } as const;
}

describe('DrizzleProjectRepository tenant-scoped operations', () => {
  it('list(tenant) returns only projects in that tenant', async () => {
    await withRepositories(async (repos) => {
      await repos.projects.create(createInput(ownerA, 'tenant_a', 'a-one'));
      await repos.projects.create(createInput(ownerA, 'tenant_a', 'a-two'));
      await repos.projects.create(createInput(ownerB, 'tenant_b', 'b-one'));

      const tenantA = await repos.projects.list('tenant_a');
      expect(tenantA.map((p) => p.displayName).sort()).toEqual(['Project a-one', 'Project a-two']);
      const tenantB = await repos.projects.list('tenant_b');
      expect(tenantB).toHaveLength(1);
    });
  });

  it('findById(tenant, id) returns null for missing and cross-tenant ids', async () => {
    await withRepositories(async (repos) => {
      const project = await repos.projects.create(createInput(ownerA, 'tenant_a', 'scoped'));

      expect(await repos.projects.findById('tenant_a', project.id)).not.toBeNull();
      expect(await repos.projects.findById('tenant_b', project.id)).toBeNull();
      expect(await repos.projects.findById('tenant_a', 'proj_missing')).toBeNull();
    });
  });

  it('preserves the global findById(id) lookup for orchestrator consumers', async () => {
    await withRepositories(async (repos) => {
      const project = await repos.projects.create(createInput(ownerA, 'tenant_a', 'global'));
      const found = await repos.projects.findById(project.id);
      expect(found?.id).toBe(project.id);
    });
  });

  it('update changes only allowed fields and always changes updatedAt', async () => {
    await withRepositories(async (repos) => {
      const project = await repos.projects.create(createInput(ownerA, 'tenant_a', 'mutable'));
      // ensure a measurable time gap so updatedAt differs
      await new Promise((resolve) => setTimeout(resolve, 5));

      const updated = await repos.projects.update('tenant_a', project.id, {
        displayName: 'Renamed',
        issueTrackerSetting: { provider: 'jira', projectKey: 'AC' },
        credentialRefs: [{ id: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', purpose: 'repo' }]
      });

      expect(updated).not.toBeNull();
      expect(updated?.displayName).toBe('Renamed');
      expect(updated?.issueTrackerSetting?.provider).toBe('jira');
      expect(updated?.credentialRefs).toHaveLength(1);
      // immutable fields unchanged
      expect(updated?.repoUrl).toBe(project.repoUrl);
      expect(updated?.owner.id).toBe(project.owner.id);
      expect(updated?.workspaceRootOverride).toBeNull();
      expect(updated?.createdAt).toBe(project.createdAt);
      expect(updated?.updatedAt).not.toBe(project.updatedAt);
    });
  });

  it('update can clear a setting with an explicit null', async () => {
    await withRepositories(async (repos) => {
      const created = await repos.projects.create({
        ...createInput(ownerA, 'tenant_a', 'clearable'),
        issueTrackerSetting: { provider: 'jira', projectKey: 'AC' }
      });
      const updated = await repos.projects.update('tenant_a', created.id, { issueTrackerSetting: null });
      expect(updated?.issueTrackerSetting).toBeNull();
    });
  });

  it('update returns null for missing and cross-tenant ids', async () => {
    await withRepositories(async (repos) => {
      const project = await repos.projects.create(createInput(ownerA, 'tenant_a', 'noupdate'));
      expect(await repos.projects.update('tenant_b', project.id, { displayName: 'x' })).toBeNull();
      expect(await repos.projects.update('tenant_a', 'proj_missing', { displayName: 'x' })).toBeNull();
    });
  });
});
