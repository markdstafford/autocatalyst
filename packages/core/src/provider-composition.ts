import type { ConfigurationRecord } from '@autocatalyst/api-contract';

import {
  validateProviderConfigurationAgainstRegistry,
  type ExtensionRegistryCatalog,
  type ProviderConfigurationWarning
} from './extension-registry.js';

export interface ProviderAdapterFactoryInput {
  readonly configurationRecord: ConfigurationRecord;
}

export interface ProviderPortBinding {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly configurationRecordId: string;
  readonly adapter: unknown;
}

export type ProviderAdapterFactory = (
  input: ProviderAdapterFactoryInput
) => unknown | Promise<unknown>;

export type ProviderAdapterMap = ReadonlyMap<string, ProviderAdapterFactory>;

export type ProviderCompositionUnresolvedReason = 'adapter_not_found' | 'adapter_factory_failed';

export interface ProviderCompositionUnresolved {
  readonly configurationRecordId: string;
  readonly providerKind: string;
  readonly adapterId: string;
  readonly reason: ProviderCompositionUnresolvedReason;
  readonly message: string;
}

export interface ProviderCompositionResult {
  readonly composed: readonly ProviderPortBinding[];
  readonly warnings: readonly ProviderConfigurationWarning[];
  readonly unresolved: readonly ProviderCompositionUnresolved[];
}

export interface ComposeConfiguredProvidersInput {
  readonly configurationRecords: readonly ConfigurationRecord[];
  readonly registry: ExtensionRegistryCatalog;
  readonly providerAdapters: ProviderAdapterMap;
}

export function buildProviderAdapterKey(providerKind: string, adapterId: string): string {
  return JSON.stringify([providerKind, adapterId]);
}

export const emptyProviderAdapterMap: ProviderAdapterMap = new Map<string, ProviderAdapterFactory>();

export async function composeConfiguredProviders(
  input: ComposeConfiguredProvidersInput
): Promise<ProviderCompositionResult> {
  const composed: ProviderPortBinding[] = [];
  const warnings: ProviderConfigurationWarning[] = [];
  const unresolved: ProviderCompositionUnresolved[] = [];

  for (const configurationRecord of input.configurationRecords) {
    if (configurationRecord.kind !== 'provider_profile') {
      continue;
    }

    warnings.push(...validateProviderConfigurationAgainstRegistry(configurationRecord, input.registry));

    const factory = input.providerAdapters.get(
      buildProviderAdapterKey(configurationRecord.providerKind, configurationRecord.adapterId)
    );
    if (factory === undefined) {
      unresolved.push({
        configurationRecordId: configurationRecord.id,
        providerKind: configurationRecord.providerKind,
        adapterId: configurationRecord.adapterId,
        reason: 'adapter_not_found',
        message: `Configuration record ${configurationRecord.id} uses providerKind "${configurationRecord.providerKind}" and adapterId "${configurationRecord.adapterId}", but no adapter factory was registered for that pair.`
      });
      continue;
    }

    try {
      const adapter = await Promise.resolve(factory({ configurationRecord }));
      composed.push({
        providerKind: configurationRecord.providerKind,
        adapterId: configurationRecord.adapterId,
        configurationRecordId: configurationRecord.id,
        adapter
      });
    } catch {
      unresolved.push({
        configurationRecordId: configurationRecord.id,
        providerKind: configurationRecord.providerKind,
        adapterId: configurationRecord.adapterId,
        reason: 'adapter_factory_failed',
        message: `Configuration record ${configurationRecord.id} uses providerKind "${configurationRecord.providerKind}" and adapterId "${configurationRecord.adapterId}", but its adapter factory failed during startup composition.`
      });
    }
  }

  return { composed, warnings, unresolved };
}
