import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FeedbackResponse, Run, RunStep, Session } from '@autocatalyst/api-contract';
import { claudeAgentAdapterId, claudeProviderKind, createClaudeAgentAdapter } from '@autocatalyst/claude-agent-adapter';
import { buildProviderAdapterKey } from '@autocatalyst/core';
import type { AgentProviderSessionInput } from '@autocatalyst/execution';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

import { FAKE_FIXTURE_PROJECT } from './fake/constants.js';
import { ensureFakeState } from './fake/state-bootstrap.js';
import { createControlPlaneServer } from './server.js';

const headers = { authorization: 'Bearer spec-convergence-test' };
const specPath = 'context-human/specs/feature-reviewed-draft.md';
const finding = (title: string, passageQuote?: string) => ({
  title, body: title + ' needs attention.', severity: 'info', scope: 'passage',
  ...(passageQuote !== undefined ? { passageQuote } : {})
});
const proceed = { status: 'satisfied' };

function author(body: string, ids: readonly string[] = [], decline = false) {
  return {
    spec: { kind: 'feature_spec', slug: 'reviewed-draft', relativePath: specPath, frontmatter: {}, body },
    dispositions: ids.map(feedbackId => decline
      ? { feedbackId, disposition: 'declined', reason: 'The existing behavior is intentional.' }
      : { feedbackId, disposition: 'fixed', summary: 'Clarified the draft.' })
  };
}

type Launch = {
  role: string;
  model: string;
  repoRoot: string;
  candidatePath?: string;
  candidate?: string;
  resultFile: string;
  ids: string[];
  prompt: string;
};

async function harness(script: (launch: Launch, previous: readonly Launch[]) => unknown) {
  const paths = await ensureFakeState(await mkdtemp(join(tmpdir(), 'ac-spec-convergence-')));
  const options = { databasePath: paths.databasePath, bearerToken: 'spec-convergence-test',
    masterSecret: 'spec-convergence-integration-secret',
    workspaceRoots: { reposRoot: paths.reposRoot, workspacesRoot: paths.workspacesRoot } };
  const bootstrap = await createControlPlaneServer({ ...options, autoDispatch: { enabled: false } });
  let projectId: string;
  const expectedModels = { implementer: 'author-test-model', reviewer: 'reviewer-test-model' };
  try {
    const secret = await bootstrap.inject({ method: 'POST', url: '/v1/secrets', headers, payload: { value: 'test-credential' } });
    expect(secret.statusCode).toBe(201);
    const profileIds: string[] = [];
    for (const model of Object.values(expectedModels)) {
      const profile = await bootstrap.inject({ method: 'POST', url: '/v1/configuration-records', headers, payload: {
        kind: 'provider_profile', providerKind: claudeProviderKind, adapterId: claudeAgentAdapterId,
        settings: { profileName: model, credentialSecretHandle: secret.json().handle,
          model: { provider: 'anthropic', model }, inferenceSettings: {}, endpoint: {} }
      } });
      expect(profile.statusCode).toBe(201);
      profileIds.push(profile.json().id);
    }
    const routes = await bootstrap.inject({ method: 'POST', url: '/v1/configuration-records', headers, payload: {
      kind: 'model_routing_table', settings: { active: true,
        entries: Object.keys(expectedModels).map((role, i) => ({
          id: role, route: { step: 'spec.author', role, mode: 'agent' }, profileId: profileIds[i]
        }))
      }
    } });
    expect(routes.statusCode, routes.body).toBe(201);
    const project = await bootstrap.inject({ method: 'POST', url: '/v1/projects', headers, payload: {
      displayName: FAKE_FIXTURE_PROJECT.displayName, repoUrl: FAKE_FIXTURE_PROJECT.repoUrl,
      hostRepository: FAKE_FIXTURE_PROJECT.hostRepository
    } });
    expect(project.statusCode).toBe(201);
    projectId = project.json().id;
  } finally {
    await bootstrap.close();
  }

  const launches: Launch[] = [];
  const failures: unknown[] = [];
  const telemetry: Record<string, unknown>[] = [];
  const adapter = createClaudeAgentAdapter();
  const app = await createControlPlaneServer({
    ...options, realRunnerDispatch: { enabled: true },
    logger: { stream: { write(line: string) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['component'] === 'spec-convergence') telemetry.push(record);
    } } },
    providerAdapters: new Map([[buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId), () => ({
      ...adapter,
      async startSession(input: AgentProviderSessionInput) {
        const env = input.runInput.environment;
        const { role, specReview } = env.context.task.inputs as { role: string; specReview: { candidateKey?: string; requiredFeedbackIds?: string[] } };
        if (env.workspace.shape !== 'two_roots') throw new Error('Expected the production repository and scratch workspace.');
        const candidatePath = specReview.candidateKey ? join(env.workspace.scratchRoot, specReview.candidateKey) : undefined;
        const launch = {
          role, model: input.profile.model.model, repoRoot: env.workspace.repoRoot,
          resultFile: input.structuredResultCapture!.resultFile,
          ids: specReview.requiredFeedbackIds ?? [], prompt: env.context.task.prompt!,
          ...(candidatePath ? { candidatePath, candidate: await readFile(candidatePath, 'utf8') } : {})
        };
        launches.push(launch);
        return createClaudeAgentAdapter({
          launchClaudeSession: async function* (session) {
            try {
              expect(launch.model).toBe(expectedModels[role as keyof typeof expectedModels]);
              if (role === 'reviewer') {
                expect(session.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
                expect(session.options?.['tools']).toEqual(['Read', 'Glob', 'Grep']);
                expect(input.modelMemory).toBeUndefined();
              }
              const result = script(launch, launches);
              yield { type: 'result', structuredOutput: { response: result },
                result: { is_error: false, input_tokens: 1, output_tokens: 2 } };
            } catch (error) {
              failures.push(error);
              throw error;
            }
          }
        }).startSession(input);
      }
    })]])
  });
  let runId: string;
  const request = (method: 'GET' | 'POST' | 'PATCH', suffix: string, payload?: object) =>
    app.inject({ method, url: `/v1/runs/${runId}${suffix}`, headers, ...(payload ? { payload } : {}) });
  const start = async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: {
      projectId, identity: 'spec-convergence-test', topic: { title: 'Review the spec draft' },
      submission: { kind: 'free_form', body: 'Write a feature spec for the requested behavior.', workKind: 'feature' }
    } });
    expect(response.statusCode, response.body).toBe(201);
    runId = response.json().run.id;
  };
  const wait = async (step: string) => vi.waitFor(async () => {
    if (failures.length) throw failures[0];
    const run = (await request('GET', '')).json() as Run;
    expect(run.currentStep, JSON.stringify(run.failureReason)).toBe(step);
    return run;
  }, { timeout: 4500, interval: 30 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: launches[0]!.repoRoot, encoding: 'utf8' });
  return {
    paths, start, request, wait, git, launches, telemetry,
    get runId() { return runId; },
    async steps() { return (await request('GET', '/steps')).json().steps as RunStep[]; },
    async feedback() { return (await request('GET', '/feedback')).json().feedback as FeedbackResponse[]; },
    async close() { await app.close(); }
  };
}

it('commits only the selected candidate, settles findings, and binds exact quote ranges via the feedback API', async () => {
  const initial = '# Draft 🚀\n\nkeep once\nvanish later\nrepeat now repeat now\nbecome ambiguous\n';
  const final = '# Draft 🚀\n\nNew location for keep once\nbecome ambiguous\nbecome ambiguous\n';
  const runtime = await harness((launch, launches) => {
    if (launch.role === 'implementer') return author(launch.ids.length ? final : initial, launch.ids);
    expect(launch.candidate).toContain('status: draft');
    expect(launch.prompt).toContain(specPath);
    expect(() => execFileSync('git', ['cat-file', '-e', `HEAD:${specPath}`], { cwd: launch.repoRoot, stdio: 'ignore' })).toThrow();
    return launches.length === 2 ? { status: 'findings', findings: [
      finding('moved', 'keep once'), finding('missing'), finding('not found', 'made up'),
      finding('repeated', 'repeat now'), finding('vanished', 'vanish later'),
      finding('ambiguous', 'become ambiguous'),
      { title: 'document', body: 'Document-wide concern', scope: 'document', severity: 'warning' }
    ] } : proceed;
  });
  try {
    await runtime.start();
    await runtime.wait('spec.human_review');
    const { markdown, artifact } = (await runtime.request('GET', '/spec')).json();
    expect(markdown).toBe(runtime.launches[3]!.candidate);
    expect(runtime.git('show', `HEAD:${specPath}`)).toBe(markdown);
    expect(runtime.git('log', '--format=%s', '--', specPath)).toBe('docs: add feature spec reviewed-draft\n');
    expect(runtime.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(specPath);
    const feedback = await runtime.feedback();
    expect(feedback).toHaveLength(7);
    expect(new Set(feedback.map(item => item.id))).toEqual(new Set(runtime.launches[2]!.ids));
    for (const item of feedback) {
      expect(item.status).toBe('resolved');
      expect(item.thread[0]?.author.id).toBe('anthropic:reviewer-test-model');
      expect(item.thread[1]?.body).toBe('Clarified the draft.');
      if (item.title === 'moved') {
        const from = Array.from(markdown.slice(0, markdown.indexOf('keep once'))).length;
        expect(item.anchor).toEqual({ kind: 'artifact_range', artifactId: artifact.id, from, to: from + 9, quotedText: 'keep once' });
        expect(from).toBeLessThan(markdown.indexOf('keep once')); // one astral character precedes it
      } else expect(item.anchor).toBeUndefined();
    }
    const steps = await runtime.steps();
    const result = steps.find(step => step.step === 'spec.author')?.checkpointResult;
    expect(JSON.stringify(result)).not.toMatch(/passageQuote|privateSpecReview|spec-candidate-|vanish later/u);
    const fallbackCodes = ['quote_missing', 'quote_not_found_in_candidate', 'quote_non_unique_in_candidate',
      'quote_removed_from_selected', 'quote_non_unique_in_selected', 'document_scope'];
    expect(result).toMatchObject({ outcome: 'converged', artifactId: artifact.id,
      findings: expect.arrayContaining(['bound', ...fallbackCodes].map(location => expect.objectContaining({ location }))) });
    const tags = { runId: runtime.runId, phase: 'spec', step: 'spec.author', altitude: 'build', role: 'reviewer' };
    expect(runtime.telemetry.filter(event => event['event'] === 'spec_convergence_round')).toMatchObject([
      { ...tags, round: 1, outcome: 'continue' },
      { ...tags, round: 2, outcome: 'converged' }
    ]);
    const bindings = runtime.telemetry.filter(event => event['event'] === 'spec_convergence_binding');
    expect(bindings).toHaveLength(7);
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...tags, round: 1, outcome: 'bound', feedbackId: feedback.find(item => item.title === 'moved')!.id }),
      ...fallbackCodes.map(fallbackCode => expect.objectContaining({ ...tags, round: 1, outcome: 'target_level', fallbackCode }))
    ]));
    expect(JSON.stringify(runtime.telemetry)).not.toMatch(/passageQuote|keep once|made up|vanish later|Draft|needs attention|Clarified the draft|spec-candidate-|feature-reviewed-draft\.md|ac-spec-convergence-/u);
    const { sessions } = (await runtime.request('GET', '/sessions')).json() as { sessions: Session[] };
    expect(sessions.map(session => session.role)).toEqual(['implementer', 'reviewer', 'implementer', 'reviewer']);
    expect(new Set(runtime.launches.map(launch => launch.resultFile)).size).toBe(4);
    expect(result).toMatchObject({ rounds: expect.arrayContaining([expect.objectContaining({
      implementerSessionId: sessions[0]!.id, reviewerSessionId: sessions[1]!.id
    })]) });
  } finally { await runtime.close(); }
}, 15000);

it('resumes both roles by pause occurrence, rejects stale replies, and regenerates a missing pending candidate', async () => {
  const runtime = await harness((launch, launches) => {
    if (launches.length === 1) return { directive: 'needs_input', question: 'What is the scope?' };
    if (launches.length === 2) expect(launch.prompt).toContain('Scope answer');
    if (launches.length === 3) return { directive: 'needs_input', question: 'What about errors?' };
    if (launches.length === 4) {
      expect(launch.prompt).not.toContain('Error answer');
      expect(launch.prompt).toContain('Scope answer');
    }
    if (launches.length === 5) expect(launch.prompt).toContain('Error answer');
    return launch.role === 'implementer' ? author('# Draft\n\nExpected behavior.') : proceed;
  });
  try {
    await runtime.start();
    await runtime.wait('spec.awaiting_input');
    const first = (await runtime.steps()).find(s => s.step === 'spec.awaiting_input' && s.endedAt === null)!;
    expect(first.checkpointResult).toMatchObject({ pause: { role: 'implementer', question: 'What is the scope?' } });
    const reply = (pauseStepId: string, body: string) => runtime.request('POST', '/replies', { kind: 'guidance', pauseStepId, body });
    expect((await reply(first.id, 'Scope answer')).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await runtime.steps()).some(s =>
      s.step === 'spec.awaiting_input' && s.id !== first.id && s.endedAt === null)).toBe(true), { timeout: 4500 });
    const second = (await runtime.steps()).find(s => s.step === 'spec.awaiting_input' && s.endedAt === null)!;
    expect(second.checkpointResult).toMatchObject({ pause: { role: 'reviewer', question: 'What about errors?' } });
    expect((await reply(first.id, 'Stale')).statusCode).toBe(409);
    const candidatePath = runtime.launches[2]!.candidatePath!;
    expect(dirname(candidatePath)).toBe(join(dirname(runtime.launches[2]!.repoRoot), 'scratch'));
    await rm(candidatePath);
    expect((await reply(second.id, 'Error answer')).statusCode).toBe(200);
    await runtime.wait('spec.human_review');
    expect(runtime.launches.map(launch => launch.role)).toEqual(['implementer', 'implementer', 'reviewer', 'implementer', 'reviewer']);
    expect(runtime.telemetry.filter(event => event['event'] === 'spec_convergence_paused')).toMatchObject([
      { role: 'implementer', round: 1, outcome: 'needs_input' },
      { role: 'reviewer', round: 1, outcome: 'needs_input' }
    ]);
    expect(JSON.stringify(runtime.telemetry)).not.toMatch(/What is the scope|What about errors|Scope answer|Error answer/u);
    const authors = (await runtime.steps()).filter(s => s.step === 'spec.author');
    const occurrences = authors.map(s => (s.checkpointResult as { occurrenceId?: string }).occurrenceId);
    expect(new Set(occurrences).size).toBe(1);
  } finally { await runtime.close(); }
}, 15000);

it('bounds repeated fixes, lets a human decline an open finding without advancing, and leaves approval separate', async () => {
  const runtime = await harness((launch) => launch.role === 'implementer'
    ? author('# Draft\n\nTarget passage.', launch.ids)
    : { status: 'findings', findings: [{ ...finding('persistent', 'Target passage.'), severity: 'blocker' }] });
  try {
    await runtime.start();
    await runtime.wait('spec.human_review');
    const [item] = await runtime.feedback();
    expect(item).toMatchObject({ status: 'open' });
    expect(runtime.launches[2]!.ids).toEqual([item!.id]);
    const authorStep = (await runtime.steps()).find(s => s.step === 'spec.author');
    expect(authorStep?.checkpointResult).toMatchObject({ outcome: 'oscillation', openFeedbackIds: [item!.id] });
    expect(runtime.telemetry).toContainEqual(expect.objectContaining({
      event: 'spec_convergence_round', round: 2, outcome: 'oscillation'
    }));
    expect((await runtime.request('POST', '/replies', { kind: 'approve' })).statusCode).toBe(409);
    expect((await runtime.request('PATCH', `/feedback/${item!.id}`, { status: 'wont_fix', body: '   ' })).statusCode).toBe(400);
    expect((await runtime.request('PATCH', '/feedback/fb_unknown', { status: 'wont_fix', body: 'Out of scope.' })).statusCode).toBe(404);
    const declined = await runtime.request('PATCH', `/feedback/${item!.id}`, { status: 'wont_fix', body: 'Accept the existing scope.' });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({ status: 'wont_fix' });
    expect((await runtime.feedback())[0]?.thread.at(-1)?.body).toBe('Accept the existing scope.');
    await runtime.wait('spec.human_review');
    expect((await runtime.request('PATCH', `/feedback/${item!.id}`, { status: 'wont_fix', body: 'Duplicate.' })).statusCode).toBe(409);
    expect((await runtime.request('POST', '/replies', { kind: 'approve' })).statusCode).toBe(200);
  } finally { await runtime.close(); }
}, 15000);

it('retries an invalid reviewer verdict once and does not commit an unreviewed draft', async () => {
  const runtime = await harness(launch => launch.role === 'implementer' ? author('# Draft') : { reason: 'private verdict text' });
  try {
    await runtime.start();
    expect((await runtime.wait('failed')).failureReason).toBe('reviewer_result_invalid');
    expect(runtime.launches.map(launch => launch.role)).toEqual(['implementer', 'reviewer', 'reviewer']);
    expect(runtime.launches[2]!.resultFile).not.toBe(runtime.launches[1]!.resultFile);
    expect(runtime.git('log', '--format=%s', '--', specPath)).toBe('');
    expect(await runtime.feedback()).toEqual([]);
    expect(runtime.telemetry).toMatchObject([{
      event: 'spec_convergence_failed', runId: runtime.runId, phase: 'spec', step: 'spec.author',
      role: 'reviewer', altitude: 'build', round: 1, outcome: 'failed', failureCode: 'reviewer_result_invalid'
    }]);
    expect(JSON.stringify(runtime.telemetry)).not.toContain('private verdict text');
  } finally { await runtime.close(); }
}, 15000);

it('recovers after committing but before persisting the artifact without relaunching or duplicating history', async () => {
  const runtime = await harness(launch => launch.role === 'implementer'
    ? author('# Draft\n\nUnique passage.', launch.ids, true)
    : { status: 'findings', findings: [{ ...finding('declined', 'Unique passage.'), severity: 'blocker' }] });
  const database = new Database(runtime.paths.databasePath);
  try {
    database.exec("CREATE TRIGGER fail_spec_artifact BEFORE INSERT ON artifacts WHEN NEW.kind='feature_spec' BEGIN SELECT RAISE(ABORT, 'injected artifact outage'); END");
    await runtime.start();
    await runtime.wait('failed');
    expect(runtime.telemetry).toContainEqual(expect.objectContaining({
      event: 'spec_convergence_failed', role: 'none', round: 2, failureCode: 'spec_authoring_failed'
    }));
    expect(runtime.git('log', '--format=%s', '--', specPath)).toBe('docs: add feature spec reviewed-draft\n');
    const [original] = await runtime.feedback();
    expect(original?.status).toBe('open');
    database.exec('DROP TRIGGER fail_spec_artifact');
    const response = await runtime.request('POST', '/recover', { mode: 'resume' });
    expect(response.statusCode, response.body).toBe(200);
    await runtime.wait('spec.human_review');
    expect(runtime.launches).toHaveLength(4);
    expect(runtime.git('log', '--format=%s', '--', specPath)).toBe('docs: add feature spec reviewed-draft\n');
    const [item] = await runtime.feedback();
    expect(item).toMatchObject({ id: original!.id, status: 'wont_fix', anchor: { quotedText: 'Unique passage.' } });
    expect(item!.thread.map(t => t.body)).toEqual(['declined needs attention.', 'The existing behavior is intentional.']);
    expect((await runtime.request('POST', '/replies', { kind: 'approve' })).statusCode).toBe(200);
  } finally {
    database.close();
    await runtime.close();
  }
}, 15000);

it('hands off at the default round cap and carries an open finding into a fresh, no-op revision', async () => {
  let reviewerPass = 0;
  const body = '# Draft\n\nThe selected text stays the same.';
  const runtime = await harness(launch => {
    if (launch.role === 'implementer') return author(body, launch.ids);
    reviewerPass++;
    return reviewerPass <= 3 ? { status: 'findings', findings: [
      finding('Concern ' + reviewerPass, 'The selected text')
    ] } : proceed;
  });
  try {
    await runtime.start();
    await runtime.wait('spec.human_review');
    const first = (await runtime.steps()).find(step => step.step === 'spec.author')!;
    const [open] = (await runtime.feedback()).filter(item => item.status === 'open');
    expect(first.checkpointResult).toMatchObject({ outcome: 'max_rounds', openFeedbackIds: [open!.id] });
    expect(runtime.telemetry).toContainEqual(expect.objectContaining({
      event: 'spec_convergence_round', round: 3, outcome: 'max_rounds'
    }));
    expect(runtime.launches).toHaveLength(6);
    const revise = await runtime.request('POST', '/replies', { kind: 'request_changes' });
    expect(revise.statusCode).toBe(200);
    expect((await runtime.request('PATCH', `/feedback/${open!.id}`, { status: 'wont_fix', body: 'Stale gate.' })).statusCode).toBe(409);
    await runtime.wait('spec.human_review');
    expect(runtime.launches).toHaveLength(8);
    expect(runtime.launches[6]!.ids).toEqual([open!.id]);
    expect((await runtime.feedback()).find(item => item.id === open!.id)?.status).toBe('resolved');
    expect(runtime.git('log', '--format=%s', '--', specPath)).toBe('docs: add feature spec reviewed-draft\n');
    const second = (await runtime.steps()).find(step => step.step === 'spec.author' && step.id !== first.id)!;
    expect(second.checkpointResult).toMatchObject({ occurrenceId: second.id, outcome: 'converged' });
  } finally { await runtime.close(); }
}, 15000);
