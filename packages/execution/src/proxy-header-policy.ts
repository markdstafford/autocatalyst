import type { RunnerEndpointSettings } from '@autocatalyst/api-contract';

export interface HeaderValueFilter {
  readonly headerName: string;
  readonly removeValues: readonly string[];
}

export interface ProxyHeaderPolicyInput {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly endpoint: Pick<RunnerEndpointSettings, 'authHeaderName' | 'headersToStrip' | 'headersToRewrite'>;
  readonly credential?: string;
  readonly headerValueFilters?: readonly HeaderValueFilter[];
  readonly forceIdentityAcceptEncoding?: boolean;
}

export interface ProxyHeaderPolicyResult {
  readonly headers: Record<string, string>;
  readonly strippedHeaders: readonly string[];
  readonly filteredHeaders: readonly string[];
  readonly injectedAuthHeaderName?: string;
}

// Hop-by-hop headers stripped regardless of endpoint settings
const hopByHopHeaders = new Set([
  'connection', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

export function mapLoopbackUrlToUpstream(loopbackUrl: string, upstreamBaseUrl: string): URL {
  let incoming: URL;
  let upstream: URL;
  try {
    upstream = new URL(upstreamBaseUrl);
  } catch {
    throw new Error('proxy_invalid_upstream: Invalid upstream base URL');
  }
  try {
    incoming = new URL(loopbackUrl);
  } catch {
    throw new Error('proxy_request_malformed: Invalid loopback URL');
  }

  // Reject absolute-form requests that attempt to override the upstream host
  if (/^\/https?:\/\//iu.test(incoming.pathname)) {
    throw new Error('proxy_request_malformed: Absolute-form host override not allowed');
  }

  const upstreamPrefix = upstream.pathname.replace(/\/$/u, '');
  const incomingPath = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`;
  const mapped = new URL(upstream.origin);
  mapped.pathname = `${upstreamPrefix}${incomingPath}`.replace(/\/+/gu, '/');
  mapped.search = incoming.search;
  mapped.hash = incoming.hash;
  return mapped;
}

export function applyProxyHeaderPolicy(input: ProxyHeaderPolicyInput): ProxyHeaderPolicyResult {
  const { headers, endpoint, credential, headerValueFilters, forceIdentityAcceptEncoding } = input;
  const strippedHeaders: string[] = [];
  const filteredHeaders: string[] = [];

  // Step 1: Normalize incoming headers (lowercase keys, join arrays with ', ')
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined) continue;
    normalized[key] = Array.isArray(value) ? (value as string[]).join(', ') : value as string;
  }

  // Step 2: Strip hop-by-hop headers
  const working: Record<string, string> = {};
  for (const [name, value] of Object.entries(normalized)) {
    if (hopByHopHeaders.has(name)) {
      strippedHeaders.push(name);
    } else {
      working[name] = value;
    }
  }

  // Step 3: Apply endpoint headersToStrip
  const stripLower = new Set((endpoint.headersToStrip ?? []).map((h) => h.toLowerCase()));
  for (const name of Object.keys(working)) {
    if (stripLower.has(name)) {
      strippedHeaders.push(name);
      delete working[name];
    }
  }

  // Step 4: Apply value-level header filters (exact token matching)
  for (const filter of headerValueFilters ?? []) {
    const filterNameLower = filter.headerName.toLowerCase();
    if (!(filterNameLower in working)) continue;

    const currentValue = working[filterNameLower]!;
    const removeSet = new Set(filter.removeValues);
    // Split on comma, trim each token, remove exact matches
    const tokens = currentValue.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    const remaining = tokens.filter((t) => !removeSet.has(t));

    if (remaining.length < tokens.length) {
      filteredHeaders.push(filterNameLower);
      if (remaining.length === 0) {
        delete working[filterNameLower];
      } else {
        working[filterNameLower] = remaining.join(', ');
      }
    }
  }

  // Step 5: Apply headersToRewrite (additive/replacement in proxy mode)
  for (const [name, value] of Object.entries(endpoint.headersToRewrite ?? {})) {
    working[name.toLowerCase()] = value;
  }

  // Step 6: Inject authHeaderName credential (runs after rewrites so credential wins)
  let injectedAuthHeaderName: string | undefined;
  if (endpoint.authHeaderName !== undefined && credential !== undefined) {
    const nameLower = endpoint.authHeaderName.toLowerCase();
    working[nameLower] = credential;
    injectedAuthHeaderName = nameLower;
  }

  // Step 7: Force accept-encoding: identity when required
  if (forceIdentityAcceptEncoding === true) {
    working['accept-encoding'] = 'identity';
  }

  return {
    headers: working,
    strippedHeaders,
    filteredHeaders,
    ...(injectedAuthHeaderName !== undefined ? { injectedAuthHeaderName } : {})
  };
}
