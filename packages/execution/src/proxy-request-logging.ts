import { mkdir, open, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProxyRedactionOptions } from './proxy-redaction.js';
import { redactKnownSecretText } from './proxy-redaction.js';

export interface ProxyRequestLoggingOptions {
  readonly enabled: boolean;
  readonly diagnosticRoot: string;
  readonly logDir?: string;
  readonly bodyCaptureBytes?: number;
}

export const DEFAULT_BODY_CAPTURE_BYTES = 65_536; // 64 KiB

export interface ProxyTimingMs {
  readonly headers?: number;
  readonly first_body_byte?: number;
  readonly total?: number;
}

export interface ProxyRequestDumpRecord {
  readonly timestamp: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly body_capture_truncated: boolean;
}

export interface ProxyResponseDumpRecord {
  readonly timestamp: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly timing_ms: ProxyTimingMs;
  readonly body_bytes: number;
  readonly body_capture_truncated: boolean;
  readonly output_tokens?: number;
  readonly stream_state: 'completed' | 'aborted' | 'errored';
}

export interface ProxyResponseErrorDumpRecord {
  readonly timestamp: string;
  readonly error_code: string;
  readonly elapsed_ms: number;
  readonly upstream?: { readonly origin?: string };
}

export interface CapturedBody {
  readonly captured: Buffer;
  readonly bodyBytes: number;
  readonly truncated: boolean;
}

export interface ProxyRequestLogger {
  readonly enabled: boolean;
  readonly logDir?: string;
  readonly bodyCaptureBytes: number;
  createDumpId(): string;
  writeRequest(dumpId: string, record: ProxyRequestDumpRecord): Promise<void>;
  writeResponse(dumpId: string, record: ProxyResponseDumpRecord): Promise<void>;
  writeResponseError(dumpId: string, record: ProxyResponseErrorDumpRecord): Promise<void>;
}

function makeNoopLogger(bodyCaptureBytes: number): ProxyRequestLogger {
  return {
    enabled: false,
    bodyCaptureBytes,
    createDumpId: () => '',
    writeRequest: async () => undefined,
    writeResponse: async () => undefined,
    writeResponseError: async () => undefined
  };
}

export async function createProxyRequestLogger(
  options: ProxyRequestLoggingOptions,
  redaction: ProxyRedactionOptions
): Promise<ProxyRequestLogger> {
  const bodyCaptureBytes = options.bodyCaptureBytes ?? DEFAULT_BODY_CAPTURE_BYTES;

  if (!options.enabled) {
    return makeNoopLogger(bodyCaptureBytes);
  }

  // Resolve and validate diagnostic root
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(options.diagnosticRoot);
  } catch {
    return makeNoopLogger(bodyCaptureBytes);
  }

  // Validate and resolve logDir
  let finalLogDir: string;
  if (options.logDir !== undefined) {
    // Reject absolute paths
    if (path.isAbsolute(options.logDir)) {
      return makeNoopLogger(bodyCaptureBytes);
    }
    // Reject path traversal
    const segments = options.logDir.split(/[\\/]+/u);
    if (segments.includes('..')) {
      return makeNoopLogger(bodyCaptureBytes);
    }
    finalLogDir = path.join(resolvedRoot, options.logDir);
  } else {
    finalLogDir = resolvedRoot;
  }

  // Create directory first if needed, then verify containment
  let resolvedFinal: string;
  try {
    await mkdir(finalLogDir, { recursive: true, mode: 0o700 });
    resolvedFinal = await realpath(finalLogDir);
  } catch {
    return makeNoopLogger(bodyCaptureBytes);
  }

  // Verify containment — also catches symlink escapes because realpath resolves the target
  if (!resolvedFinal.startsWith(resolvedRoot + path.sep) && resolvedFinal !== resolvedRoot) {
    return makeNoopLogger(bodyCaptureBytes);
  }

  // Try to chmod existing directory to 0o700 (best effort)
  try {
    await chmod(finalLogDir, 0o700);
  } catch {
    // Best effort; if chmod fails, we still proceed (may not own the dir)
  }

  let logDisabled = false;

  async function writeDump(dumpId: string, suffix: string, data: unknown): Promise<void> {
    if (logDisabled) return;
    const filePath = path.join(finalLogDir, `${dumpId}.${suffix}`);
    let handle: import('node:fs/promises').FileHandle | undefined;
    try {
      handle = await open(filePath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    } catch {
      logDisabled = true;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return {
    enabled: true,
    logDir: finalLogDir,
    bodyCaptureBytes,
    createDumpId(): string {
      const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
      const suffix = randomBytes(4).toString('hex');
      return `${timestamp}-${suffix}`;
    },
    async writeRequest(dumpId: string, record: ProxyRequestDumpRecord): Promise<void> {
      await writeDump(dumpId, 'request.json', record);
    },
    async writeResponse(dumpId: string, record: ProxyResponseDumpRecord): Promise<void> {
      await writeDump(dumpId, 'response.json', record);
    },
    async writeResponseError(dumpId: string, record: ProxyResponseErrorDumpRecord): Promise<void> {
      await writeDump(dumpId, 'response-error.json', record);
    }
  };
}

export function captureBodyChunk(
  previous: CapturedBody | undefined,
  chunk: Buffer,
  capBytes: number
): CapturedBody {
  const current = previous ?? { captured: Buffer.alloc(0), bodyBytes: 0, truncated: false };
  const bodyBytes = current.bodyBytes + chunk.length;
  const remaining = Math.max(capBytes - current.captured.length, 0);
  const captured = remaining > 0
    ? Buffer.concat([current.captured, chunk.subarray(0, remaining)])
    : current.captured;
  return {
    captured,
    bodyBytes,
    truncated: current.truncated || bodyBytes > capBytes
  };
}

export function parseCapturedBody(
  captured: Buffer,
  contentType: string | undefined,
  redaction: ProxyRedactionOptions
): unknown {
  const text = redactKnownSecretText(captured.toString('utf8'), redaction);
  if (contentType?.toLowerCase().includes('application/json')) {
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }
  return text;
}

export function extractOutputTokens(body: unknown): number | undefined {
  if (body && typeof body === 'object' && 'usage' in body) {
    const usage = (body as { usage?: Record<string, unknown> }).usage;
    const output = usage?.['output_tokens'];
    const completion = usage?.['completion_tokens'];
    if (typeof output === 'number') return output;
    if (typeof completion === 'number') return completion;
  }
  return undefined;
}
