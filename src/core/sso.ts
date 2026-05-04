import type { SsoProvider } from '../types/config.js';

/** Minimal logger interface accepted by triggerSsoFlow */
export interface SsoLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Initiates the enterprise SSO authentication flow for the given provider.
 *
 * Prompts the user to authenticate using the appropriate OAuth flow for the
 * specified provider. Logs a clear message before prompting so the user
 * understands why execution is paused. Returns the resulting bearer token.
 *
 * To add a new SSO provider:
 *   1. Add its name to the SsoProvider union in src/types/config.ts
 *   2. Add a case to the switch statement below
 *   3. Wire its token env var in resolveLlmSettings in src/core/config.ts
 *
 * NOTE: The specific OAuth endpoints and flow variant for each provider must be
 * confirmed against that provider's enterprise documentation before implementing
 * the corresponding case. For Anthropic, consult the enterprise OAuth docs to
 * determine whether to use device code flow (RFC 8628) or PKCE with local callback.
 */
export async function triggerSsoFlow(provider: SsoProvider, logger: SsoLogger): Promise<string> {
  logger.info(
    { event: 'sso.flow.start', provider },
    `${provider} SSO token missing or expired — starting SSO authentication flow. You will be prompted to authenticate.`,
  );

  let token: string;
  switch (provider) {
    case 'anthropic':
      // TODO: Implement Anthropic enterprise OAuth flow.
      // Confirm the correct flow variant (device code or PKCE with local callback)
      // against Anthropic enterprise documentation before implementing.
      // The resulting bearer token should be passed to the Anthropic SDK via authToken.
      throw new Error(
        'Anthropic SSO flow is not yet implemented. ' +
        'Pre-load AC_ANTHROPIC_SSO_TOKEN with a valid bearer token, or implement ' +
        'the Anthropic enterprise OAuth flow in src/core/sso.ts.',
      );
    default: {
      // TypeScript exhaustiveness — this branch is unreachable if SsoProvider is fully handled above
      const _exhaustive: never = provider;
      throw new Error(`Unsupported SSO provider: ${_exhaustive}`);
    }
  }

  logger.info({ event: 'sso.flow.complete', provider }, 'SSO authentication complete');
  return token;
}
