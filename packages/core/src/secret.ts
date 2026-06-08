import type { CreateSecretRequest, CreateSecretResponse } from '@autocatalyst/api-contract';

export type CreateSecretInput = CreateSecretRequest;

export class SecretStoreLockedError extends Error {
  constructor() {
    super('Secret store is locked.');
    this.name = 'SecretStoreLockedError';
  }
}

export interface SecretStore {
  createSecret(input: CreateSecretInput): Promise<CreateSecretResponse>;
}

export function createSecret(
  store: SecretStore,
  input: CreateSecretInput
): Promise<CreateSecretResponse> {
  return store.createSecret(input);
}
