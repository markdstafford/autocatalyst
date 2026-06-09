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

export type SecretResolutionErrorCode = 'missing_secret' | 'locked' | 'undecryptable' | 'unavailable';

export interface SecretResolutionErrorDetails {
  readonly handle: string;
  readonly causeMessage?: string;
}

export class SecretResolutionError extends Error {
  readonly code: SecretResolutionErrorCode;
  readonly details: SecretResolutionErrorDetails;

  constructor(code: SecretResolutionErrorCode, message: string, details: SecretResolutionErrorDetails) {
    super(message);
    this.name = 'SecretResolutionError';
    this.code = code;
    this.details = details;
  }
}

export interface SecretResolver {
  resolveSecret(handle: string): Promise<string>;
}

export function createSecret(
  store: SecretStore,
  input: CreateSecretInput
): Promise<CreateSecretResponse> {
  return store.createSecret(input);
}
