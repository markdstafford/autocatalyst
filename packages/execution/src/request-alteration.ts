import type { JsonValue, RunnerEndpointSettings } from '@autocatalyst/api-contract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const defaultRequestTimeoutMs = 60_000;
export const maximumRequestTimeoutMs = 600_000;
export const defaultMaxRetries = 1;
export const maximumMaxRetries = 5;
export const transientHttpStatuses: readonly number[] = [408, 429, 500, 502, 503, 504];

export const claudeProviderOwnedEnvironmentVariables: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_MAX_RETRIES'
];

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type ProviderAlterationErrorCode =
  | 'invalid_header_name'
  | 'invalid_base_url'
  | 'invalid_timeout'
  | 'invalid_retry_policy'
  | 'unsupported_required_capability';

export class ProviderAlterationError extends Error {
  readonly code: ProviderAlterationErrorCode;
  readonly safeDetails?: unknown;

  constructor(code: ProviderAlterationErrorCode, message: string, safeDetails?: unknown) {
    super(message);
    this.name = 'ProviderAlterationError';
    this.code = code;
    if (safeDetails !== undefined) this.safeDetails = safeDetails;
  }
}

// ---------------------------------------------------------------------------
// Capability degradation
// ---------------------------------------------------------------------------

export interface ProviderCapabilityDegradation {
  readonly capability: string;
  readonly reason: string;
  readonly required: boolean;
}

// ---------------------------------------------------------------------------
// Fetch alteration types
// ---------------------------------------------------------------------------

export interface ProviderRequest {
  readonly url: string;
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly transientHttpStatuses: readonly number[];
}

export interface AlteredProviderRequest {
  readonly request: ProviderRequest & { readonly headers: Readonly<Record<string, string>> };
  readonly timeoutMs: number;
  readonly retryPolicy: RetryPolicy;
}

export interface RequestAlterationOptions {
  readonly request: ProviderRequest;
  readonly endpoint: RunnerEndpointSettings;
  readonly credential?: string;
  readonly authScheme?: 'Bearer' | 'raw';
}

// ---------------------------------------------------------------------------
// Retry policy helpers
// ---------------------------------------------------------------------------

export const defaultRetryBaseDelayMs = 250;
export const maximumRetryDelayMs = 5_000;

export interface ResolvedRetryPolicy extends RetryPolicy {
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
}

export function resolveRetryPolicy(endpoint: RunnerEndpointSettings): ResolvedRetryPolicy {
  const rawRetries = endpoint.maxRetries ?? defaultMaxRetries;
  const maxRetries = Math.max(0, Math.min(rawRetries, maximumMaxRetries));
  return {
    maxRetries,
    transientHttpStatuses,
    baseDelayMs: defaultRetryBaseDelayMs,
    maximumDelayMs: maximumRetryDelayMs
  };
}

export function parseRetryAfterMs(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.min(Math.round(numericSeconds * 1000), maximumRetryDelayMs);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.min(Math.max(0, dateMs - nowMs), maximumRetryDelayMs);
}

export function computeRetryDelayMs(input: {
  readonly attemptNumber: number;
  readonly retryAfter?: string;
  readonly jitter?: number;
  readonly nowMs?: number;
}): number {
  const retryAfterMs = parseRetryAfterMs(input.retryAfter, input.nowMs ?? Date.now());
  if (retryAfterMs !== undefined) return retryAfterMs;
  const boundedAttempt = Math.max(1, input.attemptNumber);
  const base = defaultRetryBaseDelayMs * Math.pow(2, boundedAttempt - 1);
  const bounded = Math.min(base, maximumRetryDelayMs);
  const jitter = Math.max(0, Math.min(input.jitter ?? Math.random(), 1));
  return Math.min(Math.round(bounded + bounded * 0.5 * jitter), maximumRetryDelayMs);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// HTTP token character class per RFC 7230
const HTTP_TOKEN_REGEX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export function validateHttpHeaderName(name: string): boolean {
  if (!name) return false;
  return HTTP_TOKEN_REGEX.test(name);
}

// ---------------------------------------------------------------------------
// Case-insensitive header helpers
// ---------------------------------------------------------------------------

function normalizeHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
}

function stripHeaders(
  headers: Record<string, string>,
  headersToStrip: readonly string[]
): Record<string, string> {
  const stripLower = new Set(headersToStrip.map((h) => h.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !stripLower.has(k))
  );
}

/**
 * Rewrites the values of headers that already exist in `headers`.
 * NOTE: Header rewrites only apply to headers that already exist after stripping.
 * Headers not present are not added.
 */
function rewriteHeaders(
  headers: Record<string, string>,
  headersToRewrite: Readonly<Record<string, string>>
): Record<string, string> {
  const result = { ...headers };
  for (const [name, value] of Object.entries(headersToRewrite)) {
    const nameLower = name.toLowerCase();
    // Only rewrite headers that already exist (case-insensitive match)
    const existingKey = Object.keys(result).find((k) => k.toLowerCase() === nameLower);
    if (existingKey !== undefined) {
      result[existingKey] = value;
    }
    // If header doesn't exist (e.g. was stripped), do NOT add it
  }
  return result;
}

// ---------------------------------------------------------------------------
// applyRequestAlteration
// ---------------------------------------------------------------------------

export function applyRequestAlteration(options: RequestAlterationOptions): AlteredProviderRequest {
  const { request, endpoint, credential, authScheme = 'Bearer' } = options;

  // 1. Determine final URL
  let finalUrl = request.url;
  if (endpoint.baseUrl !== undefined) {
    try {
      const base = new URL(endpoint.baseUrl);
      const original = new URL(request.url);
      // Combine: preserve base pathname prefix, then append original path
      const basePath = base.pathname.replace(/\/$/, ''); // remove trailing slash
      const reqPath = original.pathname; // starts with /
      const combinedPath = basePath + reqPath;
      const combined = new URL(combinedPath + original.search + original.hash, base.origin);
      finalUrl = combined.toString();
    } catch {
      throw new ProviderAlterationError(
        'invalid_base_url',
        `Invalid baseUrl: ${endpoint.baseUrl}`,
        { baseUrl: endpoint.baseUrl }
      );
    }
  }

  // 2. Build headers (normalized to lowercase keys)
  let headers = normalizeHeaders(request.headers);

  // 3. Strip before rewrite
  if (endpoint.headersToStrip && endpoint.headersToStrip.length > 0) {
    headers = stripHeaders(headers, endpoint.headersToStrip);
  }

  // 4. Rewrite after strip
  if (endpoint.headersToRewrite) {
    headers = rewriteHeaders(headers, endpoint.headersToRewrite);
  }

  // 5. Auth injection after rewrite
  if (endpoint.authHeaderName !== undefined && credential !== undefined) {
    const authValue = authScheme === 'raw' ? credential : `Bearer ${credential}`;
    headers[endpoint.authHeaderName.toLowerCase()] = authValue;
  }

  // 6. Timeout (clamp, don't fail)
  const rawTimeout = endpoint.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const timeoutMs = Math.min(rawTimeout, maximumRequestTimeoutMs);

  // 7. Retries (clamp, don't fail)
  const rawRetries = endpoint.maxRetries ?? defaultMaxRetries;
  const maxRetries = Math.min(rawRetries, maximumMaxRetries);

  return {
    request: {
      url: finalUrl,
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: request.body } : {})
    },
    timeoutMs,
    retryPolicy: {
      maxRetries,
      transientHttpStatuses
    }
  };
}

// ---------------------------------------------------------------------------
// isTransientProviderFailure
// ---------------------------------------------------------------------------

export function isTransientProviderFailure(
  input:
    | { readonly kind: 'http_status'; readonly status: number }
    | { readonly kind: 'transport_error'; readonly code?: string }
): boolean {
  if (input.kind === 'transport_error') return true;
  return transientHttpStatuses.includes(input.status);
}

// ---------------------------------------------------------------------------
// Process launch types
// ---------------------------------------------------------------------------

export interface ClaudeProcessLaunchInput {
  readonly endpoint: RunnerEndpointSettings;
  readonly credential: string;
  readonly materializedEnvironment: {
    readonly variables: Readonly<Record<string, string>>;
    readonly secretVariableNames: readonly string[];
  };
}

export interface ClaudeProcessLaunchResult {
  readonly environment: Readonly<Record<string, string>>;
  readonly secretVariableNames: readonly string[];
  readonly degradedCapabilities: readonly ProviderCapabilityDegradation[];
}

// ---------------------------------------------------------------------------
// buildClaudeProcessLaunchEnvironment
// ---------------------------------------------------------------------------

function sanitizeHeaderComponent(s: string): string {
  return s.replace(/[\r\n]/g, '');
}

function serializeAnthropicCustomHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${sanitizeHeaderComponent(name)}: ${sanitizeHeaderComponent(value)}`)
    .join('\n');
}

export function buildClaudeProcessLaunchEnvironment(input: ClaudeProcessLaunchInput): ClaudeProcessLaunchResult {
  const { endpoint, credential, materializedEnvironment } = input;
  const degradedCapabilities: ProviderCapabilityDegradation[] = [];

  // Check unsupported required capability: header strip
  if (endpoint.headersToStrip && endpoint.headersToStrip.length > 0) {
    if (endpoint.requiredAlterations?.headerStrip === true) {
      throw new ProviderAlterationError(
        'unsupported_required_capability',
        'Header strip is a required alteration but is not supported in Claude process launch mode.',
        { headersToStrip: endpoint.headersToStrip }
      );
    }
    // Record degradation
    degradedCapabilities.push({
      capability: 'header_strip',
      reason: `Cannot strip headers [${endpoint.headersToStrip.join(', ')}] in Claude process launch mode.`,
      required: false
    });
  }

  // 1. Start with materialized env, stripped of all provider-owned variables
  const ownedSet = new Set(claudeProviderOwnedEnvironmentVariables);
  const baseEnv: Record<string, string> = Object.fromEntries(
    Object.entries(materializedEnvironment.variables).filter(([k]) => !ownedSet.has(k))
  );

  // 2. Propagate existing secretVariableNames (minus provider-owned ones)
  const existingSecrets = materializedEnvironment.secretVariableNames.filter((s) => !ownedSet.has(s));
  const secretVarNames = new Set<string>(existingSecrets);

  // 3. Overlay endpoint config
  const overlayEnv: Record<string, string> = {};

  if (endpoint.baseUrl !== undefined) {
    overlayEnv['ANTHROPIC_BASE_URL'] = endpoint.baseUrl;
  }

  // Credential mapping
  const credentialTarget = endpoint.authEnvironmentVariable ?? 'ANTHROPIC_API_KEY';
  overlayEnv[credentialTarget] = credential;
  secretVarNames.add(credentialTarget);

  // Custom headers (header rewrites + authHeaderName credential encoded as newline-delimited header lines)
  const customHeaders: Record<string, string> = {
    ...(endpoint.headersToRewrite ?? {})
  };

  if (endpoint.authHeaderName !== undefined) {
    customHeaders[endpoint.authHeaderName] = credential;
  }

  if (Object.keys(customHeaders).length > 0) {
    overlayEnv['ANTHROPIC_CUSTOM_HEADERS'] = serializeAnthropicCustomHeaders(customHeaders);
    secretVarNames.add('ANTHROPIC_CUSTOM_HEADERS');
  }

  // Timeout (bounded)
  const rawTimeout = endpoint.requestTimeoutMs ?? defaultRequestTimeoutMs;
  overlayEnv['API_TIMEOUT_MS'] = String(Math.min(rawTimeout, maximumRequestTimeoutMs));

  // Retries (bounded)
  const rawRetries = endpoint.maxRetries ?? defaultMaxRetries;
  overlayEnv['CLAUDE_CODE_MAX_RETRIES'] = String(Math.min(rawRetries, maximumMaxRetries));

  return {
    environment: { ...baseEnv, ...overlayEnv },
    secretVariableNames: Array.from(secretVarNames),
    degradedCapabilities
  };
}

// ---------------------------------------------------------------------------
// Redaction types
// ---------------------------------------------------------------------------

export interface RedactProviderRequestInput {
  readonly request: ProviderRequest;
  readonly knownSecretValues?: readonly string[];
  readonly sensitiveHeaderNames?: readonly string[];
}

export interface RedactProviderResponseInput {
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly knownSecretValues?: readonly string[];
}

export interface RedactProcessLaunchConfigInput {
  readonly launchResult: ClaudeProcessLaunchResult;
  readonly knownSecretValues?: readonly string[];
  readonly additionalMeta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

function redactString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

function redactHeaderValue(
  name: string,
  value: string,
  secrets: readonly string[],
  sensitiveNames: ReadonlySet<string>
): string {
  if (sensitiveNames.has(name.toLowerCase())) return '[REDACTED]';
  return redactString(value, secrets);
}

function redactHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  secrets: readonly string[],
  sensitiveNames: ReadonlySet<string>
): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, redactHeaderValue(k, v, secrets, sensitiveNames)])
  );
}

// ---------------------------------------------------------------------------
// redactProviderRequestForLog
// ---------------------------------------------------------------------------

export function redactProviderRequestForLog(input: RedactProviderRequestInput): JsonValue {
  const { request, knownSecretValues = [], sensitiveHeaderNames = [] } = input;
  const sensitiveSet = new Set([
    ...sensitiveHeaderNames.map((h) => h.toLowerCase()),
    'authorization',
    'x-api-key',
    'x-auth-token',
    'x-goog-api-key'
  ]);

  const redactedUrl = redactString(request.url, knownSecretValues);
  const redactedHeaders = redactHeaders(request.headers, knownSecretValues, sensitiveSet);

  // Redact body by serializing and replacing secrets (safe approach)
  let redactedBody: JsonValue = undefined;
  if (request.body !== undefined) {
    try {
      let bodySerialized = JSON.stringify(request.body);
      for (const secret of knownSecretValues) {
        if (secret.length > 0) {
          bodySerialized = bodySerialized.split(secret).join('[REDACTED]');
        }
      }
      redactedBody = JSON.parse(bodySerialized) as JsonValue;
    } catch {
      redactedBody = '[non-serializable body]';
    }
  }

  return {
    url: redactedUrl,
    method: request.method,
    headers: redactedHeaders,
    ...(redactedBody !== undefined ? { body: redactedBody } : {})
  } as JsonValue;
}

// ---------------------------------------------------------------------------
// redactProviderResponseForLog
// ---------------------------------------------------------------------------

export function redactProviderResponseForLog(input: RedactProviderResponseInput): JsonValue {
  const { statusCode, headers, knownSecretValues = [] } = input;
  const sensitiveSet = new Set(['authorization', 'set-cookie', 'x-api-key', 'x-auth-token']);

  const redactedHeaders = redactHeaders(headers, knownSecretValues, sensitiveSet);

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    headers: redactedHeaders
  } as JsonValue;
}

// ---------------------------------------------------------------------------
// redactProcessLaunchConfigForLog
// ---------------------------------------------------------------------------

export function redactProcessLaunchConfigForLog(input: RedactProcessLaunchConfigInput): JsonValue {
  const { launchResult, knownSecretValues = [], additionalMeta } = input;

  const secretSet = new Set(launchResult.secretVariableNames);
  const allSecrets = [...knownSecretValues];

  const redactedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(launchResult.environment)) {
    if (secretSet.has(k)) {
      redactedEnv[k] = '[REDACTED]';
    } else {
      redactedEnv[k] = redactString(v, allSecrets);
    }
  }

  const result: Record<string, JsonValue> = {
    environment: redactedEnv,
    secretVariableNames: [...launchResult.secretVariableNames],
    degradedCapabilities: launchResult.degradedCapabilities.map((d) => ({
      capability: d.capability,
      reason: d.reason,
      required: d.required
    }))
  };
  if (additionalMeta) {
    result['meta'] = additionalMeta as JsonValue;
  }
  return result as JsonValue;
}
