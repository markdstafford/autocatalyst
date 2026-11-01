/**
 * Per-spec fake-mode control plane for the `web` end-to-end tests.
 *
 * Each server runs the real production entrypoint (`apps/control-plane/dist`) as
 * a child process in fake mode on a free port with a fresh temporary state
 * directory, serving the built web client (`apps/web/dist`) from its own origin.
 * A spec reaches the
 * server only through that entrypoint — this module imports nothing from
 * `apps/control-plane` (the `type:app` / `scope:web` tags forbid depending on
 * another app), and it never calls the `serve-fake` or `seed-fake` Nx targets,
 * because `serve-fake` removes the shared `.autocatalyst-fake/` directory.
 *
 * The control surface is the state directory on disk (see
 * `docs/operators/fake-mode.md`): the scripted-launch counter, the pull request
 * state files, and the scripted-failure files. The helpers below are the only
 * sanctioned way for a spec to read or write those files — specs do not build
 * paths themselves.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { test as base, expect } from '@playwright/test';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Repository-relative paths (derived from this file, not from the cwd)
// ---------------------------------------------------------------------------

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// e2e/fixtures -> e2e -> web -> apps -> <repo root>
const REPO_ROOT = resolve(THIS_DIR, '..', '..', '..', '..');
const CONTROL_PLANE_MAIN = join(REPO_ROOT, 'apps/control-plane/dist/src/main.js');
const SEED_ENTRY = join(REPO_ROOT, 'apps/control-plane/dist/src/fake/seed-fake.js');
// The default client the control plane serves is the real built web app
// (`apps/web/dist`), produced by the `web:build` dependency of the e2e target.
const DEFAULT_CLIENT_DIR = join(REPO_ROOT, 'apps/web/dist');

const DEFAULT_BEARER_TOKEN = 'fake-mode-token';
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One JSON line the seed entry prints for a scenario. */
export interface SeedResult {
  readonly runId: string;
  readonly issueNumber: number;
  readonly step: string;
  readonly pullRequestNumber: number | null;
  readonly pullRequestStateFile?: string | null;
}

/** A running fake-mode control plane the spec owns for its lifetime. */
export interface FakeServer {
  /** Base URL, e.g. `http://127.0.0.1:4111`. */
  readonly baseUrl: string;
  /** Bearer token the server accepts on `/v1` routes. */
  readonly bearerToken: string;
  /** Absolute path to this server's fresh state directory. */
  readonly stateDir: string;
  /** Stop the process and remove the temporary state directory. Idempotent. */
  stop(): Promise<void>;
  /**
   * Stop and start again on the same port with the same state directory and
   * database, so a spec can test reconnection and persistence.
   */
  restart(): Promise<void>;
  /** Read the scripted-launch counter (`counters/launch.count`); 0 when absent. */
  readLaunchCount(): Promise<number>;
  /** Read a pull request state word (`pull-requests/<n>.state`); null when absent. */
  readPullRequestState(pullRequestNumber: number): Promise<string | null>;
  /** Write a pull request state word (`open` | `merged` | `closed`). */
  writePullRequestState(pullRequestNumber: number, state: string): Promise<void>;
  /** Write a scripted-failure file (`failures/issue-<n>.json`). */
  writeFailure(issueNumber: number, step: string): Promise<void>;
  /**
   * Run the built seed entry against this server and return the JSON it prints.
   * Imports nothing from the control plane — it spawns the built script.
   */
  seed(input: { scenario: string; issue?: number }): Promise<SeedResult>;
}

/** Overrides for an individual server (all optional). */
export interface StartFakeServerOptions {
  readonly bearerToken?: string;
  /** Absolute client directory to serve. Defaults to the built web app (apps/web/dist). */
  readonly clientDir?: string;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) {
          rejectPort(new Error('could not acquire a free port'));
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/**
 * Build the child environment. Strip any inherited control-plane / fake-mode
 * settings so a server started from inside another run is fully deterministic;
 * every setting it uses is passed explicitly as a flag.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AUTOCATALYST_') || key.startsWith('CONTROL_PLANE_')) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

async function waitForHealth(
  baseUrl: string,
  isAlive: () => boolean,
  lastOutput: () => string
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error(
        `control plane exited before it became healthy at ${baseUrl}\n${lastOutput()}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(150);
  }
  throw new Error(`control plane did not become healthy within ${HEALTH_TIMEOUT_MS}ms at ${baseUrl}`);
}

// ---------------------------------------------------------------------------
// FakeServer implementation
// ---------------------------------------------------------------------------

class FakeServerProcess implements FakeServer {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly stateDir: string;

  readonly #port: number;
  readonly #clientDir: string;
  #child: ChildProcess | undefined;
  #output = '';

  constructor(options: {
    port: number;
    stateDir: string;
    bearerToken: string;
    clientDir: string;
  }) {
    this.#port = options.port;
    this.stateDir = options.stateDir;
    this.bearerToken = options.bearerToken;
    this.#clientDir = options.clientDir;
    this.baseUrl = `http://127.0.0.1:${options.port}`;
  }

  async start(): Promise<void> {
    this.#spawn();
    await waitForHealth(
      this.baseUrl,
      () => this.#child !== undefined && this.#child.exitCode === null,
      () => this.#output
    );
  }

  #spawn(): void {
    this.#output = '';
    const child = spawn(
      execPath,
      [
        CONTROL_PLANE_MAIN,
        '--fake-mode',
        '--port',
        String(this.#port),
        '--bearer-token',
        this.bearerToken,
        '--fake-state-dir',
        this.stateDir,
        '--client-dir',
        this.#clientDir
      ],
      { cwd: REPO_ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const capture = (chunk: Buffer): void => {
      this.#output += chunk.toString();
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    this.#child = child;
  }

  #stopProcess(): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null) {
      this.#child = undefined;
      return Promise.resolve();
    }
    return new Promise((resolveStop) => {
      const forceKill = setTimeout(() => {
        child.kill('SIGKILL');
      }, STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(forceKill);
        this.#child = undefined;
        resolveStop();
      });
      child.kill('SIGTERM');
    });
  }

  async restart(): Promise<void> {
    await this.#stopProcess();
    this.#spawn();
    await waitForHealth(
      this.baseUrl,
      () => this.#child !== undefined && this.#child.exitCode === null,
      () => this.#output
    );
  }

  async stop(): Promise<void> {
    await this.#stopProcess();
    await rm(this.stateDir, { recursive: true, force: true });
  }

  async readLaunchCount(): Promise<number> {
    const file = join(this.stateDir, 'counters', 'launch.count');
    if (!existsSync(file)) {
      return 0;
    }
    const raw = (await readFile(file, 'utf-8')).trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  async readPullRequestState(pullRequestNumber: number): Promise<string | null> {
    const file = join(this.stateDir, 'pull-requests', `${pullRequestNumber}.state`);
    if (!existsSync(file)) {
      return null;
    }
    return (await readFile(file, 'utf-8')).trim();
  }

  async writePullRequestState(pullRequestNumber: number, state: string): Promise<void> {
    const dir = join(this.stateDir, 'pull-requests');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${pullRequestNumber}.state`), `${state}\n`, 'utf-8');
  }

  async writeFailure(issueNumber: number, step: string): Promise<void> {
    const dir = join(this.stateDir, 'failures');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `issue-${issueNumber}.json`),
      `${JSON.stringify({ step })}\n`,
      'utf-8'
    );
  }

  async seed(input: { scenario: string; issue?: number }): Promise<SeedResult> {
    const args = [SEED_ENTRY, '--scenario', input.scenario];
    if (input.issue !== undefined) {
      args.push('--issue', String(input.issue));
    }
    args.push(
      '--base-url',
      this.baseUrl,
      '--bearer-token',
      this.bearerToken,
      '--fake-state-dir',
      this.stateDir,
      '--json'
    );
    const { stdout } = await execFileAsync(execPath, args, { cwd: REPO_ROOT });
    const line = stdout
      .trim()
      .split('\n')
      .filter((entry) => entry.length > 0)
      .pop();
    if (line === undefined) {
      throw new Error(`seed produced no JSON output for scenario ${input.scenario}`);
    }
    return JSON.parse(line) as SeedResult;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start one fake-mode control plane and wait until it answers `/health`. The
 * caller owns its lifetime and must call `stop()` (the `fakeServer` fixture does
 * this automatically, including after a failing test).
 */
export async function startFakeServer(options: StartFakeServerOptions = {}): Promise<FakeServer> {
  const port = await getFreePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'autocatalyst-web-e2e-'));
  const server = new FakeServerProcess({
    port,
    stateDir,
    bearerToken: options.bearerToken ?? DEFAULT_BEARER_TOKEN,
    clientDir: options.clientDir ?? DEFAULT_CLIENT_DIR
  });
  try {
    await server.start();
  } catch (error) {
    await server.stop();
    throw error;
  }
  return server;
}

/**
 * Playwright `test` extended with a `fakeServer` fixture. Each test gets its own
 * control plane (and so each spec file does too), torn down after the test even
 * when it fails. A spec that needs more than one server at once — for example to
 * prove isolation — calls `startFakeServer` directly.
 */
export const test = base.extend<{ fakeServer: FakeServer }>({
  // Playwright requires the first argument to be an object destructuring pattern
  // so it can track fixture dependencies; this fixture depends on none.
  // eslint-disable-next-line no-empty-pattern
  fakeServer: async ({}, use) => {
    const server = await startFakeServer();
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  }
});

export { expect };
