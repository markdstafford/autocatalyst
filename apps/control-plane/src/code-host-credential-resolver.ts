import { secretBackedCredentialReferenceSchema } from '@autocatalyst/api-contract';
import {
  CodeHostCredentialMissingError,
  SecretResolutionError,
  type ResolveCodeHostCredential
} from '@autocatalyst/core';

export function createCodeHostCredentialResolver(store: {
  resolveSecret(handle: string): Promise<string | undefined>;
}): ResolveCodeHostCredential {
  return async (ref) => {
    const parsed = secretBackedCredentialReferenceSchema.safeParse(ref);
    if (!parsed.success) throw new CodeHostCredentialMissingError();

    const handle = parsed.data.id;
    let token: string | undefined;
    try {
      token = await store.resolveSecret(handle);
    } catch (error) {
      if (error instanceof SecretResolutionError && error.code === 'missing_secret') {
        throw new CodeHostCredentialMissingError();
      }
      throw error;
    }
    if (token === undefined || token.length === 0) throw new CodeHostCredentialMissingError();
    return { token, secretRef: handle };
  };
}
