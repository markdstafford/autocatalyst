import type { ConfigurationRecord } from '@autocatalyst/api-contract';

export interface ExtensionRegistryEntry {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly description?: string;
}

export interface ExtensionRegistryCatalog {
  list(): readonly ExtensionRegistryEntry[];
  findProvider(providerKind: string, adapterId: string): ExtensionRegistryEntry | undefined;
}

export class InMemoryExtensionRegistryCatalog implements ExtensionRegistryCatalog {
  readonly #entries: readonly ExtensionRegistryEntry[];
  readonly #entriesByProviderKey: ReadonlyMap<string, ExtensionRegistryEntry>;

  constructor(entries: readonly ExtensionRegistryEntry[]) {
    const entriesByProviderKey = new Map<string, ExtensionRegistryEntry>();

    for (const entry of entries) {
      const key = buildRegistryKey(entry.providerKind, entry.adapterId);
      if (entriesByProviderKey.has(key)) {
        throw new Error(
          `Duplicate extension registry entry for providerKind "${entry.providerKind}" and adapterId "${entry.adapterId}".`
        );
      }
      entriesByProviderKey.set(key, entry);
    }

    this.#entries = [...entries];
    this.#entriesByProviderKey = entriesByProviderKey;
  }

  list(): readonly ExtensionRegistryEntry[] {
    return this.#entries;
  }

  findProvider(providerKind: string, adapterId: string): ExtensionRegistryEntry | undefined {
    return this.#entriesByProviderKey.get(buildRegistryKey(providerKind, adapterId));
  }
}

export function createExtensionRegistryCatalog(
  entries: readonly ExtensionRegistryEntry[] = []
): ExtensionRegistryCatalog {
  return new InMemoryExtensionRegistryCatalog(entries);
}

export const defaultExtensionRegistryCatalog: ExtensionRegistryCatalog = createExtensionRegistryCatalog();

export type ProviderConfigurationWarningCode = 'adapter_not_registered';

export interface ProviderConfigurationWarning {
  readonly code: ProviderConfigurationWarningCode;
  readonly configurationRecordId: string;
  readonly providerKind: string;
  readonly adapterId: string;
  readonly message: string;
}

export function validateProviderConfigurationAgainstRegistry(
  configurationRecord: ConfigurationRecord,
  registry: ExtensionRegistryCatalog
): readonly ProviderConfigurationWarning[] {
  if (configurationRecord.kind !== 'provider_profile') {
    return [];
  }

  const registryEntry = registry.findProvider(configurationRecord.providerKind, configurationRecord.adapterId);
  if (registryEntry !== undefined) {
    return [];
  }

  return [
    {
      code: 'adapter_not_registered',
      configurationRecordId: configurationRecord.id,
      providerKind: configurationRecord.providerKind,
      adapterId: configurationRecord.adapterId,
      message: `Configuration record ${configurationRecord.id} uses providerKind "${configurationRecord.providerKind}" and adapterId "${configurationRecord.adapterId}", which is not listed in the extension registry.`
    }
  ];
}

function buildRegistryKey(providerKind: string, adapterId: string): string {
  return JSON.stringify([providerKind, adapterId]);
}
