import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createControlPlaneClient } from '@autocatalyst/sdk';

import { readControlPlaneAppConfig } from '../config.js';
import { startControlPlaneServer, type ControlPlaneServerHandle } from '../server.js';
import { parseSeedArgs, runSeed, type SeedArgs, type SeedIo } from './seed-fake.js';

const openHandles: ControlPlaneServerHandle[] = [];

afterEach(async () => {
  while (openHandles.length > 0) {
    await openHandles.pop()?.close();
  }
});

async function startServer(stateDir: string): Promise<ControlPlaneServerHandle> {
  const config = readControlPlaneAppConfig(['--fake-mode', '--fake-state-dir', stateDir, '--port', '0'], {});
  const handle = await startControlPlaneServer(config);
  openHandles.push(handle);
  return handle;
}

function collectIo(): { io: SeedIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

function baseArgs(port: number, stateDir: string, overrides: Partial<SeedArgs> = {}): SeedArgs {
  return {
    scenario: 'spec-review',
    baseUrl: `http://127.0.0.1:${port}`,
    bearerToken: 'fake-mode-token',
    fakeStateDir: stateDir,
    json: true,
    ...overrides
  };
}

describe('parseSeedArgs', () => {
  it('reads defaults and flags', () => {
    const args = parseSeedArgs(['--scenario', 'pr-open', '--issue', '9', '--json'], {});
    expect(args.scenario).toBe('pr-open');
    expect(args.issue).toBe(9);
    expect(args.json).toBe(true);
    expect(args.baseUrl).toBe('http://127.0.0.1:4010');
    expect(args.bearerToken).toBe('fake-mode-token');
    expect(args.fakeStateDir).toBe('.autocatalyst-fake');
  });

  it('reads base url and token from env when flags absent', () => {
    const args = parseSeedArgs(['--scenario', 'spec-review'], {
      AUTOCATALYST_SEED_URL: 'http://example.test:9999',
      AUTOCATALYST_SEED_TOKEN: 'env-token'
    });
    expect(args.baseUrl).toBe('http://example.test:9999');
    expect(args.bearerToken).toBe('env-token');
  });

  it('rejects an unknown scenario', () => {
    expect(() => parseSeedArgs(['--scenario', 'bogus'], {})).toThrow(/Unknown scenario/u);
  });
});

describe('seed-fake over real HTTP', () => {
  it('seeds all five scenarios in order to their documented states', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-seed-all-'));
    const handle = await startServer(stateDir);
    const { io, stdout } = collectIo();

    const code = await runSeed(baseArgs(handle.port, stateDir, { scenario: 'all' }), io);
    expect(code).toBe(0);
    expect(stdout).toHaveLength(5);

    const results = stdout.map((line) => JSON.parse(line) as { issueNumber: number; step: string; pullRequestNumber: number | null });
    expect(results.map((r) => r.step)).toEqual([
      'spec.human_review',
      'implementation.human_review',
      'pr.human_review',
      'done',
      'failed'
    ]);
    expect(results.map((r) => r.issueNumber)).toEqual([1, 2, 3, 4, 6]);
    // pr-open allocates 101, merged allocates 102.
    expect(results[2]?.pullRequestNumber).toBe(101);
    expect(results[3]?.pullRequestNumber).toBe(102);
  }, 180_000);

  it('re-seeding the same scenario exits with code 2 and prints one error json line', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-seed-dup-'));
    const handle = await startServer(stateDir);

    const first = collectIo();
    expect(await runSeed(baseArgs(handle.port, stateDir, { scenario: 'spec-review' }), first.io)).toBe(0);

    const second = collectIo();
    const code = await runSeed(baseArgs(handle.port, stateDir, { scenario: 'spec-review' }), second.io);
    expect(code).toBe(2);
    expect(second.stdout).toHaveLength(1);
    expect(JSON.parse(second.stdout[0] ?? '{}')).toEqual({ error: 'issue_already_has_run', issueNumber: 1, scenario: 'spec-review' });
  }, 120_000);

  it('preserves runs and pull-request numbering across a restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ac-seed-restart-'));
    const first = await startServer(stateDir);

    const io1 = collectIo();
    expect(await runSeed(baseArgs(first.port, stateDir, { scenario: 'pr-open' }), io1.io)).toBe(0);
    const firstResult = JSON.parse(io1.stdout[0] ?? '{}') as { pullRequestNumber: number };
    expect(firstResult.pullRequestNumber).toBe(101);

    await first.close();
    openHandles.pop();

    // Restart on the same state directory.
    const second = await startServer(stateDir);

    // Existing runs remain listed after restart.
    const client = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${second.port}`, bearerToken: 'fake-mode-token' });
    const { runs } = await client.listRuns();
    expect(runs.some((run) => run.trackedIssue?.number === 3)).toBe(true);

    // The next pr-open-style seed (on a spare bug issue) uses the next PR number.
    const io2 = collectIo();
    expect(await runSeed(baseArgs(second.port, stateDir, { scenario: 'pr-open', issue: 9 }), io2.io)).toBe(0);
    const secondResult = JSON.parse(io2.stdout[0] ?? '{}') as { pullRequestNumber: number; step: string };
    expect(secondResult.step).toBe('pr.human_review');
    expect(secondResult.pullRequestNumber).toBe(102);
  }, 180_000);
});
