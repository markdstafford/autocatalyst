import type { CodeHostPort } from './code-host.js';
import { CodeHostError } from './code-host.js';

export interface CodeHostProviderRegistration {
  readonly provider: string;
  readonly create: () => CodeHostPort;
}

export interface CodeHostRegistry {
  get(provider: string): CodeHostPort;
}

export function createCodeHostRegistry(registrations: readonly CodeHostProviderRegistration[]): CodeHostRegistry {
  const providers = new Map<string, () => CodeHostPort>();
  for (const registration of registrations) {
    if (providers.has(registration.provider)) {
      throw new CodeHostError('duplicate_provider', 'Duplicate code-host provider registration.', { provider: registration.provider });
    }
    providers.set(registration.provider, registration.create);
  }
  return {
    get(provider: string): CodeHostPort {
      const factory = providers.get(provider);
      if (factory === undefined) {
        throw new CodeHostError('unsupported_provider', `Unsupported code-host provider '${provider}'.`, { provider });
      }
      return factory();
    }
  };
}
