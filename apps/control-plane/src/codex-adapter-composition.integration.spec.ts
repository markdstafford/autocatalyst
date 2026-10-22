import { describe, expect, it } from 'vitest';

import type { ConfigurationRecord } from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  composeAgentProviderAdapterRegistry,
  composeConfiguredProviders,
  createExtensionRegistryCatalog
} from '@autocatalyst/core';
import { getAgentProviderAdapterKey } from '@autocatalyst/execution';
import {
  codexAgentAdapterId,
  codexProviderKind,
  createCodexAgentAdapter
} from '@autocatalyst/codex-agent-adapter';
import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter
} from '@autocatalyst/claude-agent-adapter';

// Deterministic integration coverage for issue #114: the Codex adapter composes
// through the existing registry/composition flow and routes by (providerKind,
// adapterId) without affecting the existing Claude adapter. No paid calls — the
// adapter factory is invoked but no session is started.

function codexProfileRecord(overrides: Partial<ConfigurationRecord> = {}): ConfigurationRecord {
  return {
    id: 'cfg_codex_1',
    kind: 'provider_profile',
    providerKind: codexProviderKind,
    adapterId: codexAgentAdapterId,
    settings: { profileName: 'codex-enterprise', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' },
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...overrides
  };
}

const codexRegistryCatalog = createExtensionRegistryCatalog([
  {
    providerKind: codexProviderKind,
    adapterId: codexAgentAdapterId,
    displayName: 'Codex (enterprise sign-in)',
    capabilities: ['agent_session']
  },
  {
    providerKind: claudeProviderKind,
    adapterId: claudeAgentAdapterId,
    displayName: 'Claude Agent SDK',
    capabilities: ['agent_session']
  }
]);

describe('codex adapter composition', () => {
  it('composes a Codex provider profile through the standard registry flow', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [codexProfileRecord()],
      registry: codexRegistryCatalog,
      providerAdapters: new Map([
        [buildProviderAdapterKey(codexProviderKind, codexAgentAdapterId), () => createCodexAgentAdapter()]
      ])
    });

    expect(result.unresolved).toEqual([]);
    expect(result.composed).toHaveLength(1);

    const registry = composeAgentProviderAdapterRegistry({ composed: result.composed });
    const adapter = registry.get(getAgentProviderAdapterKey(codexProviderKind, codexAgentAdapterId));
    expect(adapter).toBeDefined();
    expect(adapter?.providerKind).toBe('codex');
    expect(adapter?.adapterId).toBe('codex-app-server');
    expect(adapter?.supportedConnectionMechanism).toBe('process_environment');
  });

  it('reports a Codex profile as unresolved when no adapter factory is registered', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [codexProfileRecord()],
      registry: codexRegistryCatalog,
      providerAdapters: new Map()
    });

    expect(result.composed).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe('adapter_not_found');
    expect(result.unresolved[0]?.providerKind).toBe('codex');
  });

  it('registers Codex alongside Claude without displacing it', async () => {
    const result = await composeConfiguredProviders({
      configurationRecords: [
        codexProfileRecord(),
        codexProfileRecord({
          id: 'cfg_claude_1',
          providerKind: claudeProviderKind,
          adapterId: claudeAgentAdapterId,
          settings: { profileName: 'claude', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }
        })
      ],
      registry: codexRegistryCatalog,
      providerAdapters: new Map([
        [buildProviderAdapterKey(codexProviderKind, codexAgentAdapterId), () => createCodexAgentAdapter()],
        [buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId), () => createClaudeAgentAdapter()]
      ])
    });

    const registry = composeAgentProviderAdapterRegistry({ composed: result.composed });
    expect(registry.get(getAgentProviderAdapterKey(codexProviderKind, codexAgentAdapterId))?.providerKind).toBe('codex');
    expect(registry.get(getAgentProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId))?.providerKind).toBe('anthropic');
  });

  it('is loadable from the control-plane runtime', () => {
    expect(createCodexAgentAdapter).toBeTypeOf('function');
  });
});
