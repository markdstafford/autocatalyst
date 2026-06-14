import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureBodyChunk, createProxyRequestLogger, extractOutputTokens, parseCapturedBody } from './proxy-request-logging.js';

describe('createProxyRequestLogger', () => {
  it('is disabled by default', async () => {
    const logger = await createProxyRequestLogger({ enabled: false, diagnosticRoot: '/unused' });
    expect(logger.enabled).toBe(false);
  });

  it('writes request and response dumps with restrictive file modes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-'));
    const logger = await createProxyRequestLogger({
      enabled: true,
      diagnosticRoot: root,
      logDir: 'run-1/session-1',
      bodyCaptureBytes: 16
    });

    expect(logger.enabled).toBe(true);
    const dumpId = logger.createDumpId();
    await logger.writeRequest(dumpId, {
      timestamp: '2026-06-13T00:00:00.000Z',
      method: 'POST',
      url: 'https://gateway.example.test/v1/messages',
      headers: { 'api-key': '[redacted]' },
      body: { prompt: 'hello' },
      body_capture_truncated: false
    });
    await logger.writeResponse(dumpId, {
      timestamp: '2026-06-13T00:00:01.000Z',
      status: 200,
      headers: { 'content-type': 'application/json' },
      timing_ms: { headers: 10, first_body_byte: 12, total: 20 },
      body_bytes: 22,
      body_capture_truncated: true,
      output_tokens: 12,
      stream_state: 'completed'
    });

    const requestPath = path.join(root, 'run-1/session-1', `${dumpId}.request.json`);
    const responsePath = path.join(root, 'run-1/session-1', `${dumpId}.response.json`);
    const requestContent = await readFile(requestPath, 'utf8');
    expect(requestContent).not.toContain('secret-token');
    expect(JSON.parse(await readFile(responsePath, 'utf8')).stream_state).toBe('completed');
    expect((await stat(requestPath)).mode & 0o777).toBe(0o600);
  });

  it('disables logging for traversal or symlink escape without throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-outside-'));
    await symlink(outside, path.join(root, 'escape'));

    const traversal = await createProxyRequestLogger({ enabled: true, diagnosticRoot: root, logDir: '../outside' });
    const symlinkEscape = await createProxyRequestLogger({ enabled: true, diagnosticRoot: root, logDir: 'escape' });

    expect(traversal.enabled).toBe(false);
    expect(symlinkEscape.enabled).toBe(false);
  });

  it('disables logging when logDir is an absolute path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-abs-'));
    const logger = await createProxyRequestLogger({ enabled: true, diagnosticRoot: root, logDir: '/tmp/absolute' });
    expect(logger.enabled).toBe(false);
  });

  it('disables logging when logDir points to an existing file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-file-'));
    const filePath = path.join(root, 'not-a-dir');
    await writeFile(filePath, 'data');
    const logger = await createProxyRequestLogger({ enabled: true, diagnosticRoot: root, logDir: 'not-a-dir' });
    expect(logger.enabled).toBe(false);
  });

  it('creates dump directory with 0o700 permissions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-mode-'));
    await createProxyRequestLogger({ enabled: true, diagnosticRoot: root, logDir: 'session-dir' });
    const dirStat = await stat(path.join(root, 'session-dir'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it('disables subsequent writes after a write failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-fail-'));
    const logger = await createProxyRequestLogger({ enabled: true, diagnosticRoot: root });
    const dumpId = logger.createDumpId();

    // Write once so the file exists (making the second open with 'wx' fail)
    await logger.writeRequest(dumpId, {
      timestamp: '2026-01-01T00:00:00.000Z',
      method: 'POST',
      url: 'http://127.0.0.1:1/v1/messages',
      headers: {},
      body_capture_truncated: false
    });

    // Write again with same dumpId — the 'wx' exclusive flag should fail
    // After failure, logger should be disabled
    await logger.writeRequest(dumpId, {
      timestamp: '2026-01-01T00:00:00.001Z',
      method: 'POST',
      url: 'http://127.0.0.1:1/v1/messages',
      headers: {},
      body_capture_truncated: false
    });

    // Subsequent writes should silently no-op (logDisabled = true)
    const newDumpId = logger.createDumpId();
    await expect(logger.writeRequest(newDumpId, {
      timestamp: '2026-01-01T00:00:00.002Z',
      method: 'GET',
      url: 'http://127.0.0.1:1/v1/messages',
      headers: {},
      body_capture_truncated: false
    })).resolves.toBeUndefined();
  });

  it('writes safe response-error dumps', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ac-proxy-log-error-'));
    const logger = await createProxyRequestLogger({ enabled: true, diagnosticRoot: root });
    const dumpId = logger.createDumpId();

    await logger.writeResponseError(dumpId, {
      timestamp: '2026-06-13T00:00:01.000Z',
      error_code: 'proxy_upstream_failed',
      elapsed_ms: 25,
      upstream: { origin: 'https://gateway.example.test' }
    });

    const content = await readFile(path.join(root, `${dumpId}.response-error.json`), 'utf8');
    expect(content).toContain('proxy_upstream_failed');
    expect(content).not.toContain('/var/');
  });
});

describe('body capture helpers', () => {
  it('caps captures and marks truncation while counting full bytes', () => {
    const state = captureBodyChunk(undefined, Buffer.from('abcdef'), 4);
    const next = captureBodyChunk(state, Buffer.from('gh'), 4);
    expect(next.captured.toString('utf8')).toBe('abcd');
    expect(next.bodyBytes).toBe(8);
    expect(next.truncated).toBe(true);
  });

  it('extracts output token counts from known JSON shapes', () => {
    expect(extractOutputTokens({ usage: { output_tokens: 512 } })).toBe(512);
    expect(extractOutputTokens({ usage: { completion_tokens: 13 } })).toBe(13);
  });
});

describe('parseCapturedBody', () => {
  it('returns parsed object for JSON content-type and redacts known secrets', () => {
    const body = Buffer.from(JSON.stringify({ message: 'hello secret-token' }));
    const result = parseCapturedBody(body, 'application/json', { knownSecretValues: ['secret-token'] });
    expect(result).toEqual({ message: 'hello [redacted]' });
  });

  it('returns raw text for non-JSON content-type', () => {
    const body = Buffer.from('plain text body');
    const result = parseCapturedBody(body, 'text/plain', {});
    expect(result).toBe('plain text body');
  });

  it('falls back to text when JSON parsing fails', () => {
    const body = Buffer.from('{ invalid json }');
    const result = parseCapturedBody(body, 'application/json', {});
    expect(typeof result).toBe('string');
  });
});
