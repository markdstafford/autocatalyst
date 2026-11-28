import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { Principal } from '@autocatalyst/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { asInternalSqliteDatabase, createDrizzleDomainRepositories, createSqliteDatabase, DrizzleRunRepository } from '@autocatalyst/persistence';

import { readControlPlaneAppConfig } from '../config.js';
import { createControlPlaneServer, type ControlPlaneServerOptions } from '../server.js';
import { createControlPlaneClient } from '@autocatalyst/sdk';
import { DefaultOrchestrator, InMemoryRunEventBus, RunDispatchQueue, type ControlPlaneService } from '@autocatalyst/core';
import { readLaunchCounter } from './launch-context.js';
import * as scriptedResults from './scripted-results.js';
import * as scriptedLaunch from './scripted-launch.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FAKE_FIXTURE_PROJECT,
  FAKE_TENANT,
  SPEC_EMOJI,
  SPEC_OPEN_QUESTIONS_HEADING,
  SPEC_PASSAGE_A,
  SPEC_PASSAGE_B,
  SPEC_PASSAGE_C,
  SPEC_PASSAGE_D,
  SPEC_REVISION_INSERT
} from './constants.js';
import { failureFile, pullRequestStateFile, resolveFakeStatePaths } from './paths.js';

const AUTH = { authorization: 'Bearer fake-mode-token' } as const;

interface Harness {
  readonly app: FastifyInstance;
  readonly stateDir: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    await harness?.app.close();
  }
});

async function startFakeServer(extra: Partial<ControlPlaneServerOptions> = {}): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'ac-fake-'));
  const config = readControlPlaneAppConfig(['--fake-mode', '--fake-state-dir', stateDir], {});
  const app = await createControlPlaneServer({ ...config, ...extra });
  const harness: Harness = { app, stateDir };
  harnesses.push(harness);
  return harness;
}

async function createSecretAndProject(app: FastifyInstance): Promise<string> {
  const secretResp = await app.inject({ method: 'POST', url: '/v1/secrets', headers: AUTH, payload: { value: 'fake-token' } });
  expect(secretResp.statusCode).toBe(201);
  const handle = secretResp.json().handle as string;

  const projectResp = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: AUTH,
    payload: {
      displayName: FAKE_FIXTURE_PROJECT.displayName,
      repoUrl: FAKE_FIXTURE_PROJECT.repoUrl,
      hostRepository: {
        provider: FAKE_FIXTURE_PROJECT.hostRepository.provider,
        owner: FAKE_FIXTURE_PROJECT.hostRepository.owner,
        name: FAKE_FIXTURE_PROJECT.hostRepository.name
      },
      issueTrackerSetting: { provider: 'github', credentialRef: { id: handle, purpose: 'issue_tracker' } },
      codeHostSetting: { provider: 'github', credentialRef: { id: handle, purpose: 'code_host' } },
      credentialRefs: [{ id: handle, purpose: 'repo' }]
    }
  });
  expect(projectResp.statusCode).toBe(201);
  return projectResp.json().id as string;
}

async function startRunFromIssue(app: FastifyInstance, projectId: string, issueNumber: number): Promise<string> {
  const resp = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: AUTH,
    payload: {
      projectId,
      identity: 'fake-mode-test',
      topic: { title: `Work on issue ${issueNumber}` },
      submission: { kind: 'issue_reference', body: `please work on issue ${issueNumber}`, issue: { number: issueNumber } }
    }
  });
  expect(resp.statusCode).toBe(201);
  return resp.json().run.id as string;
}

async function getRun(app: FastifyInstance, runId: string): Promise<{ currentStep: string; waitingOn?: string; failureReason?: string }> {
  const resp = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: AUTH });
  expect(resp.statusCode).toBe(200);
  return resp.json() as { currentStep: string; waitingOn?: string; failureReason?: string };
}

async function waitForStep(app: FastifyInstance, runId: string, step: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await getRun(app, runId);
    last = run.currentStep;
    if (run.currentStep === step) {
      return;
    }
    if (run.currentStep === 'failed' && step !== 'failed') {
      throw new Error(`Run ${runId} failed while waiting for ${step}: ${run.failureReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${step}; last step was ${last}.`);
}

async function approve(app: FastifyInstance, runId: string): Promise<void> {
  const resp = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/replies`, headers: AUTH, payload: { kind: 'approve', body: 'Approved.' } });
  expect(resp.statusCode).toBe(200);
}

async function getSpec(app: FastifyInstance, runId: string): Promise<{ artifactId: string; markdown: string }> {
  const resp = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/spec`, headers: AUTH });
  expect(resp.statusCode).toBe(200);
  const body = resp.json() as { artifact: { id: string }; markdown: string };
  return { artifactId: body.artifact.id, markdown: body.markdown };
}

/** Count of Unicode code points before the first occurrence of `needle`. */
function codePointIndex(haystack: string, needle: string): number {
  const byteIndex = haystack.indexOf(needle);
  if (byteIndex < 0) {
    return -1;
  }
  return [...haystack.slice(0, byteIndex)].length;
}

/** Poll the spec until it reaches the deterministic second (revised) pass. */
async function waitForRevisedSpec(app: FastifyInstance, runId: string, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await getRun(app, runId);
    if (run.currentStep === 'spec.human_review') {
      const { markdown } = await getSpec(app, runId);
      last = markdown;
      if (markdown.includes(SPEC_REVISION_INSERT.trimEnd())) {
        return markdown;
      }
    } else if (run.currentStep === 'failed') {
      throw new Error(`Run ${runId} failed while waiting for the revised spec: ${run.failureReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for run ${runId} to produce the revised spec. Last spec:\n${last}`);
}

it('delays the matched injected failure without recording a session prematurely', async () => {
  const { app, stateDir } = await startFakeServer();
  const projectId = await createSecretAndProject(app);
  const paths = resolveFakeStatePaths(stateDir);
  const issue = 7;
  const step = 'spec.author';
  const control = JSON.stringify({ step, ms: 1_400 });
  await writeFile(join(paths.delaysDir, `issue-${issue}.json`), control, 'utf8');
  await writeFile(join(paths.failuresDir, `issue-${issue}.json`), JSON.stringify({ step }), 'utf8');

  const runId = await startRunFromIssue(app, projectId, issue);
  const sessions = () => app.inject({ method: 'GET', url: `/v1/runs/${runId}/sessions`, headers: AUTH });
  await expect.poll(() => readFile(join(paths.delaysDir, `issue-${issue}.json.fired`), 'utf8').catch(() => ''),
    { timeout: 10_000 }).toBe(control);
  expect((await getRun(app, runId)).currentStep).toBe(step);
  expect((await sessions()).json().sessions).toEqual([]);
  await waitForStep(app, runId, 'failed');
  const [failedSession] = (await sessions()).json().sessions;
  expect(failedSession).toMatchObject({ step, outcome: 'failed' });
  expect(failedSession.durationMs).toBeGreaterThanOrEqual(1_400);
}, 30_000);

describe('fake mode end-to-end (in-process)', () => {
  it('drives a feature run from issue intake to done with a deterministic spec', async () => {
    const { app, stateDir } = await startFakeServer();
    const projectId = await createSecretAndProject(app);
    const runId = await startRunFromIssue(app, projectId, 1);

    await waitForStep(app, runId, 'spec.human_review');

    const specResp = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/spec`, headers: AUTH });
    expect(specResp.statusCode).toBe(200);
    const markdown = specResp.json().markdown as string;
    expect(markdown).toContain('A. Names must be unique within a tenant.');
    expect(markdown).toContain('| Field | Type |');
    expect(markdown).toContain(SPEC_EMOJI);

    await approve(app, runId);
    await waitForStep(app, runId, 'implementation.human_review');
    await approve(app, runId);
    await waitForStep(app, runId, 'pr.human_review');

    const prResp = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/pull-request`, headers: AUTH });
    expect(prResp.statusCode).toBe(200);
    const prNumber = prResp.json().pullRequest.number as number;
    expect(prNumber).toBe(101);

    const paths = resolveFakeStatePaths(stateDir);
    await writeFile(pullRequestStateFile(paths, prNumber), 'merged\n', 'utf-8');

    const reconcileResp = await app.inject({ method: 'POST', url: '/v1/pull-requests/reconcile', headers: AUTH });
    expect(reconcileResp.statusCode).toBe(200);

    await waitForStep(app, runId, 'done');
  }, 90_000);

  it('revises the spec deterministically on anchored feedback and marks the comment addressed', async () => {
    const { app } = await startFakeServer();
    const projectId = await createSecretAndProject(app);
    const runId = await startRunFromIssue(app, projectId, 1);

    await waitForStep(app, runId, 'spec.human_review');

    // First pass: contains passage B and the Open questions heading; record passage offsets.
    const firstPass = await getSpec(app, runId);
    expect(firstPass.markdown).toContain(SPEC_PASSAGE_B);
    expect(firstPass.markdown).toContain(SPEC_OPEN_QUESTIONS_HEADING);
    const aBefore = codePointIndex(firstPass.markdown, SPEC_PASSAGE_A);
    const cBefore = codePointIndex(firstPass.markdown, SPEC_PASSAGE_C);
    const dBefore = codePointIndex(firstPass.markdown, SPEC_PASSAGE_D);
    expect(aBefore).toBeGreaterThanOrEqual(0);

    // Post anchored feedback that requests changes at the spec gate.
    const feedbackResp = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/replies`,
      headers: AUTH,
      payload: {
        kind: 'feedback',
        title: 'Clarify name trimming',
        body: 'Please state how surrounding whitespace in a name is handled.',
        anchor: {
          kind: 'artifact_range',
          artifactId: firstPass.artifactId,
          from: aBefore,
          to: aBefore + [...SPEC_PASSAGE_A].length,
          quotedText: SPEC_PASSAGE_A
        }
      }
    });
    expect(feedbackResp.statusCode).toBe(200);

    // The deterministic revision (second pass).
    const revised = await waitForRevisedSpec(app, runId);
    expect(revised).toContain(SPEC_REVISION_INSERT.trimEnd());
    expect(revised).not.toContain(SPEC_PASSAGE_B);
    expect(revised).not.toContain(SPEC_OPEN_QUESTIONS_HEADING);
    expect(revised).toContain(SPEC_PASSAGE_C);
    expect(revised).toContain(SPEC_PASSAGE_D);
    expect(revised).toContain(SPEC_PASSAGE_A);
    expect(revised.trimEnd().endsWith('Pass 2.')).toBe(true);

    // Passages C and D precede the insertion point and do not move; passage A shifts by
    // exactly the inserted source text length in Unicode code points.
    expect(codePointIndex(revised, SPEC_PASSAGE_C)).toBe(cBefore);
    expect(codePointIndex(revised, SPEC_PASSAGE_D)).toBe(dBefore);
    expect(codePointIndex(revised, SPEC_PASSAGE_A)).toBe(aBefore + [...SPEC_REVISION_INSERT].length);

    // Every open artifact comment is addressed with a thread response.
    const feedbackList = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/feedback`, headers: AUTH });
    expect(feedbackList.statusCode).toBe(200);
    const { feedback } = feedbackList.json() as { feedback: Array<{ status: string; thread: unknown[] }> };
    expect(feedback.length).toBeGreaterThan(0);
    for (const entry of feedback) {
      expect(entry.status).toBe('addressed');
      expect(entry.thread.length).toBeGreaterThan(0);
    }
  }, 90_000);

  it('drives a bug run to pr.human_review, persists a bug_triage artifact, and returns 404 for its spec', async () => {
    const { app, stateDir } = await startFakeServer();
    const projectId = await createSecretAndProject(app);
    const runId = await startRunFromIssue(app, projectId, 3);

    // Bug workflow has no spec.human_review gate; it reaches implementation.human_review,
    // which the seed/operator approves to continue to pr.human_review.
    await waitForStep(app, runId, 'implementation.human_review');
    await approve(app, runId);
    await waitForStep(app, runId, 'pr.human_review');

    const specResp = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/spec`, headers: AUTH });
    expect(specResp.statusCode).toBe(404);

    // The bug run passed spec.author and persisted an issue-canonical bug_triage artifact.
    const paths = resolveFakeStatePaths(stateDir);
    const database = createSqliteDatabase({ path: paths.databasePath });
    try {
      const repos = createDrizzleDomainRepositories(database);
      const artifact = await repos.artifacts.findByRunAndKind({ runId, kind: 'bug_triage' });
      expect(artifact).not.toBeNull();
      expect(artifact?.kind).toBe('bug_triage');
      expect(artifact?.canonicalRecord).toBe('issue');
    } finally {
      database.close();
    }
  }, 90_000);

  it('fails a run when a failure file targets spec.author', async () => {
    const { app, stateDir } = await startFakeServer();
    const projectId = await createSecretAndProject(app);
    const paths = resolveFakeStatePaths(stateDir);
    await writeFile(join(paths.failuresDir, 'issue-6.json'), JSON.stringify({ step: 'spec.author' }), 'utf-8');

    const runId = await startRunFromIssue(app, projectId, 6);
    await waitForStep(app, runId, 'failed');
    const run = await getRun(app, runId);
    expect(run.currentStep).toBe('failed');
    expect(typeof run.failureReason).toBe('string');
  }, 90_000);
});

function sdkFor(app: FastifyInstance) {
  return createControlPlaneClient({
    baseUrl: 'http://fake.test', bearerToken: 'fake-mode-token',
    fetch: async (url, init) => {
      const response = await app.inject({
        url: String(url), method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'PUT',
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(typeof init?.body === 'string' ? { payload: init.body } : {})
      });
      return new Response(response.body, { status: response.statusCode });
    }
  });
}

describe('testing guide fake-mode wiring without a listening socket', () => {
  it('validates partial saves, rolls back a reply after linking the first failure, and dispatches separate testing notes', async () => {
    const prompts: string[] = [];
    const launch = scriptedLaunch.launchScript;
    const launchSpy = vi.spyOn(scriptedLaunch, 'launchScript').mockImplementation(input => {
      const session = launch(input);
      return options => {
        prompts.push(options.prompt);
        return session(options);
      };
    });
    let principal: Principal = { id: 'operator', kind: 'human', tenantId: FAKE_TENANT };
    const { app, stateDir } = await startFakeServer({ resolvePrincipal: () => principal });
    const client = sdkFor(app);
    const db = createSqliteDatabase({ path: resolveFakeStatePaths(stateDir).databasePath });
    const raw = asInternalSqliteDatabase(db).client;
    try {
      const id = await startRunFromIssue(app, await createSecretAndProject(app), 1);
      await waitForStep(app, id, 'spec.human_review');
      await expect(client.listRunTestResults(id)).resolves.toEqual({ testResults: [] });
      await expect(client.getTestingGuideResults(id)).rejects.toMatchObject({ status: 404 });
      await expect(client.saveTestingGuideResults(id, { guideRevision: 1, items: [] })).rejects.toMatchObject({ status: 409 });
      await expect(client.createRunFeedback(id, { target: 'implementation', title: 'Early', body: 'Not at implementation' }))
        .rejects.toMatchObject({ status: 409 });
      await client.replyToRun(id, { kind: 'approve' });
      await waitForStep(app, id, 'implementation.human_review');
      const guide = await client.getRunTestingGuide(id);
      const [a, b, c, d] = guide.items;
      const url = `/v1/runs/${id}/testing-guide/results`;
      const put = (payload: object) => app.inject({ url, method: 'PUT', headers: AUTH, payload });
      const operator = principal;
      principal = { ...operator, kind: 'model' };
      expect((await put({ guideRevision: 1, items: [] })).statusCode).toBe(403);
      principal = { ...operator, tenantId: 'other_tenant' };
      expect((await put({ guideRevision: 1, items: [] })).statusCode).toBe(404);
      await expect(client.getTestingGuideResults(id)).rejects.toMatchObject({ status: 404 });
      await expect(client.listRunTestResults(id)).rejects.toMatchObject({ status: 404 });
      principal = operator;
      const anchored = await app.inject({ url: `/v1/runs/${id}/feedback`, method: 'POST', headers: AUTH,
        payload: { target: 'implementation', title: 'No anchor', body: 'No anchor', anchor: { kind: 'artifact', artifactId: 'x' } } });
      expect(anchored.statusCode).toBe(400);
      await expect(client.replyToRun(id, { kind: 'request_changes' })).rejects.toMatchObject({
        status: 409, response: { error: { details: { code: 'request_changes_conflict' } } }
      });
      for (const patch of [
        { items: [], unexpected: true },
        { items: [{ id: a!.id, outcome: 'passed', note: null }, { id: a!.id, outcome: null, note: 'dupe' }] },
        { items: [{ id: a!.id, outcome: 'inconclusive', note: null }] },
        { items: [{ id: a!.id, outcome: 'passed', note: 'x'.repeat(2_001) }] }
      ]) {
        const rejected = await put({ guideRevision: 1, ...patch });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().error.code).toBe('validation_error');
      }
      await expect(client.saveTestingGuideResults(id, { guideRevision: 2, items: [] })).rejects.toMatchObject({
        status: 409, response: { error: { code: 'conflict', details: { code: 'stale_guide_revision', latestGuideRevision: 1 } } }
      });
      await expect(client.saveTestingGuideResults(id, { guideRevision: 1, items: [
        { id: 'unknown', outcome: 'passed', note: 'Must not write' }
      ] })).rejects.toMatchObject({
        status: 422, response: { error: { code: 'unknown_test_items', details: { unknownItemIds: ['unknown'] } } }
      });
      expect(await client.listRunTestResults(id)).toEqual({ testResults: [] });

      const empty = await client.saveTestingGuideResults(id, { guideRevision: 1, items: [] });
      expect(empty.testResultId).toBeDefined();
      const patch = { guideRevision: 1, items: [
        { id: a!.id, outcome: 'passed' as const, note: 'Fast context only.' },
        { id: b!.id, outcome: 'failed' as const, note: ' ' },
        { id: c!.id, outcome: 'failed' as const, note: 'Actual failure.' },
        { id: d!.id, outcome: 'failed' as const, note: 'Remove me.' }
      ] };
      const saved = await client.saveTestingGuideResults(id, patch);
      expect(saved.testResultId).toBe(empty.testResultId);
      await client.saveTestingGuideResults(id, patch);
      const cleared = await client.saveTestingGuideResults(id, { guideRevision: 1, items: [{ id: d!.id, outcome: null, note: null }] });
      expect(cleared.items).toEqual([...saved.items.slice(0, 3), { id: d!.id }]);
      const [draft] = (await client.listRunTestResults(id)).testResults;
      const reply = { kind: 'feedback', title: 'Separate reply', body: 'Extra issue.' } as const;

      // This fires only once the first failed item has been linked (and the reply inserted).
      raw.exec(`CREATE TRIGGER fault_after_first_link BEFORE INSERT ON feedback
        WHEN EXISTS (SELECT 1 FROM test_results WHERE state = 'working' AND json_extract(items_json, '$[1].feedbackId') IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'test fault after first link'); END;`);
      await expect(client.replyToRun(id, reply)).rejects.toMatchObject({ status: 500, response: { error: { code: 'internal_error' } } });
      expect(await client.getTestingGuideResults(id)).toEqual(cleared);
      expect((await client.listRunTestResults(id)).testResults).toEqual([draft]);
      expect((await client.listRunFeedback(id)).feedback).toEqual([]);
      expect((await client.getRun(id)).currentStep).toBe('implementation.human_review');
      raw.exec('DROP TRIGGER fault_after_first_link');

      const revised = await client.replyToRun(id, reply);
      await waitForStep(app, id, 'implementation.human_review');
      const feedback = (await client.listRunFeedback(id)).feedback;
      expect(feedback).toHaveLength(3);
      const first = feedback.find(item => item.title === b!.text);
      const second = feedback.find(item => item.title === c!.text);
      expect(first?.body).toBe(b!.expected === undefined ? b!.text : `${b!.text}\n\nExpected: ${b!.expected}`);
      expect(second?.body).toBe('Actual failure.');
      expect(feedback).toContainEqual(expect.objectContaining({ id: revised.classification.createdFeedbackId, title: reply.title }));
      const history = (await client.listRunTestResults(id)).testResults;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ id: draft!.id, outcome: 'failed', state: 'final',
        feedbackRefs: expect.arrayContaining([first!.id, second!.id, revised.classification.createdFeedbackId]),
        items: [cleared.items[0], { ...cleared.items[1], feedbackId: first!.id },
          { ...cleared.items[2], feedbackId: second!.id }, cleared.items[3]]
      });
      const revisedPrompt = prompts.find(prompt => prompt.includes('## Testing notes'));
      const [required, notes] = revisedPrompt?.split('## Testing notes') ?? [];
      expect(required).toContain(`${second!.id} [blocker] ${c!.text}: Actual failure.`);
      expect(required).not.toContain('Fast context only.');
      expect(notes).toContain(`"${a!.text}" (passed): "Fast context only."`);
      expect(notes).not.toContain('Actual failure.');
    } finally {
      launchSpy.mockRestore();
      db.close();
    }
  }, 30_000);

  it.each(['rewind', 'fail', 'cancel'] as const)('discards only the draft on a committed %s exit', async exit => {
    const { app, stateDir } = await startFakeServer();
    const client = sdkFor(app);
    const id = await startRunFromIssue(app, await createSecretAndProject(app), 4);
    await waitForStep(app, id, 'implementation.human_review');
    const { guideRevision, items } = await client.getTestingGuideResults(id);
    const check = items[0]!.id;
    await client.saveTestingGuideResults(id, { guideRevision, items: [{ id: check, outcome: 'passed', note: 'Carry me.' }] });
    // Make a preceding final via a general-feedback-only send-back.
    await client.createRunFeedback(id, { target: 'implementation', title: 'Retest', body: 'Please retest.' });
    await expect(client.replyToRun(id, { kind: 'approve' })).rejects.toMatchObject({
      status: 409, response: { error: { details: { code: 'feedback_gate_blocked' } } }
    });
    await client.replyToRun(id, { kind: 'request_changes' });
    await waitForStep(app, id, 'implementation.human_review');
    const seeded = await client.getTestingGuideResults(id);
    const draft = await client.saveTestingGuideResults(id, { guideRevision: seeded.guideRevision,
      items: [{ id: check, outcome: 'failed', note: 'Discard me.' }] });
    const finals = (await client.listRunTestResults(id)).testResults.filter(result => result.state === 'final');
    expect(finals).toHaveLength(1);
    const op = (suffix: string, payload?: object) => app.inject({
      url: `/v1/runs/${id}/${suffix}`, method: 'POST', headers: AUTH, ...(payload === undefined ? {} : { payload })
    });
    const rejected = await op('set-step', { step: 'implementation.human_review' });
    expect(rejected.statusCode).toBe(400);
    expect(await client.getTestingGuideResults(id)).toEqual(draft);

    if (exit === 'rewind') {
      await expect.poll(async () => (await op('set-step', { step: 'implementation.testing_guide' })).statusCode).toBe(200);
    } else if (exit === 'cancel') {
      expect((await op('cancel')).statusCode).toBe(200);
      expect((await op('recover', {})).statusCode).toBe(409);
    } else {
      const db = createSqliteDatabase({ path: resolveFakeStatePaths(stateDir).databasePath });
      try {
        const { runs, runSteps } = createDrizzleDomainRepositories(db);
        const orchestrator = new DefaultOrchestrator({
          runs, runSteps, events: new InMemoryRunEventBus(), dispatchQueue: new RunDispatchQueue({ maxConcurrent: 1 }),
          autoDispatch: false
        });
        await orchestrator.applyDirective({ tenant: FAKE_TENANT, runId: id, directive: 'fail', reason: 'Test failure' });
        expect(await client.getTestingGuideResults(id)).toMatchObject({ state: 'final', guideRevision });
        expect((await op('recover', { mode: 'resume' })).statusCode).toBe(200);
      } finally {
        db.close();
      }
    }
    expect((await client.listRunTestResults(id)).testResults).toEqual(finals);
    expect((await client.listRunFeedback(id)).feedback.map(item => item.title)).toEqual(['Retest']);
    if (exit !== 'cancel') {
      await waitForStep(app, id, 'implementation.human_review');
      const view = await client.getTestingGuideResults(id);
      expect(view.testResultId).toBeUndefined();
      expect(view.items[0]).toEqual({ id: check, note: 'Carry me.', outcome: 'passed' });
      const saved = await client.saveTestingGuideResults(id, { guideRevision: view.guideRevision, items: [] });
      expect(saved.testResultId).not.toBe(draft.testResultId);
    }
  }, 30_000);

  it('stores complete revisions after implementation feedback, then reads the latest without a worktree', async () => {
    const { app, stateDir } = await startFakeServer();
    const client = sdkFor(app);
    const id = await startRunFromIssue(app, await createSecretAndProject(app), 1);
    await waitForStep(app, id, 'spec.human_review');
    await expect(client.getRunTestingGuide(id)).rejects.toMatchObject({ status: 404 });
    await expect(client.getRunTestingGuide('missing')).rejects.toMatchObject({ status: 404 });
    await client.replyToRun(id, { kind: 'approve', body: 'Approved spec.' });
    await waitForStep(app, id, 'implementation.human_review');
    const first = await client.getRunTestingGuide(id);
    expect(first.revision).toBe(1);
    expect(first.items.map(item => item.text[0])).toEqual(['A', 'B', 'C', 'D']);
    const [a, , c, d] = first.items;
    const working = await client.saveTestingGuideResults(id, { guideRevision: 1, items: [
      { id: a!.id, outcome: 'passed', note: 'Fast.' },
      { id: c!.id, outcome: 'failed', note: 'Wrong output.' },
      { id: d!.id, outcome: 'passed', note: 'Old check passed.' }
    ] });
    const general = await client.createRunFeedback(id, { target: 'implementation', title: 'Help text', body: 'A typo.' });
    await expect(client.replyToRun(id, { kind: 'approve' })).rejects.toMatchObject({
      status: 409, response: { error: { code: 'conflict', details: { code: 'failed_test_items', failedItemIds: [c!.id] } } }
    });
    expect(await client.getTestingGuideResults(id)).toEqual(working);
    await client.replyToRun(id, { kind: 'request_changes' });
    await waitForStep(app, id, 'implementation.human_review');
    const next = await client.getRunTestingGuide(id);
    expect(next.revision).toBe(2);
    expect(next.items.slice(0, 3)).toEqual(first.items.slice(0, 3));
    expect(next.items.slice(3).map(item => item.text[0])).toEqual(['D', 'E']);
    expect(next.items.slice(3).every(item => !first.items.some(old => old.id === item.id))).toBe(true);
    const feedback = (await client.listRunFeedback(id)).feedback;
    expect(feedback).toHaveLength(2);
    const generated = feedback.find(item => item.title === c!.text);
    expect(generated).toMatchObject({ target: 'implementation', body: 'Wrong output.', status: 'addressed' });
    expect(feedback).toContainEqual(expect.objectContaining({ id: general.id, status: 'addressed', target: 'implementation' }));
    expect(await client.getTestingGuideResults(id)).toEqual({
      guideRevision: 2, state: 'working', outcome: 'passed',
      items: next.items.map(({ id }) => id === a!.id ? { id, outcome: 'passed', note: 'Fast.' } : { id })
    });
    const path = ['implementation.build', 'implementation.testing_guide', 'implementation.human_review'];
    const steps = (await client.listRunSteps(id)).steps;
    expect(steps.map(step => step.step).filter(step => path.includes(step))).toEqual([...path, ...path]);
    const sessions = (await client.listRunSessions(id)).sessions.filter(session => session.step === path[1]);
    expect(sessions).toHaveLength(2);
    expect(sessions.every(session => session.role === 'implementer' && session.outcome === 'succeeded' && session.usageAvailable)).toBe(true);
    expect(await readLaunchCounter(resolveFakeStatePaths(stateDir))).toBe(8);

    await client.replyToRun(id, { kind: 'approve' });
    await waitForStep(app, id, 'pr.human_review');
    const { testResults } = await client.listRunTestResults(id);
    expect(testResults).toHaveLength(2);
    const [failed, passed] = testResults;
    expect(failed).toMatchObject({ id: working.testResultId, state: 'final', guideRevision: 1, outcome: 'failed' });
    expect(failed!.feedbackRefs).toHaveLength(2);
    expect(failed!.feedbackRefs).toEqual(expect.arrayContaining([general.id, generated!.id]));
    expect(passed).toMatchObject({ state: 'final', guideRevision: 2, outcome: 'passed', feedbackRefs: [] });
    expect(await client.getTestingGuideResults(id)).toMatchObject({ state: 'final', testResultId: passed!.id });
    expect((await client.listRunFeedback(id)).feedback.every(item => item.status === 'resolved')).toBe(true);

    const paths = resolveFakeStatePaths(stateDir);
    const db = createSqliteDatabase({ path: paths.databasePath });
    const workspace = await createDrizzleDomainRepositories(db).runWorkspaceMetadata.findByRunId(id);
    db.close();
    expect(workspace).not.toBeNull();
    const git = promisify(execFile);
    const repo = workspace!.workspaceRepoRoot;
    expect((await git('git', ['ls-files'], { cwd: repo })).stdout).not.toMatch(/testing-guide/u);
    await git('git', ['worktree', 'remove', '--force', repo], { cwd: paths.hostClone });
    await expect(access(repo)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(client.getRunTestingGuide(id)).resolves.toEqual(next);
  }, 30_000);

  it('resumes a failed first attempt and stores pass one in a new occurrence', async () => {
    const { app, stateDir } = await startFakeServer();
    const client = sdkFor(app);
    const control = failureFile(resolveFakeStatePaths(stateDir), 4);
    await writeFile(control, JSON.stringify({ step: 'implementation.testing_guide' }), 'utf8');
    const id = await startRunFromIssue(app, await createSecretAndProject(app), 4);
    await waitForStep(app, id, 'failed');
    await expect(access(control + '.fired')).resolves.toBeUndefined();
    await expect(client.getRunTestingGuide(id)).rejects.toMatchObject({ status: 404 });
    expect((await client.recoverRun(id)).mode).toBe('resume');
    await waitForStep(app, id, 'implementation.human_review');
    const guide = await client.getRunTestingGuide(id);
    expect(guide.revision).toBe(1);
    expect(guide.items.map(item => item.text[0])).toEqual(['A', 'B', 'C', 'D']);
    const visits = (await client.listRunSteps(id)).steps.filter(step => step.step === 'implementation.testing_guide');
    expect(visits).toHaveLength(2);
    expect(visits[0]?.id).not.toBe(visits[1]?.id);
    expect(visits[1]?.checkpointResult).toEqual({ kind: 'testing_guide', revision: 1, itemCount: 4 });
  }, 30_000);

  it('does not fall back past an active table; a role or step default route authorizes the guide', async () => {
    const { app } = await startFakeServer();
    const client = sdkFor(app);
    const profile = (await client.listConfigurationRecords()).records.find(record => record.kind === 'provider_profile');
    expect(profile).toBeDefined();
    const build = { id: 'build', profileId: profile!.id, route: { mode: 'agent', step: 'implementation.build', defaultForStep: true } } as const;
    const table = await client.createConfigurationRecord({ kind: 'model_routing_table', tenant: FAKE_TENANT,
      settings: { active: true, entries: [build] } });
    const projectId = await createSecretAndProject(app);
    const id = await startRunFromIssue(app, projectId, 4);
    await waitForStep(app, id, 'failed');
    expect((await client.getRun(id)).failureReason).toBe('route_not_found');
    expect((await client.listRunSteps(id)).steps.at(-2)?.step).toBe('implementation.testing_guide');
    await expect(client.getRunTestingGuide(id)).rejects.toMatchObject({ status: 404 });

    const guide = { id: 'guide', profileId: profile!.id };
    await client.updateConfigurationRecord(table.id, { kind: 'model_routing_table', settings: { entries: [
      build, { ...guide, route: { mode: 'agent', step: 'implementation.testing_guide', role: 'implementer' } }
    ] } });
    await client.recoverRun(id);
    await waitForStep(app, id, 'implementation.human_review');
    expect((await client.getRunTestingGuide(id)).revision).toBe(1);

    await client.updateConfigurationRecord(table.id, { kind: 'model_routing_table', settings: { entries: [
      build, { ...guide, route: { mode: 'agent', step: 'implementation.testing_guide', defaultForStep: true } }
    ] } });
    const second = await startRunFromIssue(app, projectId, 10);
    await waitForStep(app, second, 'implementation.human_review');
    expect((await client.getRunTestingGuide(second)).revision).toBe(1);
  }, 30_000);

  it('corrects a rejected structured result, and fails on persistent invalid output without storing a revision', async () => {
    const { app } = await startFakeServer();
    const client = sdkFor(app);
    const projectId = await createSecretAndProject(app);
    const original = scriptedResults.buildScriptedSessionEvents;
    let rejectedFirst = false;
    const scripted = vi.spyOn(scriptedResults, 'buildScriptedSessionEvents').mockImplementation(selection => {
      const events = original(selection);
      if (selection.step !== 'implementation.testing_guide' || (selection.issueNumber !== 10 && rejectedFirst)) return events;
      rejectedFirst = true;
      return events.map(event => event.type === 'result' ? { ...event, structuredOutput: {
        instructions: 'Invalid output', items: [{ text: 'A', id: 'model-supplied-id' }]
      } } : event);
    });
    try {
      const corrected = await startRunFromIssue(app, projectId, 4);
      await waitForStep(app, corrected, 'implementation.human_review');
      expect((await client.getRunTestingGuide(corrected)).revision).toBe(1);
      expect((await client.listRunSessions(corrected)).sessions.filter(session => session.step === 'implementation.testing_guide')
        .map(session => session.outcome)).toEqual(['failed', 'succeeded']);
      const failed = await startRunFromIssue(app, projectId, 10);
      await waitForStep(app, failed, 'failed');
      expect((await client.getRun(failed)).failureReason).toBe('testing_guide_failed');
      await expect(client.getRunTestingGuide(failed)).rejects.toMatchObject({ status: 404 });
      expect((await client.listRunSessions(failed)).sessions.filter(session => session.step === 'implementation.testing_guide')
        .map(session => session.outcome)).toEqual(['failed', 'failed', 'failed']);
    } finally {
      scripted.mockRestore();
    }
  }, 30_000);

  it('redispatches a stored, still-open guide without a new launch, session, or revision', async () => {
    let service!: ControlPlaneService;
    const { app, stateDir } = await startFakeServer({ onControlPlaneReady: value => { service = value; } });
    const client = sdkFor(app);
    const original = DrizzleRunRepository.prototype.recordRunStepTransition;
    let interrupted = false;
    const transition = vi.spyOn(DrizzleRunRepository.prototype, 'recordRunStepTransition').mockImplementation(async function (this: DrizzleRunRepository, input) {
      if (!interrupted && input.expectedStep === 'implementation.testing_guide') {
        interrupted = true;
        throw new Error('Injected post-store transition interruption');
      }
      return original.call(this, input);
    });
    try {
      const id = await startRunFromIssue(app, await createSecretAndProject(app), 4);
      await expect.poll(() => interrupted).toBe(true);
      expect((await client.getRun(id)).currentStep).toBe('implementation.testing_guide');
      const stored = await client.getRunTestingGuide(id);
      expect(stored.revision).toBe(1);
      const sessions = await client.listRunSessions(id);
      expect(sessions.sessions.filter(session => session.step === 'implementation.testing_guide')).toHaveLength(1);
      const launches = await readLaunchCounter(resolveFakeStatePaths(stateDir));
      await service.tick({ runId: id, tenant: FAKE_TENANT, principal: { id: 'tick', kind: 'system', tenantId: FAKE_TENANT } });
      await waitForStep(app, id, 'implementation.human_review');
      expect(await client.getRunTestingGuide(id)).toEqual(stored);
      expect(await client.listRunSessions(id)).toEqual(sessions);
      expect(await readLaunchCounter(resolveFakeStatePaths(stateDir))).toBe(launches);
      expect(transition.mock.calls.filter(([input]) => input.expectedStep === 'implementation.testing_guide')).toHaveLength(2);
    } finally {
      transition.mockRestore();
    }
  }, 30_000);
});
