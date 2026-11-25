import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { clientRunEventSchema, type ClientRunEvent } from '@autocatalyst/api-contract';
import { createControlPlaneClient } from '@autocatalyst/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readControlPlaneAppConfig } from '../config.js';
import { startControlPlaneServer, type ControlPlaneServerHandle } from '../server.js';
import { FAKE_FIXTURE_PROJECT } from './constants.js';
import { parseSeedArgs, runScenario } from './seed-fake.js';

let stateDir: string;
let server: ControlPlaneServerHandle;
let client: ReturnType<typeof createControlPlaneClient>;
let projectId: string;
const AUTHOR = 'spec.author';

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ac-activity-stream-'));
  server = await startControlPlaneServer(readControlPlaneAppConfig(['--port', '0', '--fake-mode', '--fake-state-dir', stateDir], {}));
  client = createControlPlaneClient({ baseUrl: `http://127.0.0.1:${server.port}`, bearerToken: 'fake-mode-token' });
  const { handle } = await client.createSecret({ value: 'fake-token' });
  const { displayName, repoUrl, hostRepository } = FAKE_FIXTURE_PROJECT;
  const project = await client.createProject({
    displayName, repoUrl, hostRepository,
    issueTrackerSetting: { provider: 'github', credentialRef: { id: handle, purpose: 'issue_tracker' } },
    codeHostSetting: { provider: 'github', credentialRef: { id: handle, purpose: 'code_host' } },
    credentialRefs: [{ id: handle, purpose: 'repo' }]
  });
  projectId = project.id;
});

afterAll(async () => {
  await server?.close();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

async function collect(runId: string, signal: AbortSignal, stop: (event: ClientRunEvent) => boolean): Promise<ClientRunEvent[]> {
  const { response } = await client.subscribeRunEvents(runId, { replay: 'retained', signal });
  const events: ClientRunEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return events;
      buffered += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffered.indexOf('\n\n')) !== -1) {
        const body = buffered.slice(0, boundary).split('\n').find(line => line.startsWith('data: '));
        buffered = buffered.slice(boundary + 2);
        if (!body) continue;
        const event = clientRunEventSchema.parse(JSON.parse(body.slice(6)));
        events.push(event);
        if (stop(event)) return events;
      }
    }
  } finally {
    await reader.cancel();
  }
}

it('replays the mapped assistant, tool, and progress prelude for a seeded spec author', async () => {
  const { runId } = await runScenario(client, projectId, 'spec-review', parseSeedArgs(['--scenario', 'spec-review'], {}));
  const events = await collect(runId, AbortSignal.timeout(5_000), event =>
    event.type === 'run_state_transition' && event.runStep.step === 'spec.human_review');
  const authorTypes = events.filter(event => 'step' in event && event.step === AUTHOR).map(event => event.type);
  expect(authorTypes).toEqual(expect.arrayContaining(['runner_assistant_turn', 'runner_tool_activity', 'runner_progress']));
}, 15_000);

it('publishes per-second progress during a one-shot delay before a session is recorded', async () => {
  const delayMs = 2_000;
  const delay = join(stateDir, 'delays', 'issue-7.json');
  const control = JSON.stringify({ step: AUTHOR, ms: delayMs });
  await writeFile(delay, control, 'utf8');
  const { run } = await client.createConversationWithFirstRun({
    projectId, identity: 'activity-delay-test', topic: { title: 'Delayed fixture' },
    submission: { kind: 'issue_reference', body: 'Work on issue 7', issue: { number: 7 } }
  });
  const stream = collect(run.id, AbortSignal.timeout(10_000), event =>
    event.type === 'run_state_transition' && event.runStep.step === 'spec.human_review');
  const step = async () => {
    const snapshot = await client.getRun(run.id);
    return snapshot.currentStep;
  };
  // The rename proves the author launch claimed the control file.
  await expect.poll(() => readFile(delay + '.fired', 'utf8').catch(() => '')).toBe(control);
  expect(await step()).toBe(AUTHOR);
  expect((await client.listRunSessions(run.id)).sessions).toHaveLength(0);
  await setTimeout(900);
  expect(await step()).toBe(AUTHOR);
  expect((await client.listRunSessions(run.id)).sessions).toHaveLength(0);
  const events = await stream;
  const delayed = events.filter(event => event.type === 'runner_progress' && event.step === AUTHOR &&
    event.progress.kind === 'task_progress' && event.progress.total === 2);
  expect(delayed.map(event => 'progress' in event && event.progress)).toEqual([
    { kind: 'task_progress', label: 'Session progress', completed: 1, total: 2 },
    { kind: 'task_progress', label: 'Session progress', completed: 2, total: 2 }
  ]);
  const launch = events.find(event => event.type === 'runner_assistant_turn' && event.step === AUTHOR);
  const conclusion = events.find(event => event.type === 'runner_terminal_result' && event.step === AUTHOR);
  expect(conclusion && launch && Date.parse(conclusion.createdAt) - Date.parse(launch.createdAt)).toBeGreaterThanOrEqual(delayMs - 2);
  expect(await step()).toBe('spec.human_review');
  const [author] = (await client.listRunSessions(run.id)).sessions;
  expect(author?.durationMs).toBeGreaterThanOrEqual(delayMs);
}, 15_000);
