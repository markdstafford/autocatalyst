import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CreateConfigurationRecordRequest, RunnerEvent } from '@autocatalyst/api-contract';
import {
  consumeRunnerEvents,
  createModelRoutingResolver,
  InMemoryRetainedRunEventStore,
  ModelRoutingConfigurationError
} from '@autocatalyst/core';
import {
  createSqliteDatabase,
  migrateSqliteDatabase,
  DrizzleConfigurationRecordRepository
} from '@autocatalyst/persistence';
import {
  createAgentRunnerFactory,
  getAgentProviderAdapterKey,
  type AgentProfileResolution,
  type AgentProviderAdapter,
  type AgentConnection,
  type AgentRunnerFactoryInput,
  type DirectCallFactoryInput,
  type AgentProviderAdapterRegistry,
  type DirectProviderAdapterRegistry,
  type ProcessLaunchConfig,
  type ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import {
  createDefaultProviderProfileFallbackRoutingResolver,
  createExplicitProfileResolver,
  createRoutingProfileResolver
} from './server.js';

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

  it('raises role_distinct_unsatisfied from resolveAgentRoute when table has a RoleDistinctRequirement for the step', async () => {
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
          ],
          roleDistinctRequirements: [
            { step: 'impl', mode: 'agent', roles: ['implementer', 'reviewer'], distinctBy: 'model' }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      // Single-role resolution must be blocked when a table-defined distinct requirement
      // exists for the step — callers must use resolveDistinctAgentRoutes instead.
      await expect(
        resolver.resolveAgentRoute({ tenant: TENANT, step: 'impl', role: 'implementer' })
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

  it('falls back to the explicit default profile for reviewed routes when no active routing table exists', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const explicitFallback = createExplicitProfileResolver({
        defaultProviderProfileId: claude.id,
        listRecords: () => repo.list(TENANT),
        registry: agentAdapters
      });
      const fallbackRouting = createDefaultProviderProfileFallbackRoutingResolver({
        resolver,
        fallback: explicitFallback
      });

      await expect(
        fallbackRouting.resolveDistinctAgentRoutes({
          tenant: TENANT,
          runId: 'run_reviewed_fallback',
          step: 'implementation.build',
          roles: ['implementer', 'reviewer']
        })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'role_distinct_unsatisfied',
        safeDetails: {
          tenant: TENANT,
          runId: 'run_reviewed_fallback',
          step: 'implementation.build',
          roles: ['implementer', 'reviewer'],
          distinctBy: 'profile'
        }
      });

      const implementer = await fallbackRouting.resolveAgentRoute({
        tenant: TENANT,
        runId: 'run_reviewed_fallback',
        step: 'implementation.build',
        role: 'implementer'
      });
      const reviewer = await fallbackRouting.resolveAgentRoute({
        tenant: TENANT,
        runId: 'run_reviewed_fallback',
        step: 'implementation.build',
        role: 'reviewer'
      });

      expect(implementer.profileId).toBe(claude.id);
      expect(reviewer.profileId).toBe(claude.id);
      expect(implementer.routingTableId).toBe('default_provider_profile_fallback');
      expect(reviewer.routingTableId).toBe('default_provider_profile_fallback');
      expect(implementer.routeId).toBe('default_provider_profile_fallback:implementation.build:implementer');
      expect(reviewer.routeId).toBe('default_provider_profile_fallback:implementation.build:reviewer');
      expect(implementer.profile.configurationRecordId).toBe(claude.id);
      expect(reviewer.profile.configurationRecordId).toBe(claude.id);
    });
  });

  it('uses active routing table entries before the default profile fallback', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      const openai = await repo.create(OPENAI_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            { id: 'rt_build_impl', route: { mode: 'agent', step: 'implementation.build', role: 'implementer' }, profileId: openai.id }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const fallbackRouting = createDefaultProviderProfileFallbackRoutingResolver({
        resolver,
        fallback: createExplicitProfileResolver({
          defaultProviderProfileId: claude.id,
          listRecords: () => repo.list(TENANT),
          registry: agentAdapters
        })
      });

      const result = await fallbackRouting.resolveAgentRoute({
        tenant: TENANT,
        runId: 'run_active_table_precedence',
        step: 'implementation.build',
        role: 'implementer'
      });

      expect(result.profileId).toBe(openai.id);
      expect(result.routeId).toBe('rt_build_impl');
      expect(result.routingTableId).not.toBe('default_provider_profile_fallback');
      expect(result.profile.providerKind).toBe('openai');
    });
  });

  it('does not hide active-table profile_not_found errors behind the default fallback', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_missing_profile',
              route: { mode: 'agent', step: 'implementation.build', role: 'implementer' },
              profileId: 'cfg_missing_profile_for_active_route'
            }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const fallbackRouting = createDefaultProviderProfileFallbackRoutingResolver({
        resolver,
        fallback: createExplicitProfileResolver({
          defaultProviderProfileId: claude.id,
          listRecords: () => repo.list(TENANT),
          registry: agentAdapters
        })
      });

      await expect(
        fallbackRouting.resolveAgentRoute({
          tenant: TENANT,
          runId: 'run_profile_not_found',
          step: 'implementation.build',
          role: 'implementer'
        })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'profile_not_found',
        safeDetails: {
          tenant: TENANT,
          runId: 'run_profile_not_found',
          routeId: 'rt_missing_profile',
          profileId: 'cfg_missing_profile_for_active_route'
        }
      });
    });
  });

  it('does not mask role_distinct_unsatisfied from an active routing table', async () => {
    await withTempDb(async (repo) => {
      const claude = await repo.create(CLAUDE_PROFILE);
      await repo.create({
        tenant: TENANT,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            { id: 'rt_build_impl', route: { mode: 'agent', step: 'implementation.build', role: 'implementer' }, profileId: claude.id },
            { id: 'rt_build_rev', route: { mode: 'agent', step: 'implementation.build', role: 'reviewer' }, profileId: claude.id }
          ],
          roleDistinctRequirements: [
            { step: 'implementation.build', mode: 'agent', roles: ['implementer', 'reviewer'], distinctBy: 'profile' }
          ]
        }
      });

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });
      const fallbackRouting = createDefaultProviderProfileFallbackRoutingResolver({
        resolver,
        fallback: createExplicitProfileResolver({
          defaultProviderProfileId: claude.id,
          listRecords: () => repo.list(TENANT),
          registry: agentAdapters
        })
      });

      await expect(
        fallbackRouting.resolveDistinctAgentRoutes({
          tenant: TENANT,
          runId: 'run_distinct_unsatisfied',
          step: 'implementation.build',
          roles: ['implementer', 'reviewer']
        })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'role_distinct_unsatisfied',
        safeDetails: {
          tenant: TENANT,
          runId: 'run_distinct_unsatisfied',
          step: 'implementation.build',
          distinctBy: 'profile'
        }
      });
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
      const factoryInput = { runId: 'run_1', step: 'impl', role: undefined as unknown as AgentRunnerFactoryInput['role'], tenant: TENANT } as AgentRunnerFactoryInput;

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

  it('profile owned by a different tenant cannot be resolved for another tenant routing table', async () => {
    const TENANT_A = 'tenant_a';
    const TENANT_B = 'tenant_b';

    await withTempDb(async (repo) => {
      // Create a Claude profile owned by tenant_a
      const claudeForA = await repo.create({ ...CLAUDE_PROFILE, tenant: TENANT_A });

      // Create a routing table for tenant_b that references tenant_a's profile id
      await repo.create({
        tenant: TENANT_B,
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [
            {
              id: 'rt_impl_implementer',
              route: { mode: 'agent', step: 'impl', role: 'implementer' },
              profileId: claudeForA.id
            }
          ]
        }
      });

      // Build a resolver for tenant_b — its findConfigurationRecordById will
      // scope the lookup to tenant_b, so the profile (owned by tenant_a) is invisible.
      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters,
        directAdapters
      });

      await expect(
        resolver.resolveAgentRoute({ tenant: TENANT_B, step: 'impl', role: 'implementer' })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'profile_not_found'
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers for composed dispatch tests
// ---------------------------------------------------------------------------

function makeLiveAgentAdapter(opts: {
  providerKind: string;
  adapterId: string;
  terminalId: string;
  onStartSession?: (providerKind: string) => void;
}): AgentProviderAdapter {
  return {
    providerKind: opts.providerKind,
    adapterId: opts.adapterId,
    supportedConnectionMechanism: 'fetch_transport' as const,
    async startSession(input) {
      opts.onStartSession?.(opts.providerKind);
      const runId = input.telemetryContext.runId;
      const step = input.telemetryContext.step ?? 'impl';
      async function* events(): AsyncIterable<RunnerEvent> {
        yield {
          id: opts.terminalId,
          runId,
          step,
          importance: 'normal',
          createdAt: new Date().toISOString(),
          type: 'runner_terminal_result',
          result: { directive: 'advance' }
        } as RunnerEvent;
      }
      return {
        events: events(),
        metadata: Promise.resolve({
          outcome: 'succeeded' as const,
          launchMechanism: 'fetch_transport' as const,
          degradedCapabilities: [],
          tokenUsage: { available: false } as const
        })
      };
    }
  };
}

function makeLiveConnection(profile: ResolvedAgentRunnerProfile): AgentConnection {
  return {
    profile,
    credentialResolved: true,
    createFetchTransport: () => ({ fetch: vi.fn(async () => new Response('{}', { status: 200 })) }),
    createProcessLaunchConfig: (): ProcessLaunchConfig => ({
      environment: { ANTHROPIC_AUTH_TOKEN: 'fake-token', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      secretVariableNames: ['ANTHROPIC_AUTH_TOKEN'],
      degradedCapabilities: [],
      redacted: { mechanism: 'process_environment', hasAuthToken: true }
    })
  };
}

function makeRunEnvironment(runId: string, tenant: string, step: string) {
  return {
    context: {
      run: { id: runId, workKind: 'feature' as const, currentStep: step, tenant },
      task: { prompt: 'Test', inputs: {} },
      workspaceIntent: { shape: 'none' as const },
      secretBindings: [],
      toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' as const },
      skills: { requested: [] },
      capabilityRequirements: {
        shell: { kind: 'bash' as const, required: false },
        paths: { canonicalWorkspacePaths: false },
        lsp: { requested: false }
      }
    },
    workspace: { shape: 'none' as const, workspaceRoots: [] },
    environment: { variables: {}, secretVariableNames: [] },
    toolPolicy: { allowedTools: [], workspaceRoots: [] },
    skills: { requested: [] },
    capabilities: {
      shell: { kind: 'bash' as const, available: false },
      paths: {},
      lsp: { requested: false, available: false }
    }
  };
}

// ---------------------------------------------------------------------------
// Composed dispatch tests: full production path
// DB config → resolver → createRoutingProfileResolver → createAgentRunnerFactory → consumeRunnerEvents
// ---------------------------------------------------------------------------

describe('dispatch through createAgentRunnerFactory + consumeRunnerEvents', () => {
  it('implementer routes to Claude cell through event consumer', async () => {
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

      const invokedProviders: string[] = [];
      const claudeAdapter = makeLiveAgentAdapter({
        providerKind: 'anthropic',
        adapterId: 'claude-agent-sdk',
        terminalId: 'evt_claude_001',
        onStartSession: (pk) => invokedProviders.push(pk)
      });

      const liveAdapters = new Map([
        [getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk'), claudeAdapter]
      ]) as unknown as AgentProviderAdapterRegistry;

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters: liveAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });

      const factory = createAgentRunnerFactory({
        adapters: liveAdapters,
        resolveProfile: (input: AgentRunnerFactoryInput): Promise<AgentProfileResolution> =>
          routingProfileResolver.resolveAgentProfile(input),
        createConnection: async (connectionInput) => makeLiveConnection(connectionInput.profile)
      });

      const runner = await factory.createRunner({
        runId: 'run_dispatch_001',
        step: 'impl',
        role: 'implementer',
        tenant: TENANT
      });

      const eventsStore = new InMemoryRetainedRunEventStore({
        maxEventsPerScope: 256,
        maxExpiredIdsPerScope: 64,
        subscriberBufferSize: 32
      });

      const result = await consumeRunnerEvents({
        eventsStore,
        events: runner.run({ environment: makeRunEnvironment('run_dispatch_001', TENANT, 'impl') }),
        runId: 'run_dispatch_001',
        tenant: TENANT
      });

      expect(result.workResult.directive).toBe('advance');
      expect(invokedProviders).toContain('anthropic');
    });
  });

  it('implementer and reviewer route to different providers through event consumer', async () => {
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

      const invokedByRole: Record<string, string> = {};
      const claudeAdapter = makeLiveAgentAdapter({
        providerKind: 'anthropic',
        adapterId: 'claude-agent-sdk',
        terminalId: 'evt_claude_002',
        onStartSession: (pk) => { invokedByRole['implementer'] = pk; }
      });
      const openaiAdapter = makeLiveAgentAdapter({
        providerKind: 'openai',
        adapterId: 'openai-agents-sdk',
        terminalId: 'evt_openai_002',
        onStartSession: (pk) => { invokedByRole['reviewer'] = pk; }
      });

      const liveAdapters = new Map([
        [getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk'), claudeAdapter],
        [getAgentProviderAdapterKey('openai', 'openai-agents-sdk'), openaiAdapter]
      ]) as unknown as AgentProviderAdapterRegistry;

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters: liveAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });

      const factory = createAgentRunnerFactory({
        adapters: liveAdapters,
        resolveProfile: (input: AgentRunnerFactoryInput): Promise<AgentProfileResolution> =>
          routingProfileResolver.resolveAgentProfile(input),
        createConnection: async (connectionInput) => makeLiveConnection(connectionInput.profile)
      });

      const implementerRunner = await factory.createRunner({
        runId: 'run_dispatch_002',
        step: 'impl',
        role: 'implementer',
        tenant: TENANT
      });
      const reviewerRunner = await factory.createRunner({
        runId: 'run_dispatch_002',
        step: 'impl',
        role: 'reviewer',
        tenant: TENANT
      });

      const eventsStore = new InMemoryRetainedRunEventStore({
        maxEventsPerScope: 256,
        maxExpiredIdsPerScope: 64,
        subscriberBufferSize: 32
      });

      const implementerResult = await consumeRunnerEvents({
        eventsStore,
        events: implementerRunner.run({ environment: makeRunEnvironment('run_dispatch_002', TENANT, 'impl') }),
        runId: 'run_dispatch_002',
        tenant: TENANT
      });
      const reviewerResult = await consumeRunnerEvents({
        eventsStore,
        events: reviewerRunner.run({ environment: makeRunEnvironment('run_dispatch_002', TENANT, 'impl') }),
        runId: 'run_dispatch_002',
        tenant: TENANT
      });

      expect(implementerResult.workResult.directive).toBe('advance');
      expect(reviewerResult.workResult.directive).toBe('advance');
      expect(invokedByRole['implementer']).toBe('anthropic');
      expect(invokedByRole['reviewer']).toBe('openai');
    });
  });

  it('route miss through factory raises ModelRoutingConfigurationError', async () => {
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

      const claudeAdapter = makeLiveAgentAdapter({
        providerKind: 'anthropic',
        adapterId: 'claude-agent-sdk',
        terminalId: 'evt_claude_003'
      });
      const liveAdapters = new Map([
        [getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk'), claudeAdapter]
      ]) as unknown as AgentProviderAdapterRegistry;

      const resolver = createModelRoutingResolver({
        configuration: configurationReaderFor(repo),
        agentAdapters: liveAdapters,
        directAdapters
      });
      const routingProfileResolver = createRoutingProfileResolver({ resolver, fallbackTenant: TENANT });

      const factory = createAgentRunnerFactory({
        adapters: liveAdapters,
        resolveProfile: (input: AgentRunnerFactoryInput): Promise<AgentProfileResolution> =>
          routingProfileResolver.resolveAgentProfile(input),
        createConnection: async (connectionInput) => makeLiveConnection(connectionInput.profile)
      });

      // Attempt to create a runner for a step that has no route
      await expect(
        factory.createRunner({
          runId: 'run_dispatch_003',
          step: 'planning',
          role: 'implementer',
          tenant: TENANT
        })
      ).rejects.toMatchObject({
        name: 'ModelRoutingConfigurationError',
        code: 'route_not_found'
      });
    });
  });
});
