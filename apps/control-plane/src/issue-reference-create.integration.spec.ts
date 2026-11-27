import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConversationWithFirstRunResponseSchema,
  projectIssueLookupResponseSchema,
  projectResponseSchema,
  runListResponseSchema,
  type CreateConversationSubmission,
  type IssueWorkKindDerivation
} from '@autocatalyst/api-contract';
import {
  ControlPlaneServiceError,
  DefaultControlPlaneService,
  DefaultIssueReferenceIntakeResolver,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  RunDispatchQueue,
  StaticIssueTrackerRegistry,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint
} from '@autocatalyst/core';
import { GitHubIssueTracker } from '@autocatalyst/github-issue-tracker-adapter';
import {
  DrizzleConversationIngressRepository,
  SqliteSecretStore,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { loadSpecAuthorPromptInput } from './spec-authoring-context-loader.js';
import { createControlPlaneServer } from './server.js';

const SENTINEL_TOKEN = 'sentinel-test-token-abc123-do-not-leak';
const FAKE_GH_ISSUE_NUMBER = 71;
const MASTER_SECRET = 'integration-test-master-secret';

const realisticGhOutput = JSON.stringify({
  number: FAKE_GH_ISSUE_NUMBER,
  title: 'feat: Start a run from an issue reference',
  body: 'Canonical issue body',
  labels: [{ name: 'feature' }, { name: 'backend' }],
  state: 'OPEN',
  url: 'https://github.com/markdstafford/autocatalyst/issues/71'
});

const owner = hardcodedDevelopmentPrincipal;

it('looks up and starts from tracked issues through the production server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-issue-lookup-'));
  const headers = { authorization: 'Bearer issue-lookup-test' };
  const fixtures: { number: number; title: string; labels: string[]; state: 'open' | 'closed'; workKind: IssueWorkKindDerivation }[] = [
    { number: 27, title: 'New feedback', labels: ['feature'], state: 'open', workKind: { kind: 'feature', source: 'label' } },
    { number: 28, title: 'Startup regression', labels: [], state: 'open', workKind: { kind: null, source: 'none', reason: 'no_match' } },
    { number: 29, title: 'fix: Ambiguous issue', labels: ['feature', 'bug'], state: 'open', workKind: { kind: null, source: 'none', reason: 'ambiguous_labels' } },
    { number: 30, title: 'Chore: Closed housekeeping', labels: [], state: 'closed', workKind: { kind: 'chore', source: 'title_prefix' } },
    { number: 31, title: 'fix: Free-form route', labels: [], state: 'open', workKind: { kind: 'bug', source: 'title_prefix' } }
  ];
  const urlFor = (number: number) => `https://github.com/acme/demo/issues/${number}`;
  const body = 'Full tracked issue body, not a lookup field.';
  let app: Awaited<ReturnType<typeof createControlPlaneServer>> | undefined;
  try {
    const executablePath = join(dir, 'fake-gh');
    const cases = fixtures.map(({ number, title, labels, state }) => `  ${number})
    printf '%s\n' '${JSON.stringify({ number, title, body, labels: labels.map(name => ({ name })), state: state.toUpperCase(), url: urlFor(number) })}'
    ;;`).join('\n');
    await writeFile(executablePath, `#!/bin/sh
[ "$1 $2 $4 $5" = 'issue view --repo acme/demo' ] || exit 1
[ "$GH_TOKEN" = '${SENTINEL_TOKEN}' ] || exit 1
case "$3" in
${cases}
  *) exit 1 ;;
esac
`, { mode: 0o755 });

    const server = await createControlPlaneServer({
      databasePath: join(dir, 'test.sqlite'),
      bearerToken: 'issue-lookup-test',
      masterSecret: MASTER_SECRET,
      autoDispatch: { enabled: false },
      githubIssueTracker: { executablePath }
    });
    app = server;
    const secret = await server.inject({ method: 'POST', url: '/v1/secrets', headers, payload: { value: SENTINEL_TOKEN } });
    expect(secret.statusCode).toBe(201);
    const { handle } = secret.json<{ handle: string }>();
    const created = await server.inject({
      method: 'POST', url: '/v1/projects', headers,
      payload: {
        displayName: 'Demo', repoUrl: 'https://github.com/acme/demo',
        hostRepository: { provider: 'github', owner: 'acme', name: 'demo' },
        issueTrackerSetting: { provider: 'github', credentialRef: { id: handle, purpose: 'issue_tracker' } }
      }
    });
    expect(created.statusCode).toBe(201);
    const projectId = projectResponseSchema.parse(created.json()).id;
    const list = async () => {
      const response = await server.inject({ method: 'GET', url: '/v1/runs', headers });
      expect(response.statusCode).toBe(200);
      return runListResponseSchema.parse(response.json()).runs;
    };
    const start = (submission: CreateConversationSubmission | (typeof unlabeled & { workKind: 'question' })) =>
      server.inject({
        method: 'POST', url: '/v1/conversations', headers,
        payload: { projectId, identity: randomUUID(), topic: { title: 'Track issue' }, submission }
      });

    for (const { number, title, labels, state, workKind } of fixtures) {
      const response = await server.inject({ method: 'GET', url: `/v1/projects/${projectId}/issues/${number}`, headers });
      expect(response.statusCode).toBe(200);
      expect(projectIssueLookupResponseSchema.parse(response.json())).toEqual({
        issue: { number, title, url: urlFor(number), labels, state }, workKind
      });
      expect(response.body).not.toContain(body);
      expect(response.body).not.toContain(SENTINEL_TOKEN);
    }
    expect(await list()).toEqual([]);

    const reference = (number: number) => ({
      kind: 'issue_reference' as const, body: `Start issue #${number}`, issue: { number }
    });
    const unlabeled = reference(28);
    const implicit = await start(unlabeled);
    expect(implicit.statusCode).toBe(400);
    expect(implicit.json()).toEqual({ error: {
      code: 'intake_routing_error', message: 'Issue has no recognized work-kind label or title prefix.',
      details: { code: 'work_kind_unresolved' }
    } });
    const invalid = await start({ ...unlabeled, workKind: 'question' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('validation_error');
    expect(await list()).toEqual([]);

    const submissions = [
      [{ ...unlabeled, workKind: 'bug' }, 28, 'bug'],
      [{ ...reference(27), workKind: 'chore' }, 27, 'chore'],
      [{ ...reference(29), workKind: 'enhancement' }, 29, 'enhancement'],
      [{ ...reference(30), workKind: 'feature' }, 30, 'feature'],
      [{ kind: 'free_form', body: 'Start #31', workKind: 'question' }, 31, 'bug']
    ] as const;
    for (const [submission, number, workKind] of submissions) {
      const response = await start(submission);
      expect(response.statusCode).toBe(201);
      const { run, message } = createConversationWithFirstRunResponseSchema.parse(response.json());
      expect(run.workKind).toBe(workKind);
      expect(run.trackedIssue).toMatchObject({ number, body, state: number === 30 ? 'closed' : 'open' });
      expect(message?.body).toBe(submission.body);
    }
    const runs = await list();
    expect(runs).toHaveLength(submissions.length);
    expect(Object.fromEntries(runs.map(run => [run.trackedIssue?.number, run.workKind]))).toEqual(
      Object.fromEntries(submissions.map(([, number, workKind]) => [number, workKind]))
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function createSuccessFakeGh(dir: string): Promise<string> {
  const scriptPath = join(dir, 'fake-gh-success');
  const script = `#!/bin/sh
case "$*" in
  *"issue view"*)
    cat <<'JSON'
${realisticGhOutput}
JSON
    exit 0
    ;;
esac
echo "Unexpected gh args: $*" 1>&2
exit 1
`;
  await writeFile(scriptPath, script, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createNotFoundFakeGh(dir: string): Promise<string> {
  const scriptPath = join(dir, 'fake-gh-not-found');
  const script = `#!/bin/sh
echo "GraphQL: Could not resolve to an Issue with the number of 71." 1>&2
exit 1
`;
  await writeFile(scriptPath, script, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

interface TestDeps {
  readonly controlPlane: DefaultControlPlaneService;
  readonly secretStore: SqliteSecretStore;
  readonly projectId: string;
  readonly domainRepos: ReturnType<typeof createDrizzleDomainRepositories>;
}

async function withTestSetup<T>(
  fakeGhPath: string,
  fn: (deps: TestDeps) => Promise<T>,
  tmpDir: string
): Promise<T> {
  const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
  const database = createSqliteDatabase({ path: dbPath });
  await migrateSqliteDatabase(database);
  try {
    const domainRepos = createDrizzleDomainRepositories(database);
    const conversationIngress = new DrizzleConversationIngressRepository(database);
    const secretStore = new SqliteSecretStore(database);
    await secretStore.unlock(MASTER_SECRET);

    // Seed sentinel token
    const { handle } = await secretStore.createSecret({ value: SENTINEL_TOKEN });

    // Create project with issueTrackerSetting and an issue_tracker credential
    const project = await domainRepos.projects.create({
      owner: { id: owner.id, kind: owner.kind, tenantId: owner.tenantId, displayName: owner.displayName },
      tenant: owner.tenantId,
      displayName: 'Issue Reference Test Project',
      repoUrl: 'https://github.com/markdstafford/autocatalyst',
      hostRepository: { provider: 'github', owner: 'markdstafford', name: 'autocatalyst' },
      workspaceRootOverride: null,
      issueTrackerSetting: { provider: 'github' },
      codeHostSetting: null,
      credentialRefs: [{ id: handle, purpose: 'issue_tracker', label: 'GitHub Test Token' }]
    });

    const githubTracker = new GitHubIssueTracker({
      secretResolver: secretStore,
      executablePath: fakeGhPath
    });
    const trackerRegistry = new StaticIssueTrackerRegistry({ github: githubTracker });
    const issueReferenceIntakeResolver = new DefaultIssueReferenceIntakeResolver({ registry: trackerRegistry });

    const eventBus = new InMemoryRunEventBus();
    const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });
    const orchestrator = new DefaultOrchestrator({
      runs: domainRepos.runs,
      conversationIngress,
      events: eventBus,
      dispatchQueue,
      autoDispatch: { enabled: false }
    });

    const controlPlane = new DefaultControlPlaneService({
      orchestrator,
      runs: domainRepos.runs,
      runSteps: domainRepos.runSteps,
      events: eventBus,
      policy: permissivePolicyDecisionPoint,
      artifacts: domainRepos.artifacts,
      feedback: domainRepos.feedback,
      runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
      workspaceFilesystem: { writeFile: vi.fn(), readFile: vi.fn().mockResolvedValue('') },
      feedbackLifecycle: {
        feedback: domainRepos.feedback,
        ids: () => `id_${randomUUID()}`,
        clock: () => new Date().toISOString()
      },
      projects: domainRepos.projects,
      issueReferenceIntakeResolver,
      pullRequests: domainRepos.pullRequests,
      sessions: domainRepos.sessions
    });

    return await fn({ controlPlane, secretStore, projectId: project.id, domainRepos });
  } finally {
    database.close();
  }
}

describe('issue-reference create integration (realistic fake gh)', () => {
  let tmpDir: string;
  let successFakeGh: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-ref-create-'));
    successFakeGh = await createSuccessFakeGh(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a run from a structured issue_reference submission with enriched tracked issue', async () => {
    await withTestSetup(successFakeGh, async ({ controlPlane, projectId, domainRepos }) => {
      const response = await controlPlane.createConversationWithFirstRun({
        principal: owner,
        tenant: owner.tenantId,
        request: {
          projectId,
          identity: 'Issue 71 (structured)',
          topic: { title: 'Work on issue 71' },
          submission: {
            kind: 'issue_reference',
            body: 'please work on issue 71',
            issue: { number: FAKE_GH_ISSUE_NUMBER }
          }
        }
      });

      // Follow the production no-reader path from persisted intake to authoring.
      await domainRepos.runs.recordRunStepTransition({
        expectedStep: response.run.currentStep,
        runId: response.run.id,
        currentStep: 'spec.author',
        terminal: false,
        runStep: { step: 'spec.author', phase: 'spec', role: 'implementer', startedAt: '2026-10-21T00:00:00.000Z', endedAt: null, durationMs: null }
      });
      const authoring = await loadSpecAuthorPromptInput({
        runId: response.run.id,
        tenantId: owner.tenantId,
        repositories: domainRepos
      });
      expect(authoring.linkedIssue).toMatchObject({
        title: 'feat: Start a run from an issue reference',
        body: 'Canonical issue body',
        labels: ['feature', 'backend']
      });
      expect(authoring.request.text).toContain('Canonical issue body');

      expect(response.run.workKind).toBe('feature');
      expect(response.run.currentStep).toBe('intake');
      expect(response.run.trackedIssue?.number).toBe(FAKE_GH_ISSUE_NUMBER);
      expect(response.run.trackedIssue?.title).toBe('feat: Start a run from an issue reference');
      expect(response.run.trackedIssue?.body).toBe('Canonical issue body');
      expect(response.run.trackedIssue?.labels).toEqual(['feature', 'backend']);
      expect(response.run.trackedIssue?.state).toBe('open');
      expect(response.message?.body).toBe('please work on issue 71');
    }, tmpDir);
  });

  it('creates a run from free_form text containing a single issue reference (#71)', async () => {
    await withTestSetup(successFakeGh, async ({ controlPlane, projectId }) => {
      const response = await controlPlane.createConversationWithFirstRun({
        principal: owner,
        tenant: owner.tenantId,
        request: {
          projectId,
          identity: 'Issue 71 (free-form)',
          topic: { title: 'Free-form for issue 71' },
          submission: {
            kind: 'free_form',
            body: 'work on issue #71'
          }
        }
      });

      expect(response.run.workKind).toBe('feature');
      expect(response.run.trackedIssue?.number).toBe(FAKE_GH_ISSUE_NUMBER);
      expect(response.run.trackedIssue?.labels).toContain('feature');
      expect(response.message?.body).toBe('work on issue #71');
    }, tmpDir);
  });

  it('does not leak the secret token sentinel in the response payload', async () => {
    await withTestSetup(successFakeGh, async ({ controlPlane, projectId }) => {
      const response = await controlPlane.createConversationWithFirstRun({
        principal: owner,
        tenant: owner.tenantId,
        request: {
          projectId,
          identity: 'Issue 71 (sentinel response)',
          topic: { title: 'Sentinel response' },
          submission: {
            kind: 'issue_reference',
            body: 'issue 71',
            issue: { number: FAKE_GH_ISSUE_NUMBER }
          }
        }
      });

      expect(JSON.stringify(response)).not.toContain(SENTINEL_TOKEN);
    }, tmpDir);
  });
});

describe('issue-reference create failure cases', () => {
  let tmpDir: string;
  let notFoundFakeGh: string;
  let successFakeGh: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-ref-create-fail-'));
    notFoundFakeGh = await createNotFoundFakeGh(tmpDir);
    successFakeGh = await createSuccessFakeGh(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns intake_routing_error when the tracker reports the issue is not found', async () => {
    await withTestSetup(notFoundFakeGh, async ({ controlPlane, projectId }) => {
      let caught: unknown;
      try {
        await controlPlane.createConversationWithFirstRun({
          principal: owner,
          tenant: owner.tenantId,
          request: {
            projectId,
            identity: 'Issue 71 (not-found)',
            topic: { title: 'Not found' },
            submission: {
              kind: 'issue_reference',
              body: 'issue 71',
              issue: { number: FAKE_GH_ISSUE_NUMBER }
            }
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ControlPlaneServiceError);
      expect((caught as ControlPlaneServiceError).code).toBe('intake_routing_error');
    }, tmpDir);
  });

  it('does not create a run when the issue reference fails to resolve', async () => {
    await withTestSetup(notFoundFakeGh, async ({ controlPlane, projectId, domainRepos }) => {
      await expect(
        controlPlane.createConversationWithFirstRun({
          principal: owner,
          tenant: owner.tenantId,
          request: {
            projectId,
            identity: 'Issue 71 (no run on failure)',
            topic: { title: 'No run on failure' },
            submission: {
              kind: 'issue_reference',
              body: 'issue 71',
              issue: { number: FAKE_GH_ISSUE_NUMBER }
            }
          }
        })
      ).rejects.toBeInstanceOf(ControlPlaneServiceError);

      const runs = await domainRepos.runs.listByTenant(owner.tenantId);
      expect(runs.runs).toHaveLength(0);
    }, tmpDir);
  });

  it('returns intake_routing_error for ambiguous free-form references (multiple #N)', async () => {
    await withTestSetup(successFakeGh, async ({ controlPlane, projectId }) => {
      let caught: unknown;
      try {
        await controlPlane.createConversationWithFirstRun({
          principal: owner,
          tenant: owner.tenantId,
          request: {
            projectId,
            identity: 'Issue 71+72 (ambiguous)',
            topic: { title: 'Ambiguous' },
            submission: {
              kind: 'free_form',
              body: 'work on issue #71 and issue #72'
            }
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ControlPlaneServiceError);
      expect((caught as ControlPlaneServiceError).code).toBe('intake_routing_error');
      expect((caught as ControlPlaneServiceError).details).toEqual({ code: 'issue_reference_ambiguous' });
    }, tmpDir);
  });

  it('does not include the token sentinel in any thrown error', async () => {
    await withTestSetup(notFoundFakeGh, async ({ controlPlane, projectId }) => {
      let caught: unknown;
      try {
        await controlPlane.createConversationWithFirstRun({
          principal: owner,
          tenant: owner.tenantId,
          request: {
            projectId,
            identity: 'Issue 71 (sentinel error)',
            topic: { title: 'Sentinel error' },
            submission: {
              kind: 'issue_reference',
              body: 'issue 71',
              issue: { number: FAKE_GH_ISSUE_NUMBER }
            }
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      const error = caught as Error;
      const serialized = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
      expect(serialized).not.toContain(SENTINEL_TOKEN);
    }, tmpDir);
  });
});
