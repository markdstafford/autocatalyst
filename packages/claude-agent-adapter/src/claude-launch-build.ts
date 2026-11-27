import { execFile } from 'node:child_process';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { claudeSubscriptionEnvironment } from './subscription-auth.js';

const require = createRequire(import.meta.url);
const version = /^\d+\.\d+\.\d+$/u;

async function readClaudeSdkPackage() {
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  return JSON.parse(await readFile(join(dirname(sdkEntry), 'package.json'), 'utf8')) as {
    version?: unknown; claudeCodeVersion?: unknown;
  };
}

export async function readClaudeSdkVersion(): Promise<string | undefined> {
  try {
    const sdk = await readClaudeSdkPackage();
    return typeof sdk.version === 'string' && version.test(sdk.version) ? sdk.version : undefined;
  } catch { return undefined; }
}

/** Identity used by the release list for native fresh launches verified by the disposable fixture. */
export async function readClaudeLaunchBuild(
  authentication: 'api_key' | 'subscription',
  environment: Readonly<Record<string, string>>
): Promise<string | undefined> {
  try {
    const sdk = await readClaudeSdkPackage();
    const cli = authentication === 'subscription'
      ? /^\d+\.\d+\.\d+(?=\s|$)/u.exec((await promisify(execFile)('claude', ['--version'], {
        env: claudeSubscriptionEnvironment(environment), timeout: 5000, maxBuffer: 8192
      })).stdout)?.[0]
      : sdk.claudeCodeVersion;
    if (typeof sdk.version !== 'string' || !version.test(sdk.version) ||
        typeof cli !== 'string' || !version.test(cli)) return undefined;
    return [authentication, sdk.version, cli, process.platform, process.arch].join(':');
  } catch {
    return undefined;
  }
}

/** Pinned SDK's short canonical project key. Do not search other projects or linked worktrees. */
export async function lookupClaudeRootSession(scope: string, cwd: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)) return false;
  try {
    const actual = await realpath(cwd);
    const key = actual.replace(/[^a-zA-Z0-9]/gu, '-');
    // Long keys use a version-specific hash. An unverifiable namespace is a fresh miss.
    if (actual !== cwd || key.length > 200) return false;
    const file = join(scope, 'projects', key, id + '.jsonl');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || await realpath(file) !== file) return false;
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat();
      if (stat.ino !== opened.ino || stat.dev !== opened.dev) return false;
      const bytes = await handle.read(Buffer.alloc(64 * 1024));
      return bytes.buffer.subarray(0, bytes.bytesRead).toString('utf8').split('\n').slice(0, -1).some(line => {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          return row['sessionId'] === id && row['cwd'] === cwd && row['isSidechain'] !== true &&
            (row['type'] === 'user' || row['type'] === 'assistant');
        } catch { return false; }
      });
    } finally { await handle.close(); }
  } catch { return false; }
}
