import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhExecError, executeGh } from './gh-exec.js';

async function createFakeGh(dir: string, script: string): Promise<string> {
  const scriptPath = join(dir, 'gh');
  await writeFile(scriptPath, `#!/bin/sh\n${script}`, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe('executeGh', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gh-exec-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns stdout on success and does not include token in result', async () => {
    const fakeJson = JSON.stringify({ number: 71, title: 'test' });
    const ghPath = await createFakeGh(tmpDir, `echo '${fakeJson}'`);

    const result = await executeGh({ args: ['issue', 'view', '71'], token: 'secret-token', executablePath: ghPath });

    expect(result.stdout).toBe(fakeJson + '\n');
    expect(result.stdout).not.toContain('secret-token');
    expect(result.truncated).toBe(false);
  });

  it('sets GH_TOKEN in child environment not in args', async () => {
    const ghPath = await createFakeGh(tmpDir, 'echo "token=$GH_TOKEN"');

    const result = await executeGh({ args: [], token: 'my-secret', executablePath: ghPath });

    expect(result.stdout).toContain('token=my-secret');
  });

  it('maps non-zero exit to GhExecError with safe code', async () => {
    const ghPath = await createFakeGh(tmpDir, 'exit 1');

    await expect(executeGh({ args: [], token: 'tok', executablePath: ghPath })).rejects.toThrow(GhExecError);
  });

  it('does not include token in thrown error', async () => {
    const ghPath = await createFakeGh(tmpDir, 'exit 1');

    try {
      await executeGh({ args: [], token: 'super-secret-token', executablePath: ghPath });
      expect.fail('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-token');
      expect(JSON.stringify(error)).not.toContain('super-secret-token');
    }
  });

  it('maps missing executable to GhExecError', async () => {
    await expect(executeGh({ args: [], token: 'tok', executablePath: '/nonexistent/gh' })).rejects.toThrow(GhExecError);

    await expect(executeGh({ args: [], token: 'tok', executablePath: '/nonexistent/gh' })).rejects.toMatchObject({
      code: 'gh_not_found'
    });
  });

  it('maps timeout to GhExecError with timeout code', async () => {
    const ghPath = await createFakeGh(tmpDir, 'sleep 10');

    await expect(executeGh({ args: [], token: 'tok', executablePath: ghPath, timeoutMs: 100 })).rejects.toMatchObject({
      code: 'gh_timeout'
    });
  });
});
