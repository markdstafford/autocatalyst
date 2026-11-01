import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createDrizzleDomainRepositories, createSqliteDatabase } from '@autocatalyst/persistence';

import { readControlPlaneAppConfig } from '../config.js';
import { createControlPlaneServer } from '../server.js';
import {
  FAKE_FIXTURE_PROJECT,
  SPEC_OPEN_QUESTIONS_HEADING,
  SPEC_PASSAGE_A,
  SPEC_PASSAGE_B,
  SPEC_PASSAGE_C,
  SPEC_PASSAGE_D,
  SPEC_REVISION_INSERT
} from './constants.js';
import { pullRequestStateFile, resolveFakeStatePaths } from './paths.js';

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

async function startFakeServer(): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'ac-fake-'));
  const config = readControlPlaneAppConfig(['--fake-mode', '--fake-state-dir', stateDir], {});
  const app = await createControlPlaneServer(config);
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
    expect(markdown).toContain('✨');

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
