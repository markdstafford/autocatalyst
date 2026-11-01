import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createControlPlaneClient, type ControlPlaneClient } from '@autocatalyst/sdk';

import { FAKE_FIXTURE_PROJECT, SPEC_PASSAGE_A, SPEC_PASSAGE_B, SPEC_REVISION_INSERT } from './constants.js';
import { failureFile, pullRequestStateFile, resolveFakeStatePaths } from './paths.js';

const execFileAsync = promisify(execFile);

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// apps/control-plane/src/fake -> repository root.
const REPO_ROOT = resolve(THIS_DIR, '..', '..', '..', '..');
const CONTROL_PLANE_DIR = resolve(REPO_ROOT, 'apps', 'control-plane');
const MAIN_JS = join(CONTROL_PLANE_DIR, 'dist', 'src', 'main.js');
const NX_BIN = join(REPO_ROOT, 'node_modules', 'nx', 'bin', 'nx.js');

const BEARER_TOKEN = 'fake-mode-token';

interface SpawnedServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly port: number;
  readonly stateDir: string;
}

/**
 * Ensure the built production entrypoint exists. The `test` target depends on `build`,
 * so under `nx test` the artifact is already present and this is a cheap no-op. Only when
 * invoked directly (e.g. `vitest run`) with no prior build do we build here. The build is
 * deliberately NOT run unconditionally: `nx build` spawns many concurrent `tsc` workers,
 * which would starve sibling vitest forks and time their tests out.
 */
async function ensureBuilt(): Promise<void> {
  try {
    await access(MAIN_JS);
    return;
  } catch {
    // Fall through and build.
  }
  await execFileAsync(process.execPath, [NX_BIN, 'build', 'control-plane'], {
    cwd: REPO_ROOT,
    env: { ...process.env, NX_DAEMON: 'false' },
    timeout: 170_000,
    maxBuffer: 32 * 1024 * 1024
  });
  await access(MAIN_JS);
}

/** Spawn the built production entrypoint in fake mode and wait for the readiness line. */
async function spawnServer(): Promise<SpawnedServer> {
  const stateDir = await mkdtemp(join(tmpdir(), 'ac-wiring-'));
  const child = spawn(process.execPath, [MAIN_JS, '--fake-mode', '--fake-state-dir', stateDir, '--port', '0'], {
    cwd: REPO_ROOT,
    env: { ...process.env }
  }) as ChildProcessWithoutNullStreams;

  return await new Promise<SpawnedServer>((resolveReady, rejectReady) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectReady(new Error(`Timed out waiting for fake-mode readiness. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 60_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      const match = /fake-mode ready port=(\d+)/u.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolveReady({ child, port: Number(match[1]), stateDir });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`Entrypoint exited early with code ${code ?? 'null'}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function stopServer(server: SpawnedServer | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }
  await new Promise<void>((resolveStop) => {
    server.child.once('exit', () => resolveStop());
    server.child.kill('SIGTERM');
    setTimeout(() => {
      server.child.kill('SIGKILL');
      resolveStop();
    }, 5_000);
  });
}

async function createSecretAndProject(client: ControlPlaneClient): Promise<string> {
  const { handle } = await client.createSecret({ value: 'fake-token' });
  const project = await client.createProject({
    displayName: FAKE_FIXTURE_PROJECT.displayName,
    repoUrl: FAKE_FIXTURE_PROJECT.repoUrl,
    hostRepository: {
      provider: FAKE_FIXTURE_PROJECT.hostRepository.provider,
      owner: FAKE_FIXTURE_PROJECT.hostRepository.owner,
      name: FAKE_FIXTURE_PROJECT.hostRepository.name
    },
    issueTrackerSetting: { provider: FAKE_FIXTURE_PROJECT.issueTrackerProvider, credentialRef: { id: handle, purpose: 'issue_tracker' } },
    codeHostSetting: { provider: FAKE_FIXTURE_PROJECT.codeHostProvider, credentialRef: { id: handle, purpose: 'code_host' } },
    credentialRefs: [{ id: handle, purpose: 'repo' }]
  });
  return project.id;
}

async function startRun(client: ControlPlaneClient, projectId: string, issueNumber: number): Promise<string> {
  const response = await client.createConversationWithFirstRun({
    projectId,
    identity: 'full-wiring-test',
    topic: { title: `Work on issue ${issueNumber}` },
    submission: { kind: 'issue_reference', body: `please work on issue ${issueNumber}`, issue: { number: issueNumber } }
  });
  return response.run.id;
}

async function waitForStep(client: ControlPlaneClient, runId: string, step: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await client.getRun(runId);
    last = run.currentStep;
    if (run.currentStep === step) {
      return;
    }
    if (run.currentStep === 'failed' && step !== 'failed') {
      throw new Error(`Run ${runId} failed while waiting for ${step}: ${run.failureReason ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${step}; last step was ${last}.`);
}

function codePointIndex(haystack: string, needle: string): number {
  const byteIndex = haystack.indexOf(needle);
  return byteIndex < 0 ? -1 : [...haystack.slice(0, byteIndex)].length;
}

async function waitForRevisedSpec(client: ControlPlaneClient, runId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await client.getRun(runId);
    if (run.currentStep === 'spec.human_review') {
      const spec = await client.getRunSpec(runId);
      if (spec.markdown.includes(SPEC_REVISION_INSERT.trimEnd())) {
        return spec.markdown;
      }
    } else if (run.currentStep === 'failed') {
      throw new Error(`Run ${runId} failed while waiting for the revised spec: ${run.failureReason ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for the revised spec for run ${runId}.`);
}

describe('production entrypoint fake-mode wiring (spawned child process)', () => {
  let server: SpawnedServer | undefined;
  let client: ControlPlaneClient;
  let projectId: string;

  beforeAll(async () => {
    await ensureBuilt();
    server = await spawnServer();
    client = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${server.port}`, bearerToken: BEARER_TOKEN });
    projectId = await createSecretAndProject(client);
  }, 200_000);

  afterAll(async () => {
    await stopServer(server);
  });

  it('drives a feature run from issue intake through anchored feedback to done over real HTTP', async () => {
    const stateDir = server!.stateDir;
    const runId = await startRun(client, projectId, 1);

    await waitForStep(client, runId, 'spec.human_review');

    // First spec pass contains passage B; anchor feedback to passage A.
    const firstSpec = await client.getRunSpec(runId);
    expect(firstSpec.markdown).toContain(SPEC_PASSAGE_B);
    const aBefore = codePointIndex(firstSpec.markdown, SPEC_PASSAGE_A);
    expect(aBefore).toBeGreaterThanOrEqual(0);

    await client.replyToRun(runId, {
      kind: 'feedback',
      title: 'Clarify name trimming',
      body: 'Please state how surrounding whitespace in a name is handled.',
      anchor: {
        kind: 'artifact_range',
        artifactId: firstSpec.artifact.id,
        from: aBefore,
        to: aBefore + [...SPEC_PASSAGE_A].length,
        quotedText: SPEC_PASSAGE_A
      }
    });

    const revised = await waitForRevisedSpec(client, runId);
    expect(revised).toContain(SPEC_REVISION_INSERT.trimEnd());
    expect(revised).not.toContain(SPEC_PASSAGE_B);
    expect(revised.trimEnd().endsWith('Pass 2.')).toBe(true);

    // Approve the spec gate, then the implementation gate, reaching the PR gate.
    await client.replyToRun(runId, { kind: 'approve', body: 'Approved spec.' });
    await waitForStep(client, runId, 'implementation.human_review');
    await client.replyToRun(runId, { kind: 'approve', body: 'Approved implementation.' });
    await waitForStep(client, runId, 'pr.human_review');

    // Flip the PR state file to merged and reconcile; the run reaches done.
    const { pullRequest } = await client.getRunPullRequest(runId);
    expect(pullRequest.number).toBe(101);
    const paths = resolveFakeStatePaths(stateDir);
    await writeFile(pullRequestStateFile(paths, pullRequest.number), 'merged\n', 'utf-8');
    await client.reconcilePullRequests();

    await waitForStep(client, runId, 'done');
  }, 180_000);

  it('fails a run when a failure file targets spec.author', async () => {
    const stateDir = server!.stateDir;
    const paths = resolveFakeStatePaths(stateDir);
    await mkdir(paths.failuresDir, { recursive: true });
    await writeFile(failureFile(paths, 6), JSON.stringify({ step: 'spec.author' }), 'utf-8');

    const runId = await startRun(client, projectId, 6);
    await waitForStep(client, runId, 'failed');

    const run = await client.getRun(runId);
    expect(run.currentStep).toBe('failed');
    expect(typeof run.failureReason).toBe('string');
    expect((run.failureReason ?? '').length).toBeGreaterThan(0);
  }, 180_000);
});
