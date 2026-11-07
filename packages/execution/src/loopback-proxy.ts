import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { RunnerEndpointSettings } from '@autocatalyst/api-contract';
import type { AgentConnectionTelemetryContext } from './agent-provider-adapter.js';
import { applyProxyHeaderPolicy, mapLoopbackUrlToUpstream, type HeaderValueFilter } from './proxy-header-policy.js';
import type { ProxyRequestLoggingOptions, CapturedBody } from './proxy-request-logging.js';
import { createProxyRequestLogger, captureBodyChunk, parseCapturedBody, extractOutputTokens } from './proxy-request-logging.js';
import { redactProxyHeaders } from './proxy-redaction.js';
import type { ProviderConnectionLogger } from './connection.js';
import {
  computeRetryDelayMs,
  defaultRequestTimeoutMs,
  maximumRequestTimeoutMs,
  resolveProxyRetryBudget,
  type ResolvedProxyRetryBudget
} from './request-alteration.js';

export type ProxyFailureCode =
  | 'proxy_start_failed'
  | 'proxy_upstream_failed'
  | 'proxy_invalid_upstream'
  | 'proxy_logging_disabled'
  | 'proxy_request_malformed'
  | 'proxy_request_body_too_large'
  | 'unsupported_required_capability';

export interface SafeProxyErrorEnvelope {
  readonly error: { readonly code: ProxyFailureCode; readonly message: string };
}

// ---------------------------------------------------------------------------
// Safe upstream failure records (metadata-only; never carry bodies, headers,
// prompts, raw messages, secrets, full URLs, or filesystem paths).
// ---------------------------------------------------------------------------

export type ProxyUpstreamFailureOutcome = 'retrying' | 'exhausted' | 'mid_stream' | 'timeout';

export interface ProxyUpstreamFailureRecord {
  readonly profileName?: string;
  /** Origin only (scheme + host + port). Never the full URL, path, or query. */
  readonly upstreamOrigin: string;
  readonly attempt: number;
  readonly outcome: ProxyUpstreamFailureOutcome;
  readonly status?: number;
  /** Safe transport error code such as ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN. */
  readonly errorCode?: string;
  /** Monotonic elapsed time since the retry clock started, in milliseconds. */
  readonly elapsedMs: number;
  readonly responseStarted: boolean;
  readonly bodyBytesStreamed: number;
}

export interface LoopbackProxyOptions {
  readonly upstreamBaseUrl: string;
  readonly endpoint: RunnerEndpointSettings;
  readonly credential?: string;
  readonly headerValueFilters?: readonly HeaderValueFilter[];
  readonly telemetryContext: AgentConnectionTelemetryContext;
  readonly requestTimeoutMs?: number;
  readonly logging?: ProxyRequestLoggingOptions;
  readonly logger?: ProviderConnectionLogger;
  /** Proxy-only retry budget. Defaults to resolveProxyRetryBudget(endpoint). */
  readonly retryBudget?: ResolvedProxyRetryBudget;
  readonly requestBodyBufferLimitBytes?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly jitter?: () => number;
  /** Injected monotonic clock (ms). Budget decisions and elapsedMs come from this, not wall clock. */
  readonly monotonicNow?: () => number;
}

export interface LoopbackProxyHandle {
  readonly baseUrl: string;
  readonly startedAt: string;
  requestCount(): number;
  /**
   * The latest unrecovered safe failure record for this proxy instance, or undefined when none
   * qualifies. Outcomes `exhausted`, `timeout`, and `mid_stream` qualify until a later upstream
   * response completes successfully (which clears the record). A `retrying` record never qualifies.
   */
  unrecoveredFailureRecord(): ProxyUpstreamFailureRecord | undefined;
  close(): Promise<void>;
}

const hopByHopResponseHeaders = new Set([
  'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const defaultRequestBodyBufferLimitBytes = 10 * 1024 * 1024; // 10 MB
const defaultSleepFn = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Only pass through inherently-safe syscall/transport error codes (ALL-CAPS E-codes). This excludes
// any arbitrary SDK-provided message text so no secret or path can leak into a failure record.
const safeTransportErrorCode = /^E[A-Z0-9]+$/u;

function extractSafeErrorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && safeTransportErrorCode.test(code)) return code;
  return undefined;
}

function sendJsonError(res: http.ServerResponse, status: number, envelope: SafeProxyErrorEnvelope): void {
  if (res.headersSent) return;
  const body = JSON.stringify(envelope);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export async function createLoopbackProxy(options: LoopbackProxyOptions): Promise<LoopbackProxyHandle> {
  const { upstreamBaseUrl, endpoint, credential, headerValueFilters } = options;

  // Validate upstream URL eagerly — must be http: or https: only
  let parsedUpstream: URL;
  try {
    parsedUpstream = new URL(upstreamBaseUrl);
  } catch {
    throw new Error('proxy_invalid_upstream: Invalid upstream base URL');
  }
  if (parsedUpstream.protocol !== 'http:' && parsedUpstream.protocol !== 'https:') {
    throw new Error(`proxy_invalid_upstream: Unsupported upstream scheme "${parsedUpstream.protocol}" — only http and https are allowed`);
  }

  const upstreamOrigin = parsedUpstream.origin;
  const profileName = options.telemetryContext.profileName;
  const connectionLogger = options.logger;

  const knownSecretValues = credential !== undefined ? [credential] : [];
  const logger = await createProxyRequestLogger(
    options.logging ?? { enabled: false, diagnosticRoot: '' },
    { knownSecretValues }
  );

  let requestCounter = 0;
  let closed = false;

  // Proxy-instance-scoped unrecovered failure evidence. Set on exhausted/timeout/mid_stream; cleared
  // when any upstream response is committed (connectivity proven) so an earlier recovered blip cannot
  // explain a later unrelated SDK crash. A `retrying` record never sets this.
  let lastUnrecoveredFailure: ProxyUpstreamFailureRecord | undefined;

  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  const server = http.createServer((req, res) => {
    requestCounter += 1;

    const requestStartWallClock = Date.now();
    let dumpId: string | undefined;

    if (logger.enabled) {
      dumpId = logger.createDumpId();
    }

    // Map loopback URL to upstream
    const absoluteUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url ?? '/'}`;
    let upstreamUrl: URL;
    try {
      upstreamUrl = mapLoopbackUrlToUpstream(absoluteUrl, upstreamBaseUrl);
    } catch {
      sendJsonError(res, 400, { error: { code: 'proxy_request_malformed', message: 'Proxy received a malformed request.' } });
      return;
    }

    // Build forwarded headers
    const { headers: forwardHeaders } = applyProxyHeaderPolicy({
      headers: req.headers as Record<string, string | string[] | undefined>,
      endpoint,
      ...(credential !== undefined ? { credential } : {}),
      ...(headerValueFilters !== undefined ? { headerValueFilters } : {}),
      forceIdentityAcceptEncoding: options.logging?.enabled === true
    });

    const isHttps = upstreamUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    const retryBudget = options.retryBudget ?? resolveProxyRetryBudget(endpoint);
    const transientStatuses = retryBudget.transientHttpStatuses;
    const maxRetries = retryBudget.maxRetries; // undefined => budget-controlled only
    const bodyLimit = options.requestBodyBufferLimitBytes ?? defaultRequestBodyBufferLimitBytes;
    const sleepFn = options.sleep ?? defaultSleepFn;
    const jitterFn = options.jitter ?? Math.random;
    const timeoutMs = Math.min(options.requestTimeoutMs ?? defaultRequestTimeoutMs, maximumRequestTimeoutMs);

    // Buffer request body (needed for retry replay)
    let requestCapture: CapturedBody | undefined;
    const bodyChunks: Buffer[] = [];
    let bodyTotal = 0;
    let bodyOverLimit = false;

    req.on('data', (chunk: Buffer) => {
      if (bodyOverLimit) return;
      bodyTotal += chunk.length;
      if (bodyTotal > bodyLimit) {
        bodyOverLimit = true;
        req.resume(); // drain remaining
        sendJsonError(res, 413, { error: { code: 'proxy_request_body_too_large', message: 'Provider proxy request body exceeded retry buffer limit.' } });
        return;
      }
      bodyChunks.push(chunk);
      if (logger.enabled) {
        requestCapture = captureBodyChunk(requestCapture, chunk, logger.bodyCaptureBytes);
      }
    });

    req.on('end', () => {
      if (bodyOverLimit) return;

      const bodyBuffer = Buffer.concat(bodyChunks);

      // Log request (for logging mode)
      if (logger.enabled && dumpId) {
        const contentType = req.headers['content-type'];
        const body = requestCapture
          ? parseCapturedBody(requestCapture.captured, contentType, { knownSecretValues })
          : undefined;
        void logger.writeRequest(dumpId, {
          timestamp: new Date(requestStartWallClock).toISOString(),
          method: req.method ?? 'GET',
          url: upstreamUrl.toString(),
          headers: redactProxyHeaders({ direction: 'request', headers: forwardHeaders, knownSecretValues }),
          body,
          body_capture_truncated: requestCapture?.truncated ?? false
        }).catch(() => undefined);
      }

      // Retry loop
      let attemptNumber = 0;
      // Monotonic retry clock starts before the first proxy attempt.
      const retryStartMono = monotonicNow();
      // Set to true only once we call res.writeHead() to commit headers to the downstream client.
      // At that point the response body may already be streaming and we can no longer retry.
      let responseCommitted = false;
      // True once upstream headers were received for the committed response (used by failure records).
      let responseStarted = false;
      // Count of upstream body bytes streamed downstream before a mid-stream failure (always-on).
      let streamedBytes = 0;
      let clientDisconnected = false;

      res.on('close', () => {
        clientDisconnected = true;
      });

      function elapsedMono(): number {
        return Math.round(monotonicNow() - retryStartMono);
      }

      function buildFailureRecord(
        outcome: ProxyUpstreamFailureOutcome,
        extra: { status?: number; errorCode?: string }
      ): ProxyUpstreamFailureRecord {
        return {
          ...(profileName !== undefined ? { profileName } : {}),
          upstreamOrigin,
          attempt: attemptNumber,
          outcome,
          ...(extra.status !== undefined ? { status: extra.status } : {}),
          ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
          elapsedMs: elapsedMono(),
          responseStarted,
          bodyBytesStreamed: streamedBytes
        };
      }

      function emitFailureRecord(record: ProxyUpstreamFailureRecord): void {
        connectionLogger?.warn('proxy.upstream_failure', record);
      }

      // Decide whether another proxy attempt is allowed given the proposed backoff delay.
      // Pre-response only: once headers are received the proxy never retries.
      function canRetry(delayMs: number): boolean {
        if (clientDisconnected) return false;
        const remaining = retryBudget.budgetMs - (monotonicNow() - retryStartMono);
        if (remaining <= 0) return false;
        if (maxRetries !== undefined && attemptNumber > maxRetries) return false;
        // Honor Retry-After / backoff only when it fits inside the remaining monotonic budget.
        if (delayMs > remaining) return false;
        return true;
      }

      function writeResponseErrorDump(): void {
        if (!logger.enabled || !dumpId) return;
        void logger.writeResponseError(dumpId, {
          timestamp: new Date().toISOString(),
          error_code: 'proxy_upstream_failed',
          elapsed_ms: elapsedMono(),
          upstream: { origin: upstreamOrigin }
        }).catch(() => undefined);
      }

      function attempt(): void {
        if (clientDisconnected) return;
        attemptNumber += 1;
        // Prevents both the response callback and the error handler from both acting on the same attempt
        // (e.g. socket close fires concurrently with the response callback for a transient status).
        // Reset per-attempt so that a fresh attempt after a transient retry can still be handled.
        let attemptResponseHandled = false;
        let timedOut = false;

        // Update content-length to match buffered body
        const attemptHeaders = { ...forwardHeaders, 'content-length': String(bodyBuffer.length) };

        const upstreamReq = requestModule.request(
          upstreamUrl,
          {
            method: req.method,
            headers: attemptHeaders
          },
          (upstreamRes) => {
            if (attemptResponseHandled) return;
            attemptResponseHandled = true;

            const status = upstreamRes.statusCode ?? 200;
            const isTransient = transientStatuses.includes(status);

            if (isTransient) {
              // Drain the body; transient responses are never streamed downstream.
              const retryAfterHeader = upstreamRes.headers['retry-after'];
              const retryAfter = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
              upstreamRes.resume(); // drain
              const delayMs = computeRetryDelayMs({ attemptNumber, retryAfter, jitter: jitterFn(), requestTimeoutMs: timeoutMs });
              if (canRetry(delayMs)) {
                emitFailureRecord(buildFailureRecord('retrying', { status }));
                void sleepFn(delayMs).then(attempt);
                return;
              }
              const record = buildFailureRecord('exhausted', { status });
              lastUnrecoveredFailure = record;
              emitFailureRecord(record);
              sendJsonError(res, 502, { error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' } });
              return;
            }

            // Non-transient — commit to downstream client. After this point we cannot retry, and a
            // committed upstream response proves connectivity: clear any unrecovered blip evidence.
            responseCommitted = true;
            responseStarted = true;
            lastUnrecoveredFailure = undefined;
            if (attemptNumber > 1) {
              connectionLogger?.info('proxy.upstream_retry_success', {
                ...(profileName !== undefined ? { profileName } : {}),
                upstreamOrigin,
                attempt: attemptNumber,
                elapsedMs: elapsedMono()
              });
            }

            const safeHeaders: Record<string, string | string[]> = {};
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
              if (!hopByHopResponseHeaders.has(name.toLowerCase()) && value !== undefined) {
                safeHeaders[name] = value;
              }
            }

            res.writeHead(status, safeHeaders);

            const headersMs = elapsedMono();
            let firstBodyByteMs: number | undefined;
            let responseCapture: CapturedBody | undefined;
            let responseTotalBytes = 0;
            let streamEndWritten = false;
            const upstreamResHeaders = upstreamRes.headers;
            const upstreamStatusCode = status;

            const writeResponseDump = (streamState: 'completed' | 'aborted' | 'errored'): void => {
              if (!logger.enabled || !dumpId) return;
              const totalMs = elapsedMono();
              const contentType = upstreamResHeaders['content-type'];
              const parsedBody = responseCapture
                ? parseCapturedBody(responseCapture.captured, contentType, { knownSecretValues })
                : undefined;
              const outputTokens = extractOutputTokens(parsedBody);
              void logger.writeResponse(dumpId!, {
                timestamp: new Date().toISOString(),
                status: upstreamStatusCode,
                headers: redactProxyHeaders({ direction: 'response', headers: upstreamResHeaders as Record<string, string>, knownSecretValues }),
                timing_ms: {
                  headers: Math.round(headersMs),
                  ...(firstBodyByteMs !== undefined ? { first_body_byte: Math.round(firstBodyByteMs) } : {}),
                  total: Math.round(totalMs)
                },
                body_bytes: responseTotalBytes,
                body_capture_truncated: responseCapture?.truncated ?? false,
                ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
                stream_state: streamState
              }).catch(() => undefined);
            };

            // Stream chunks with backpressure
            upstreamRes.on('data', (chunk: Buffer) => {
              streamedBytes += chunk.length;
              if (logger.enabled) {
                if (firstBodyByteMs === undefined) firstBodyByteMs = elapsedMono();
                responseCapture = captureBodyChunk(responseCapture, chunk, logger.bodyCaptureBytes);
                responseTotalBytes += chunk.length;
              }
              const ok = res.write(chunk);
              if (!ok) {
                upstreamRes.pause();
                res.once('drain', () => upstreamRes.resume());
              }
            });

            upstreamRes.on('end', () => {
              streamEndWritten = true;
              res.end();
              writeResponseDump('completed');
            });

            // Upstream stream error after headers received (e.g. truncated body). Not replayable at the
            // proxy: record a mid_stream failure and destroy the connection as today.
            upstreamRes.on('error', () => {
              const record = buildFailureRecord('mid_stream', {});
              lastUnrecoveredFailure = record;
              emitFailureRecord(record);
              if (!streamEndWritten) {
                streamEndWritten = true;
                writeResponseDump('errored');
              }
              if (!res.headersSent) {
                sendJsonError(res, 502, { error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' } });
              } else {
                res.destroy();
              }
            });

            // Client disconnected before stream completed
            res.on('close', () => {
              if (!streamEndWritten) {
                streamEndWritten = true;
                writeResponseDump('aborted');
              }
              upstreamReq.destroy();
            });
          }
        );

        upstreamReq.setTimeout(timeoutMs, () => {
          timedOut = true;
          upstreamReq.destroy();
        });

        upstreamReq.on('error', (err) => {
          if (attemptResponseHandled) return; // response callback already owns this attempt
          if (responseCommitted) return; // already writing to client, cannot send error envelope
          attemptResponseHandled = true;

          // A pre-response request timeout is a transient connectivity failure. The proxy rides it
          // out within the monotonic retry budget exactly like a transport error, so a short stall
          // (e.g. a sleep/wake Wi-Fi reconnect before any response starts) is absorbed rather than
          // escalated straight to session retry. Only once the budget is unrecovered do we expose a
          // terminal `timeout` record; session-level retry then owns recovery for a stalled upstream.
          if (timedOut) {
            const delayMs = computeRetryDelayMs({ attemptNumber, jitter: jitterFn() });
            if (canRetry(delayMs)) {
              emitFailureRecord(buildFailureRecord('retrying', {}));
              writeResponseErrorDump();
              void sleepFn(delayMs).then(attempt);
              return;
            }
            const record = buildFailureRecord('timeout', {});
            lastUnrecoveredFailure = record;
            emitFailureRecord(record);
            writeResponseErrorDump();
            sendJsonError(res, 502, { error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' } });
            return;
          }

          const errorCode = extractSafeErrorCode(err);
          const delayMs = computeRetryDelayMs({ attemptNumber, jitter: jitterFn() });
          if (canRetry(delayMs)) {
            emitFailureRecord(buildFailureRecord('retrying', { ...(errorCode !== undefined ? { errorCode } : {}) }));
            writeResponseErrorDump();
            void sleepFn(delayMs).then(attempt);
            return;
          }
          const record = buildFailureRecord('exhausted', { ...(errorCode !== undefined ? { errorCode } : {}) });
          lastUnrecoveredFailure = record;
          emitFailureRecord(record);
          writeResponseErrorDump();
          sendJsonError(res, 502, { error: { code: 'proxy_upstream_failed', message: 'Provider proxy upstream request failed.' } });
        });

        upstreamReq.end(bodyBuffer);
      }

      attempt();
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const startedAt = new Date().toISOString();

  return {
    baseUrl,
    startedAt,
    requestCount: () => requestCounter,
    unrecoveredFailureRecord: () => lastUnrecoveredFailure,
    close: async () => {
      if (closed) return;
      closed = true;
      server.close();
      await once(server, 'close');
    }
  };
}
