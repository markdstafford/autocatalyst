export interface ProxyRedactionOptions {
  readonly knownSecretValues?: readonly string[];
  readonly additionalSensitiveHeaderNames?: readonly string[];
}

export interface RedactProxyHeadersInput extends ProxyRedactionOptions {
  readonly direction: 'request' | 'response';
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

// Proxy dumps use lowercase [redacted] per the proxy design spec.
// The direct-fetch path in request-alteration.ts uses [REDACTED] — both are intentional.

// These header sets are intentionally different from the direct-fetch path in request-alteration.ts.
// The proxy spec explicitly lists these headers; request-alteration.ts covers a different set
// (e.g. x-auth-token, x-goog-api-key) by its own design.
const requestSensitiveHeaders = new Set(['authorization', 'x-api-key', 'api-key']);
const responseSensitiveHeaders = new Set(['set-cookie', 'authorization', 'www-authenticate', 'proxy-authenticate']);

export function redactKnownSecretText(text: string, options: ProxyRedactionOptions = {}): string {
  let redacted = text;
  for (const secret of options.knownSecretValues ?? []) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join('[redacted]');
    }
  }
  return redacted;
}

function normalizeValue(value: string | readonly string[] | undefined): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return (value as string[]).join(', ');
  return value as string;
}

export function redactProxyHeaders(input: RedactProxyHeadersInput): Record<string, string> {
  const baseSensitive = input.direction === 'request' ? requestSensitiveHeaders : responseSensitiveHeaders;
  const sensitive = new Set([
    ...baseSensitive,
    ...(input.additionalSensitiveHeaderNames ?? []).map((name) => name.toLowerCase())
  ]);

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (sensitive.has(name.toLowerCase())) {
      result[name] = '[redacted]';
    } else {
      result[name] = redactKnownSecretText(normalizeValue(value), input);
    }
  }
  return result;
}
