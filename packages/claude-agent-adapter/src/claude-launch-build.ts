import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { claudeSubscriptionEnvironment } from './subscription-auth.js';

const require = createRequire(import.meta.url);
const version = /^\d+\.\d+\.\d+$/u;

/** Identity used by the release list for native fresh launches verified by the disposable fixture. */
export async function readClaudeLaunchBuild(
  authentication: 'api_key' | 'subscription',
  environment: Readonly<Record<string, string>>
): Promise<string | undefined> {
  try {
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const sdk = JSON.parse(await readFile(join(dirname(sdkEntry), 'package.json'), 'utf8')) as {
      version?: unknown; claudeCodeVersion?: unknown;
    };
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
