import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CreateConfigurationRecordRequest } from '@autocatalyst/api-contract';
import {
  createModelRoutingResolver,
  ModelRoutingConfigurationError
} from '@autocatalyst/core';
import {
  createSqliteDatabase,
  migrateSqliteDatabase,
  DrizzleConfigurationRecordRepository
} from '@autocatalyst/persistence';
import {
  getAgentProviderAdapterKey,
  type AgentRunnerFactoryInput,
  type DirectCallFactoryInput,
  type AgentProviderAdapterRegistry,
  type DirectProviderAdapterRegistry
} from '@autocatalyst/execution';
import { createRoutingProfileResolver } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = 'tenant_a';

async function withTempDb(
  run: (repo: DrizzleConfigurationRecordRepository) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'routing-test-'));
  try {
    const db = createSqliteDatabase({ path: join(dir, 'test.sqlite') });
    await migrateSqliteDatabase(db);
    const repo = new DrizzleConfigurationRecordRepository(db);
    try {
      await run(repo);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeAgentRegistry(
  entries: ReadonlyArray<{
    providerKind: string;
    adapterId: string;
    connectionMechanism?: 'fetch_transport' | 'process_environment';
  }>
): AgentProviderAdapterRegistry {
  const map = new Map<string, unknown>();
  for (const entry of entries) {
    map.set(getAgentProviderAdapterKey(entry.providerKind, entry.adapterId), {
      providerKind: entry.providerKind,
      adapterId: entry.adapterId,
      supportedConnectionMechanism: entry.connectionMechanism ?? 'fetch_transport',
      startSession: () => {
        throw new Error('startSession should not be called in routing tests');
      }
    });
  }
  return map as unknown as AgentProviderAdapterRegistry;
}

function makeDirectRegistry(
  entries: ReadonlyArray<{ providerKind: string; adapterId: string }>
): DirectProviderAdapterRegistry {
  const map = new Map<string, unknown>();
  for (const entry of entries) {
    map.set(getAgentProviderAdapterKey(entry.providerKind, entry.adapterId), {
      providerKind: entry.providerKind,
      adapterId: entry.adapterId,
      supportedConnectionMechanism: 'fetch_transport' as const,
      call: () => {
        throw new Error('call should not be invoked in routing tests');
      }
    });
  }
  return map as unknown as DirectProviderAdapterRegistry;
}

const CLAUDE_PROFILE: CreateConfigurationRecordRequest = {
  tenant: TENANT,
  kind: 'provider_profile',
  providerKind: 'anthropic',
  adapterId: 'claude-agent-sdk',
  settings: {
    profileName: 'Claude Sonnet',
    credentialSecretHandle: 'sec_abcdefghijklmnopqrstuvwxyzABCDEF',
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    endpoint: {}
  }
};

const OPENAI_PROFILE: CreateConfigurationRecordRequest = {
  tenant: TENANT,
  kind: 'provider_profile',
  providerKind: 'openai',
  adapterId: 'openai-agents-sdk',
  settings: {
    profileName: 'GPT-4o',
    credentialSecretHandle: 'sec_bbcdefghijklmnopqrstuvwxyzABCDEF',
    model: { provider: 'openai', model: 'gpt-4o' },
    inferenceSettings: {},
    endpoint: {}
  }
};

const DIRECT_PROFILE: CreateConfigurationRecordRequest = {
  tenant: TENANT,
  kind: 'provider_profile',
  providerKind: 'anthropic',
  adapterId: 'anthropic-direct',
  settings: {
    profileName: 'Claude Direct',
    credentialSecretHandle: 'sec_cccdefghijklmnopqrstuvwxyzABCDEF',
    model: { provider: 'anthropic', model: 'claude-haiku-4' },
    inferenceSettings: {},
    endpoint: {}
  }
};

function configurationReaderFor(repo: DrizzleConfigurationRecordRepository) {
  return {
    listConfigurationRecords: (tenant: string) => repo.list(tenant),
    findConfigurationRecordById: (tenant: string, id: string) => repo.findById(tenant, id)
  };
}

const agentAdapters = makeAgentRegistry([
  { providerKind: 'anthropic', adapterId: 'claude-agent-sdk' },
  { providerKind: 'openai', adapterId: 'openai-agents-sdk' }
]);
const directAdapters = makeDirectRegistry([
  { providerKind: 'anthropic', adapterId: 'anthropic-direct' }
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('model routing integration (real SQLite DB + mocked adapters)', () => {
  it('resolves an exact agent role route through real DB-backed reader', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      const openai = await repo.create(OPENAI_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            },
            {
              id: 'rt_impl_default',
              route: { mode: 'agent', step: 'impl', defaultForStep: true },
              profileId: openai.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const result = await resolver.resolveAgentRoute({
        tenant: TENANT,
        step: 'impl',
        role: 'implementer'
      });

      expect(result.profileId).toBe(claude.id);
      expect(result.profile.providerKind).toBe('anthropic');
      expect(result.profile.adapterId).toBe('claude-agent-sdk');
      expect(result.profile.mode).toBe('agent');
    });
  });

  it('falls back to step-level default when no exact role route exists', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      const openai = await repo.create(OPENAI_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            },
            {
              id: 'rt_impl_default',
              route: { mode: 'agent', step: 'impl', defaultForStep: true },
              profileId: openai.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const result = await resolver.resolveAgentRoute({
        tenant: TENANT,
        step: 'impl',
        role: 'reviewer'
      });

      expect(result.profileId).toBe(openai.id);
      expect(result.profile.providerKind).toBe('openai');
      expect(result.profile.adapterId).toBe('openai-agents-sdk');
    });
  });

  it('raises route_not_found when no routes match the step', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      await expect(
        resolver.resolveAgentRoute({ tenant: TENANT, step: 'planning', role: 'implementer' })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'route_not_found'
      });
    });
  });

  it('resolves a direct route through the direct adapter registry', async () => {
    await withTempDb(async (repo) => {
      const direct = await repo.create(DIRECT_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_intake_direct',
              route: { mode: 'direct', step: 'intake' },
              profileId: direct.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const result = await resolver.resolveDirectRoute({ tenant: TENANT, step: 'intake' });

      expect(result.profileId).toBe(direct.id);
      expect(result.profile.mode).toBe('direct');
      expect(result.profile.providerKind).toBe('anthropic');
      expect(result.profile.adapterId).toBe('anthropic-direct');
    });
  });

  it('resolves role-distinct routes when providers differ', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      const openai = await repo.create(OPENAI_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            },
            {
              id: 'rt_impl_reviewer',
              route: { mode: 'agent', step: 'impl', role: 'reviewer' },
              profileId: openai.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const result = await resolver.resolveDistinctAgentRoutes({
        tenant: TENANT,
        step: 'impl',
        roles: ['implementer', 'reviewer']
      });

      expect(result.resolutionsByRole['implementer']?.profileId).toBe(claude.id);
      expect(result.resolutionsByRole['reviewer']?.profileId).toBe(openai.id);
    });
  });

  it('raises role_distinct_unsatisfied when both roles resolve to the same provider/model', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            },
            {
              id: 'rt_impl_reviewer',
              route: { mode: 'agent', step: 'impl', role: 'reviewer' },
              profileId: claude.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      await expect(
        resolver.resolveDistinctAgentRoutes({
          tenant: TENANT,
          step: 'impl',
          roles: ['implementer', 'reviewer']
        })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'role_distinct_unsatisfied'
      });
    });
  });

  it('raises routing_table_missing when no active table exists for the tenant', async () => {
    await withTempDb(async (repo) => {
      await repo.create(CLAUDE_PROFILE);

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      await expect(
        resolver.resolveAgentRoute({ tenant: TENANT, step: 'impl', role: 'implementer' })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'routing_table_missing'
      });
    });
  });

  it('enforces single-active routing table at the repository layer', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_first',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            }
          ]
        }
      });

      await expect(
        repo.create({
          tenant: TENANT,
          kind: 'model_routing_table',
          settings: {
            active: true,
            entries: [
              {
                id: 'rt_second',
                route: { mode: 'agent', step: 'impl', role: 'implementer' },
                profileId: claude.id
              }
            ]
          }
        })
      ).rejects.toThrow(/already has an active model-routing table/);
    });
  });

  it('exports ModelRoutingConfigurationError as a recognizable type', async () => {
    await withTempDb(async (repo) => {
      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      try {
        await resolver.resolveAgentRoute({ tenant: TENANT, step: 'impl', role: 'implementer' });
        expect.fail('expected ModelRoutingConfigurationError');
      } catch (err) {
        expect(err).toBeInstanceOf(ModelRoutingConfigurationError);
      }
    });
  });
});

describe('dispatch through createRoutingProfileResolver', () => {
  it('resolves exact agent route through routing profile resolver', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });
      const factoryInput: AgentRunnerFactoryInput = { runId: 'run_1', step: 'impl', role: 'implementer', tenant: TENANT };
      const result = await routingProfileResolver.resolveAgentProfile(factoryInput);

      expect(result.profile.providerKind).toBe('anthropic');
      expect(result.profile.adapterId).toBe('claude-agent-sdk');
      expect(result.profile.mode).toBe('agent');
    });
  });

  it('falls back to step-default when no exact role route exists through routing profile resolver', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      const openai = await repo.create(OPENAI_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            },
            {
              id: 'rt_impl_default',
              route: { mode: 'agent', step: 'impl', defaultForStep: true },
              profileId: openai.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });
      const factoryInput: AgentRunnerFactoryInput = { runId: 'run_1', step: 'impl', role: 'reviewer', tenant: TENANT };
      const result = await routingProfileResolver.resolveAgentProfile(factoryInput);

      expect(result.profile.providerKind).toBe('openai');
    });
  });

  it('raises route_not_found when no routes match the step through routing profile resolver', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claude.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });
      const factoryInput: AgentRunnerFactoryInput = { runId: 'run_1', step: 'planning', role: 'implementer', tenant: TENANT };

      await expect(
        routingProfileResolver.resolveAgentProfile(factoryInput)
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'route_not_found'
      });
    });
  });

  it('raises ModelRoutingConfigurationError route_not_found for missing role (not ProviderConfigurationError)', async () => {
    await withTempDb(async (repo) => {
      await repo.create(CLAUDE_PROFILE);

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });
      const factoryInput = { runId: 'run_1', step: 'impl', role: undefined as any, tenant: TENANT } as AgentRunnerFactoryInput;

      await expect(
        routingProfileResolver.resolveAgentProfile(factoryInput)
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'route_not_found'
      });
    });
  });

  it('resolves direct route through routing profile resolver', async () => {
    await withTempDb(async (repo) => {
      const direct = await repo.create(DIRECT_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_intake_direct',
              route: { mode: 'direct', step: 'intake' },
              profileId: direct.id
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });
      const factoryInput = { runId: 'run_1', step: 'intake', tenant: TENANT } as DirectCallFactoryInput;
      const result = await routingProfileResolver.resolveDirectProfile(factoryInput);

      expect(result.profile.mode).toBe('direct');
      expect(result.profile.providerKind).toBe('anthropic');
    });
  });
});
