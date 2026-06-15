import type {
  ConfigurationRecord,
  CreateConfigurationRecordRequest,
  UpdateConfigurationRecordRequest
} from '@autocatalyst/api-contract';

export function assertActiveRoutesReferenceDispatchableProfiles(
  records: readonly ConfigurationRecord[],
  candidate: ConfigurationRecord
): void {
  if (candidate.kind !== 'model_routing_table') return;
  const settings = candidate.settings;
  if (typeof settings !== 'object' || settings === null) return;
  if (!('active' in settings) || (settings as Record<string, unknown>)['active'] !== true) return;
  const entries = (settings as Record<string, unknown>)['entries'];
  if (!Array.isArray(entries)) return;

  const profilesById = new Map(
    records
      .filter((r) => r.kind === 'provider_profile')
      .map((r) => [r.id, r])
  );

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { enabled?: boolean; profileId?: string };
    if (e.enabled === false) continue;
    const profileId = e.profileId;
    if (typeof profileId !== 'string') continue;

    const profile = profilesById.get(profileId);
    if (profile === undefined || profile.kind !== 'provider_profile') {
      throw new Error('profile_not_found');
    }
    const pSettings = profile.settings as Record<string, unknown>;
    if (!pSettings['model']) {
      throw new Error('profile_incomplete');
    }
    if (!pSettings['credentialSecretHandle']) {
      throw new Error('profile_incomplete');
    }
  }
}

export function assertProviderProfileUpdateDoesNotBreakActiveRoutes(
  records: readonly ConfigurationRecord[],
  profileId: string,
  mergedProfileSettings: Record<string, unknown>
): void {
  const activeRoutingTables = records.filter((r) => {
    if (r.kind !== 'model_routing_table') return false;
    const s = r.settings as Record<string, unknown>;
    return s['active'] === true;
  });

  for (const routingTable of activeRoutingTables) {
    const entries = (routingTable.settings as Record<string, unknown>)['entries'];
    if (!Array.isArray(entries)) continue;
    const referencesThisProfile = entries.some((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const e = entry as { enabled?: boolean; profileId?: string };
      return e.enabled !== false && e.profileId === profileId;
    });
    if (!referencesThisProfile) continue;

    if (!mergedProfileSettings['model']) {
      throw new Error('profile_incomplete');
    }
    if (!mergedProfileSettings['credentialSecretHandle']) {
      throw new Error('profile_incomplete');
    }
  }
}

export type CreateConfigurationRecordInput = CreateConfigurationRecordRequest;
export type UpdateConfigurationRecordInput = UpdateConfigurationRecordRequest;

export interface ConfigurationRecordRepository {
  create(input: CreateConfigurationRecordInput): Promise<ConfigurationRecord>;
  list(tenant: string): Promise<readonly ConfigurationRecord[]>;
  findById(tenant: string, id: string): Promise<ConfigurationRecord | null>;
  update(tenant: string, id: string, input: UpdateConfigurationRecordInput): Promise<ConfigurationRecord | null>;
  delete(tenant: string, id: string): Promise<boolean>;
}

export function createConfigurationRecord(
  repository: ConfigurationRecordRepository,
  input: CreateConfigurationRecordInput
): Promise<ConfigurationRecord> {
  return repository.create(input);
}

export function listConfigurationRecords(
  repository: ConfigurationRecordRepository,
  tenant: string
): Promise<readonly ConfigurationRecord[]> {
  return repository.list(tenant);
}

export function getConfigurationRecord(
  repository: ConfigurationRecordRepository,
  tenant: string,
  id: string
): Promise<ConfigurationRecord | null> {
  return repository.findById(tenant, id);
}

export function updateConfigurationRecord(
  repository: ConfigurationRecordRepository,
  tenant: string,
  id: string,
  input: UpdateConfigurationRecordInput
): Promise<ConfigurationRecord | null> {
  return repository.update(tenant, id, input);
}

export function deleteConfigurationRecord(
  repository: ConfigurationRecordRepository,
  tenant: string,
  id: string
): Promise<boolean> {
  return repository.delete(tenant, id);
}
