import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ControlPlaneClientError, createControlPlaneClient, type ControlPlaneClient } from '@autocatalyst/sdk';

import {
  FAKE_FIXTURE_PROJECT,
  FAKE_SCENARIOS,
  FAKE_SCENARIO_DEFINITIONS,
  type FakeScenario
} from './constants.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4010';
const DEFAULT_BEARER_TOKEN = 'fake-mode-token';
const DEFAULT_FAKE_STATE_DIR = '.autocatalyst-fake';
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 150;

export interface SeedArgs {
  readonly scenario: FakeScenario | 'all';
  readonly issue?: number;
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly fakeStateDir: string;
  readonly json: boolean;
}

export interface SeedResult {
  readonly scenario: FakeScenario;
  readonly runId: string;
  readonly issueNumber: number;
  readonly step: string;
  readonly pullRequestNumber: number | null;
  readonly pullRequestStateFile: string | null;
}

export class SeedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly jsonLine?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SeedError';
  }
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) {
    return undefined;
  }
  return argv[index + 1];
}

export function parseSeedArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SeedArgs {
  const scenarioRaw = readFlag(argv, '--scenario');
  if (scenarioRaw === undefined) {
    throw new SeedError('Missing required --scenario. Use one of: ' + [...FAKE_SCENARIOS, 'all'].join(', '), 1);
  }
  const scenario = scenarioRaw as FakeScenario | 'all';
  if (scenario !== 'all' && !FAKE_SCENARIOS.includes(scenario as FakeScenario)) {
    throw new SeedError(`Unknown scenario "${scenarioRaw}". Use one of: ${[...FAKE_SCENARIOS, 'all'].join(', ')}`, 1);
  }

  const issueRaw = readFlag(argv, '--issue');
  let issue: number | undefined;
  if (issueRaw !== undefined) {
    issue = Number(issueRaw);
    if (!Number.isInteger(issue) || issue < 1) {
      throw new SeedError('--issue must be a positive integer.', 1);
    }
  }

  const baseUrl = readFlag(argv, '--base-url') ?? env['AUTOCATALYST_SEED_URL'] ?? DEFAULT_BASE_URL;
  const bearerToken = readFlag(argv, '--bearer-token') ?? env['AUTOCATALYST_SEED_TOKEN'] ?? DEFAULT_BEARER_TOKEN;
  const fakeStateDir = readFlag(argv, '--fake-state-dir') ?? DEFAULT_FAKE_STATE_DIR;
  const json = argv.includes('--json');

  return {
    scenario,
    ...(issue !== undefined ? { issue } : {}),
    baseUrl,
    bearerToken,
    fakeStateDir,
    json
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSecretAndProject(client: ControlPlaneClient): Promise<string> {
  const { projects } = await client.listProjects();
  const existing = projects.find((project) => project.displayName === FAKE_FIXTURE_PROJECT.displayName);
  if (existing !== undefined) {
    return existing.id;
  }

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

async function assertNoExistingRun(client: ControlPlaneClient, issueNumber: number, scenario: FakeScenario): Promise<void> {
  const { runs } = await client.listRuns();
  const existing = runs.find((run) => run.trackedIssue?.number === issueNumber);
  if (existing !== undefined) {
    throw new SeedError(`Issue ${issueNumber} already has a run.`, 2, {
      error: 'issue_already_has_run',
      issueNumber,
      scenario
    });
  }
}

async function waitForStep(client: ControlPlaneClient, runId: string, step: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const run = await client.getRun(runId);
    last = run.currentStep;
    if (run.currentStep === step) {
      return;
    }
    if (run.currentStep === 'failed' && step !== 'failed') {
      throw new SeedError(`Run ${runId} failed while waiting for ${step}: ${run.failureReason ?? 'unknown'}`, 1);
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new SeedError(`Timed out waiting for run ${runId} to reach ${step}; last step was ${last}.`, 1);
}

async function startRun(client: ControlPlaneClient, projectId: string, issueNumber: number): Promise<string> {
  const response = await client.createConversationWithFirstRun({
    projectId,
    identity: 'seed-fake',
    topic: { title: `Work on issue ${issueNumber}` },
    submission: { kind: 'issue_reference', body: `please work on issue ${issueNumber}`, issue: { number: issueNumber } }
  });
  return response.run.id;
}

async function approve(client: ControlPlaneClient, runId: string): Promise<void> {
  await client.replyToRun(runId, { kind: 'approve', body: 'Approved by seed-fake.' });
}

/** Drive a single scenario to its documented stopped state. */
export async function runScenario(
  client: ControlPlaneClient,
  projectId: string,
  scenario: FakeScenario,
  args: SeedArgs
): Promise<SeedResult> {
  const definition = FAKE_SCENARIO_DEFINITIONS[scenario];
  const issueNumber = args.issue ?? definition.issueNumber;

  await assertNoExistingRun(client, issueNumber, scenario);

  if (scenario === 'failed') {
    const failuresDir = join(args.fakeStateDir, 'failures');
    await mkdir(failuresDir, { recursive: true });
    await writeFile(join(failuresDir, `issue-${issueNumber}.json`), JSON.stringify({ step: 'spec.author' }), 'utf-8');
    const runId = await startRun(client, projectId, issueNumber);
    await waitForStep(client, runId, 'failed');
    return { scenario, runId, issueNumber, step: 'failed', pullRequestNumber: null, pullRequestStateFile: null };
  }

  const runId = await startRun(client, projectId, issueNumber);

  if (scenario === 'spec-review') {
    await waitForStep(client, runId, 'spec.human_review');
    return { scenario, runId, issueNumber, step: 'spec.human_review', pullRequestNumber: null, pullRequestStateFile: null };
  }

  if (scenario === 'implementation-review') {
    await waitForStep(client, runId, 'spec.human_review');
    await approve(client, runId);
    await waitForStep(client, runId, 'implementation.human_review');
    return { scenario, runId, issueNumber, step: 'implementation.human_review', pullRequestNumber: null, pullRequestStateFile: null };
  }

  // pr-open (bug) and merged (chore) both pass implementation.human_review to reach the PR.
  await waitForStep(client, runId, 'implementation.human_review');
  await approve(client, runId);
  await waitForStep(client, runId, 'pr.human_review');

  const { pullRequest } = await client.getRunPullRequest(runId);
  const pullRequestNumber = pullRequest.number;
  const pullRequestStateFile = join(args.fakeStateDir, 'pull-requests', `${pullRequestNumber}.state`);

  if (scenario === 'pr-open') {
    return { scenario, runId, issueNumber, step: 'pr.human_review', pullRequestNumber, pullRequestStateFile };
  }

  // merged: flip the PR state file to merged, reconcile, and drive to done.
  await writeFile(pullRequestStateFile, 'merged\n', 'utf-8');
  await client.reconcilePullRequests();
  await waitForStep(client, runId, 'done');
  return { scenario, runId, issueNumber, step: 'done', pullRequestNumber, pullRequestStateFile };
}

function formatHuman(result: SeedResult): string {
  return [
    `seeded scenario=${result.scenario}`,
    `runId=${result.runId}`,
    `issueNumber=${result.issueNumber}`,
    `step=${result.step}`,
    `pullRequestNumber=${result.pullRequestNumber ?? 'null'}`,
    `pullRequestStateFile=${result.pullRequestStateFile ?? 'null'}`
  ].join(' ');
}

function formatJson(result: SeedResult): string {
  return JSON.stringify({
    runId: result.runId,
    issueNumber: result.issueNumber,
    step: result.step,
    pullRequestNumber: result.pullRequestNumber,
    pullRequestStateFile: result.pullRequestStateFile
  });
}

export interface SeedIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Run the seed command. Returns the process exit code. */
export async function runSeed(args: SeedArgs, io: SeedIo): Promise<number> {
  const client = createControlPlaneClient({ baseUrl: args.baseUrl, bearerToken: args.bearerToken });

  const scenarios: FakeScenario[] = args.scenario === 'all' ? [...FAKE_SCENARIOS] : [args.scenario];

  let projectId: string;
  try {
    projectId = await ensureSecretAndProject(client);
  } catch (error) {
    if (error instanceof ControlPlaneClientError) {
      io.stderr(`seed-fake: server error (${error.status}): ${error.message}`);
      return 1;
    }
    io.stderr(`seed-fake: could not reach control plane at ${args.baseUrl}: ${(error as Error).message}`);
    return 1;
  }

  for (const scenario of scenarios) {
    try {
      const result = await runScenario(client, projectId, scenario, args);
      io.stdout(args.json ? formatJson(result) : formatHuman(result));
    } catch (error) {
      if (error instanceof SeedError) {
        if (args.json && error.jsonLine !== undefined) {
          io.stdout(JSON.stringify(error.jsonLine));
        } else {
          io.stderr(`seed-fake: ${error.message}`);
        }
        return error.exitCode;
      }
      if (error instanceof ControlPlaneClientError) {
        io.stderr(`seed-fake: server error (${error.status}): ${error.message}`);
        return 1;
      }
      io.stderr(`seed-fake: ${(error as Error).message}`);
      return 1;
    }
  }

  return 0;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  let args: SeedArgs;
  try {
    args = parseSeedArgs(argv, env);
  } catch (error) {
    if (error instanceof SeedError) {
      process.stderr.write(`seed-fake: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  return runSeed(args, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`)
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`seed-fake: unexpected error: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
