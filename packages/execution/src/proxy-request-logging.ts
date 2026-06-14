import { mkdir, open, chmod, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProxyRedactionOptions } from './proxy-redaction.js';
import { redactKnownSecretText, redactProxyHeaders } from './proxy-redaction.js';

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
  redaction: ProxyRedactionOptions = {}
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

  // Walk existing intermediate path components before creating directories.
  // mkdir with recursive:true follows symlinks; we must reject symlinked intermediates
  // BEFORE calling mkdir so no directories are created outside the diagnostic root.
  const relParts = path.relative(resolvedRoot, finalLogDir).split(path.sep).filter(Boolean);
  let walkCurrent = resolvedRoot;
  for (const part of relParts) {
    walkCurrent = path.join(walkCurrent, part);
    let entryStats;
    try {
      entryStats = await lstat(walkCurrent);
    } catch {
      break; // component does not exist yet — safe to create
    }
    if (entryStats.isSymbolicLink()) {
      return makeNoopLogger(bodyCaptureBytes);
    }
    // Verify the existing component still resolves inside the root
    try {
      const resolvedEntry = await realpath(walkCurrent);
      if (!resolvedEntry.startsWith(resolvedRoot + path.sep) && resolvedEntry !== resolvedRoot) {
        return makeNoopLogger(bodyCaptureBytes);
      }
    } catch {
      return makeNoopLogger(bodyCaptureBytes);
    }
  }

  // Create directory and verify final containment
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

  // Try to chmod existing directory to 0o700; if we cannot, disable logging
  try {
    await chmod(finalLogDir, 0o700);
  } catch {
    // Cannot ensure directory has safe permissions — disable logging
    return makeNoopLogger(bodyCaptureBytes);
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
      const safeRecord = {
        ...record,
        url: redactKnownSecretText(record.url, redaction),
        headers: redactProxyHeaders({ direction: 'request', headers: record.headers, ...redaction })
      };
      await writeDump(dumpId, 'request.json', safeRecord);
    },
    async writeResponse(dumpId: string, record: ProxyResponseDumpRecord): Promise<void> {
      const safeRecord = {
        ...record,
        headers: redactProxyHeaders({ direction: 'response', headers: record.headers, ...redaction })
      };
      await writeDump(dumpId, 'response.json', safeRecord);
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
