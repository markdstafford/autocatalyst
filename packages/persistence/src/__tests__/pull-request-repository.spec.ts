import { describe, expect, it } from 'vitest';

import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  withTempDatabasePath
} from '../index.js';
import type { DrizzleDomainRepositories, SqliteDatabase } from '../index.js';

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;

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

async function createRunForTenant(
  repos: DrizzleDomainRepositories,
  input: { readonly tenant: string; readonly owner: typeof owner; readonly identity: string }
) {
  const project = await repos.projects.create({
    owner: input.owner,
    tenant: input.tenant,
    displayName: `Project ${input.identity}`,
    repoUrl: 'https://example.test/repo',
    hostRepository: { provider: 'github', owner: 'example', name: `repo-${input.identity}` },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  const conversation = await repos.conversations.create({
    projectId: project.id,
    owner: input.owner,
    tenant: input.tenant,
    identity: input.identity,
    activeTopicId: null
  });
  const topic = await repos.topics.create({
    conversationId: conversation.id,
    owner: input.owner,
    tenant: input.tenant,
    title: `Topic ${input.identity}`,
    kind: 'main'
  });
  const run = await repos.runs.create({
    topicId: topic.id,
    owner: input.owner,
    tenant: input.tenant,
    workKind: 'feature',
    currentStep: 'pr.open',
    terminal: false
  });
  return { project, conversation, topic, run };
}

describe('DrizzlePullRequestRepository — updateState and listOpen', () => {
  it('updates PR state from open to merged and preserves other fields', async () => {
    await withRepositories(async (repos) => {
      const { run } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'pr-state-1' });
      const pr = await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 42,
        url: 'https://github.com/example/repo/pull/42',
        state: 'open',
        branch: 'feature/my-change'
      });

      expect(pr.state).toBe('open');

      const updated = await repos.pullRequests.updateState({
        runId: run.id,
        tenant: 'tenant_1',
        state: 'merged',
        updatedAt: '2026-06-16T10:00:00.000Z'
      });

      expect(updated.id).toBe(pr.id);
      expect(updated.state).toBe('merged');
      expect(updated.provider).toBe('github');
      expect(updated.number).toBe(42);
      expect(updated.branch).toBe('feature/my-change');
      expect(updated.updatedAt).toBe('2026-06-16T10:00:00.000Z');
    });
  });

  it('updates PR state from open to closed', async () => {
    await withRepositories(async (repos) => {
      const { run } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'pr-state-2' });
      await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 7,
        url: 'https://github.com/example/repo/pull/7',
        state: 'open',
        branch: 'fix/close-me'
      });

      const updated = await repos.pullRequests.updateState({
        runId: run.id,
        tenant: 'tenant_1',
        state: 'closed',
        updatedAt: '2026-06-16T11:00:00.000Z'
      });

      expect(updated.state).toBe('closed');
    });
  });

  it('throws when run ownership does not match (wrong runId)', async () => {
    await withRepositories(async (repos) => {
      const { run } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'pr-ownership-1' });
      await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 1,
        url: 'https://github.com/example/repo/pull/1',
        state: 'open',
        branch: 'feature/test'
      });

      await expect(
        repos.pullRequests.updateState({
          runId: 'run_nonexistent',
          tenant: 'tenant_1',
          state: 'merged',
          updatedAt: '2026-06-16T12:00:00.000Z'
        })
      ).rejects.toThrow();
    });
  });

  it('throws when tenant does not match', async () => {
    await withRepositories(async (repos) => {
      const tenantOwner2 = { id: 'user_2', kind: 'human', tenantId: 'tenant_2', displayName: 'Bob' } as const;
      const { run } = await createRunForTenant(repos, { owner: tenantOwner2, tenant: 'tenant_2', identity: 'pr-ownership-2' });
      await repos.pullRequests.create({
        runId: run.id,
        owner: tenantOwner2,
        tenant: 'tenant_2',
        provider: 'github',
        number: 99,
        url: 'https://github.com/example/repo/pull/99',
        state: 'open',
        branch: 'feature/other-tenant'
      });

      await expect(
        repos.pullRequests.updateState({
          runId: run.id,
          tenant: 'tenant_1',
          state: 'merged',
          updatedAt: '2026-06-16T12:00:00.000Z'
        })
      ).rejects.toThrow();
    });
  });

  it('throws when expectedState is provided but does not match current state', async () => {
    await withRepositories(async (repos) => {
      const { run } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'pr-expected-1' });
      await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 5,
        url: 'https://github.com/example/repo/pull/5',
        state: 'open',
        branch: 'feature/expected-state-test'
      });

      await expect(
        repos.pullRequests.updateState({
          runId: run.id,
          tenant: 'tenant_1',
          state: 'closed',
          updatedAt: '2026-06-16T13:00:00.000Z',
          expectedState: 'merged'
        })
      ).rejects.toThrow();
    });
  });

  it('succeeds when expectedState matches current state', async () => {
    await withRepositories(async (repos) => {
      const { run } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'pr-expected-2' });
      await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 6,
        url: 'https://github.com/example/repo/pull/6',
        state: 'open',
        branch: 'feature/expected-ok'
      });

      const updated = await repos.pullRequests.updateState({
        runId: run.id,
        tenant: 'tenant_1',
        state: 'merged',
        updatedAt: '2026-06-16T14:00:00.000Z',
        expectedState: 'open'
      });

      expect(updated.state).toBe('merged');
    });
  });

  it('listOpen returns only open PRs for the tenant', async () => {
    await withRepositories(async (repos) => {
      const { run: run1 } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'list-open-1' });
      const { run: run2 } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'list-open-2' });

      await repos.pullRequests.create({
        runId: run1.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 10,
        url: 'https://github.com/example/repo/pull/10',
        state: 'open',
        branch: 'feature/open-pr'
      });

      await repos.pullRequests.create({
        runId: run2.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 11,
        url: 'https://github.com/example/repo/pull/11',
        state: 'open',
        branch: 'feature/open-pr-2'
      });

      // Close run2's PR
      await repos.pullRequests.updateState({
        runId: run2.id,
        tenant: 'tenant_1',
        state: 'closed',
        updatedAt: '2026-06-16T15:00:00.000Z'
      });

      const open = await repos.pullRequests.listOpen({ tenant: 'tenant_1', limit: 100 });
      expect(open).toHaveLength(1);
      expect(open[0]!.number).toBe(10);
      expect(open[0]!.state).toBe('open');
    });
  });

  it('listOpen respects the limit parameter', async () => {
    await withRepositories(async (repos) => {
      const { run: run1 } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'limit-1' });
      const { run: run2 } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'limit-2' });
      const { run: run3 } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'limit-3' });

      for (const [run, num] of [[run1, 20], [run2, 21], [run3, 22]] as const) {
        await repos.pullRequests.create({
          runId: run.id,
          owner,
          tenant: 'tenant_1',
          provider: 'github',
          number: num,
          url: `https://github.com/example/repo/pull/${num}`,
          state: 'open',
          branch: `feature/pr-${num}`
        });
      }

      const limited = await repos.pullRequests.listOpen({ tenant: 'tenant_1', limit: 2 });
      expect(limited).toHaveLength(2);
    });
  });

  it('listOpen returns empty array when no open PRs exist', async () => {
    await withRepositories(async (repos) => {
      const { run } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'empty-open' });
      await repos.pullRequests.create({
        runId: run.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 30,
        url: 'https://github.com/example/repo/pull/30',
        state: 'open',
        branch: 'feature/will-be-merged'
      });

      await repos.pullRequests.updateState({
        runId: run.id,
        tenant: 'tenant_1',
        state: 'merged',
        updatedAt: '2026-06-16T16:00:00.000Z'
      });

      const open = await repos.pullRequests.listOpen({ tenant: 'tenant_1', limit: 100 });
      expect(open).toHaveLength(0);
    });
  });

  it('listOpen does not return PRs belonging to a different tenant', async () => {
    await withRepositories(async (repos) => {
      const tenant2Owner = { id: 'user_t2', kind: 'human', tenantId: 'tenant_2', displayName: 'Carol' } as const;
      const { run: run1 } = await createRunForTenant(repos, { owner, tenant: 'tenant_1', identity: 'cross-tenant-t1' });
      const { run: run2 } = await createRunForTenant(repos, { owner: tenant2Owner, tenant: 'tenant_2', identity: 'cross-tenant-t2' });

      await repos.pullRequests.create({
        runId: run1.id,
        owner,
        tenant: 'tenant_1',
        provider: 'github',
        number: 50,
        url: 'https://github.com/example/repo/pull/50',
        state: 'open',
        branch: 'feature/tenant1-pr'
      });

      await repos.pullRequests.create({
        runId: run2.id,
        owner: tenant2Owner,
        tenant: 'tenant_2',
        provider: 'github',
        number: 51,
        url: 'https://github.com/example/repo/pull/51',
        state: 'open',
        branch: 'feature/tenant2-pr'
      });

      const open = await repos.pullRequests.listOpen({ tenant: 'tenant_1', limit: 100 });
      expect(open).toHaveLength(1);
      expect(open[0]!.tenant).toBe('tenant_1');
    });
  });
});
