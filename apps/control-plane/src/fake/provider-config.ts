import { claudeAgentAdapterId, claudeProviderKind } from '@autocatalyst/claude-agent-adapter';
import type { ConfigurationRecord, ProviderProfileSettings } from '@autocatalyst/api-contract';

import { FAKE_SECRET_VALUE } from './constants.js';

/** Marker profile name used to detect an already-created fake provider profile. */
export const FAKE_PROVIDER_PROFILE_NAME = 'fake-mode-claude';

/** Minimal surface of the secret store used during fake bootstrap. */
export interface FakeSecretStore {
  createSecret(input: { value: string }): Promise<{ handle: string }>;
}

/** Minimal surface of the configuration record repository used during fake bootstrap. */
export interface FakeConfigurationRecords {
  list(tenant: string): Promise<readonly ConfigurationRecord[]>;
  create(input: {
    tenant: string;
    kind: 'provider_profile';
    providerKind: string;
    adapterId: string;
    settings: ProviderProfileSettings;
  }): Promise<{ id: string }>;
}

interface ProviderProfileRecordLike {
  readonly id: string;
  readonly kind?: string;
  readonly providerKind?: string;
  readonly adapterId?: string;
  readonly settings?: { profileName?: string };
}

/**
 * Create the fake secret and a Claude Agent SDK provider profile that resolves AI
 * steps to the scripted adapter — only when absent. Returns the profile id used
 * as the default provider profile for fake dispatch. Idempotent across restarts.
 */
export async function ensureFakeProviderConfig(input: {
  readonly secretStore: FakeSecretStore;
  readonly configurationRecords: FakeConfigurationRecords;
  readonly tenant: string;
}): Promise<string> {
  const existing = (await input.configurationRecords.list(input.tenant)) as unknown as readonly ProviderProfileRecordLike[];
  const match = existing.find(
    (record) =>
      record.kind === 'provider_profile' &&
      record.providerKind === claudeProviderKind &&
      record.adapterId === claudeAgentAdapterId &&
      record.settings?.profileName === FAKE_PROVIDER_PROFILE_NAME
  );
  if (match !== undefined) {
    return match.id;
  }

  const { handle } = await input.secretStore.createSecret({ value: FAKE_SECRET_VALUE });
  const settings: ProviderProfileSettings = {
    profileName: FAKE_PROVIDER_PROFILE_NAME,
    credentialSecretHandle: handle,
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    endpoint: {}
  };
  const created = await input.configurationRecords.create({
    tenant: input.tenant,
    kind: 'provider_profile',
    providerKind: claudeProviderKind,
    adapterId: claudeAgentAdapterId,
    settings
  });
  return created.id;
}
