import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createProbeResourceSuccessStatusCode,
  createSecretResponseSchema,
  degradedHealthStatusCode,
  errorResponseSchema,
  eventsStreamPath,
  feedbackSchema,
  healthResponseSchema,
  principalDiagnosticResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema,
  projectCollectionPath,
  projectListResponseSchema,
  projectResponseSchema,
  pullRequestReconciliationPath,
  pullRequestReconciliationResponseSchema,
  reconcilePullRequestsSuccessStatusCode,
  encodeRunListCursor,
  runFeedbackListResponseSchema,
  runListResponseSchema,
  runReplyResponseSchema,
  runSpecResponseSchema,
  type ProbeResource,
  type Project,
  type Run
} from '@autocatalyst/api-contract';

import { SecretStoreLockedError } from './secret.js';

import {
  ControlPlaneServiceError,
  DefaultControlPlaneService,
  type ControlPlaneService,
  type DefaultControlPlaneServiceOptions
} from './control-plane-service.js';
import { DefaultIssueReferenceIntakeResolver } from './issue-reference-intake.js';
import { IssueTrackerError } from './issue-tracker.js';
import { StaticIssueTrackerRegistry } from './issue-tracker-registry.js';
import { runWorkflows } from './run-workflows.js';
import type { RunRepository, RunStepRepository } from './domain-repositories.js';
import { hardcodedDevelopmentPrincipal } from './principal.js';
import { registerControlPlaneRoutes } from './routes.js';
import type { ControlPlaneRouteDependencies } from './routes.js';
import { permissivePolicyDecisionPoint, type PolicyDecisionInput } from './policy.js';
import type { RunEventSubscription } from './run-events.js';

function expectNoSentinels(serialized: string): void {
  expect(serialized).not.toContain('sk-test-secret');
  expect(serialized).not.toContain('authorization: Bearer');
  expect(serialized).not.toContain('/Users/mark/private');
  expect(serialized).not.toContain('sec_secret_handle_value');
  expect(serialized).not.toContain('raw SDK diagnostic');
}

function createFakeControlPlaneService(): ControlPlaneService {
  return {
    createConversationWithFirstRun: vi.fn(async () => {
      throw new Error('controlPlane.createConversationWithFirstRun not stubbed for this test');
    }),
    listRuns: vi.fn(async () => {
      throw new Error('controlPlane.listRuns not stubbed for this test');
    }),
    getRun: vi.fn(async () => {
      throw new Error('controlPlane.getRun not stubbed for this test');
    }),
    getRunWorkflow: vi.fn(async () => {
      throw new Error('controlPlane.getRunWorkflow not stubbed for this test');
    }),
    listRunSteps: vi.fn(async () => {
      throw new Error('controlPlane.listRunSteps not stubbed for this test');
    }),
    subscribeRunEvents: vi.fn(async () => {
      throw new Error('controlPlane.subscribeRunEvents not stubbed for this test');
    }),
    replayRunEvents: vi.fn(async (input) => ({
      status: 'ok' as const,
      events: [] as never[],
      ...(input.lastEventId !== undefined ? {} : {})
    })),
    getRunSpec: vi.fn(async () => {
      throw new Error('controlPlane.getRunSpec not stubbed for this test');
    }),
    createRunFeedback: vi.fn(async () => {
      throw new Error('controlPlane.createRunFeedback not stubbed for this test');
    }),
    listRunFeedback: vi.fn(async () => {
      throw new Error('controlPlane.listRunFeedback not stubbed for this test');
    }),
    appendRunFeedbackThreadReply: vi.fn(async () => {
      throw new Error('controlPlane.appendRunFeedbackThreadReply not stubbed for this test');
    }),
    replyToRun: vi.fn(async () => {
      throw new Error('controlPlane.replyToRun not stubbed for this test');
    }),
    cancelRun: vi.fn(),
    archiveRun: vi.fn(),
    unarchiveRun: vi.fn(),
    setRunStep: vi.fn(),
    renameRun: vi.fn(),
    recoverRun: vi.fn(async () => {
      throw new Error('controlPlane.recoverRun not stubbed for this test');
    }),
    reconcilePullRequests: vi.fn().mockResolvedValue({ checked: 0, merged: 0, closed: 0, failed: 0, timedOut: false }),
    tick: vi.fn(async () => ({ status: 'noop' as const }))
  } as unknown as ControlPlaneService;
}

describe('project issue lookup and conversation intake', () => {
  const issue = {
    number: 27, title: 'A closed feature', labels: ['feature'],
    url: 'https://github.com/acme/demo/issues/27', state: 'closed' as const
  };
  const project: Project = {
    id: 'proj_1', owner: hardcodedDevelopmentPrincipal as Project['owner'], tenant: hardcodedDevelopmentPrincipal.tenantId,
    displayName: 'Demo', repoUrl: 'https://github.com/acme/demo',
    hostRepository: { provider: 'github', owner: 'acme', name: 'demo' },
    workspaceRootOverride: null, issueTrackerSetting: { provider: 'github' }, codeHostSetting: null,
    credentialRefs: [{ id: 'credential-ref-sentinel', purpose: 'issue_tracker' }],
    createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z'
  };
  const lookupPath = '/v1/projects/proj_1/issues';
  let server: Awaited<ReturnType<typeof buildServer>>['app'] | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function setup(projectSettings: Partial<Project> = {}, auth = { allowed: true, model: false }) {
    const tenantProject = { ...project, ...projectSettings };
    const otherProject = { ...project, id: 'other', tenant: 'tenant_other', owner: { ...project.owner, tenantId: 'tenant_other' } };
    const findById = vi.fn(async (tenantOrId: string, id?: string) => {
      const found = [tenantProject, otherProject].find(p => p.id === (id ?? tenantOrId)) ?? null;
      return id === undefined || found?.tenant === tenantOrId ? found : null;
    });
    const read = vi.fn().mockResolvedValue({ ...issue, body: 'tracker-body-sentinel' });
    const issues = new DefaultIssueReferenceIntakeResolver({ registry: new StaticIssueTrackerRegistry({ github: { read } }) });
    const createConversationWithFirstRun = vi.fn();
    const policy = { authorize: vi.fn().mockResolvedValue({ allowed: auth.allowed }) };
    const projects = { findById, create: vi.fn(), list: vi.fn(), update: vi.fn() };
    const controlPlane = new DefaultControlPlaneService({
      ...({} as DefaultControlPlaneServiceOptions),
      projects, policy: permissivePolicyDecisionPoint, issueReferenceIntakeResolver: issues,
      orchestrator: {
        createConversationWithFirstRun, createRun: vi.fn(), cancelRun: vi.fn(),
        createConversationWithFirstRun, createRun: vi.fn(), setRunStep: vi.fn(),
        createConversationWithFirstRun, createRun: vi.fn(), applyDirective: vi.fn(), dispatch: vi.fn(),
        tick: vi.fn(), replyToRun: vi.fn(), detectMerges: vi.fn(), refreshRunPullRequest: vi.fn(),
        reopenFailedRun: vi.fn(), admitForDispatch: vi.fn()
      }
    });
    const { app, authorization } = await buildServer({
      projects, controlPlane, policy,
      ...(auth.model ? { auth: {
        bearerToken: 'test-token',
        resolvePrincipal: () => ({ ...hardcodedDevelopmentPrincipal, kind: 'model' as const })
      } } : {})
    });
    server = app;
    const lookup = (url = `${lookupPath}/27`) => app.inject({ method: 'GET', url, headers: authorization });
    const start = (projectId = 'proj_1') => app.inject({
      method: 'POST', url: '/v1/conversations', headers: authorization,
      payload: {
        projectId, identity: 'test', topic: { title: 'Track issue 27' },
        submission: { kind: 'issue_reference', body: 'Start #27', workKind: 'bug', issue: { number: 27 } }
      }
    });
    return { app, lookup, start, findById, policy, read, createConversationWithFirstRun };
  }

  it('authenticates and passes the raw descriptor to policy before reading the tenant project', async () => {
    const { app, lookup, findById, policy, read, createConversationWithFirstRun } = await setup();
    for (const headers of [{}, { authorization: 'Bearer invalid' }]) {
      expect((await app.inject({ method: 'GET', url: `${lookupPath}/invalid`, headers })).statusCode).toBe(401);
    }
    expect(policy.authorize).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
    const found = await lookup(`${lookupPath}/00027`);
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ issue, workKind: { kind: 'feature', source: 'label' } });
    expect(policy.authorize).toHaveBeenCalledExactlyOnceWith({
      principal: hardcodedDevelopmentPrincipal, action: 'project_issue.read',
      resource: { kind: 'project_issue', id: 'proj_1', issueNumber: '00027', path: '/v1/projects/:id/issues/:number' }
    });
    expect(policy.authorize).toHaveBeenCalledBefore(findById);
    expect(findById).toHaveBeenCalledExactlyOnceWith(hardcodedDevelopmentPrincipal.tenantId, 'proj_1');
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ issueNumber: 27 }));
    expect(createConversationWithFirstRun).not.toHaveBeenCalled();
  });

  it.each([{ allowed: false, model: false }, { allowed: true, model: true }])(
    'rejects policy denial or model principals before parameter validation and I/O: %j', async auth => {
      const { lookup, findById, policy, read } = await setup({}, auth);
      const response = await lookup(`${lookupPath}/not-a-number`);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'forbidden', message: 'Forbidden.' } });
      expect(policy.authorize).toHaveBeenCalledOnce();
      expect(findById).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each(['0', '-1', '27.5', 'abc', '1e2', '9007199254740992'])('rejects invalid path number %s before I/O', async number => {
    const { lookup, findById, read } = await setup();
    const response = await lookup(`${lookupPath}/${number}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(findById).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  const trackerContext = { provider: 'github', repository: 'acme/demo', issueNumber: 27 };
  const sentinel = 'secret-and-raw-output-sentinel';
  const authFailure = new IssueTrackerError('tracker_auth_failed', sentinel, {
    safeDetails: { ...trackerContext, trackerCode: sentinel, code: sentinel, rawOutput: sentinel, credential: sentinel },
    cause: new Error(sentinel)
  });

  it.each([
    { label: 'no tracker', projectSettings: { issueTrackerSetting: null }, details: { code: 'tracker_not_configured' } },
    { label: 'no provider adapter', projectSettings: { issueTrackerSetting: { provider: 'unsupported' } }, details: { code: 'unsupported_tracker_provider' } },
    { label: 'no credential reference', projectSettings: { credentialRefs: [] }, details: { code: 'tracker_credential_missing' } },
    { label: 'rejected credential', failure: authFailure,
      details: { code: 'tracker_auth_failed', trackerCode: 'tracker_auth_failed', ...trackerContext } },
    { label: 'unusable credential', failure: new IssueTrackerError('tracker_credential_missing', sentinel, { safeDetails: { provider: 'github' } }),
      details: { code: 'tracker_credential_missing', trackerCode: 'tracker_credential_missing', provider: 'github' } },
    { label: 'invalid target', failure: new IssueTrackerError('tracker_target_invalid', sentinel),
      details: { code: 'tracker_target_invalid', trackerCode: 'tracker_target_invalid' } },
    { label: 'provider outage', failure: new IssueTrackerError('tracker_provider_unavailable', sentinel, {
      safeDetails: { provider: sentinel, repository: sentinel, issueNumber: '27', credentialRef: sentinel }
    }), details: { code: 'tracker_provider_unavailable', trackerCode: 'tracker_provider_unavailable' } },
    { label: 'invalid provider response', failure: new IssueTrackerError('tracker_response_invalid', sentinel),
      details: { code: 'tracker_response_invalid', trackerCode: 'tracker_response_invalid' } },
    { label: 'unclassified read failure', failure: new Error(sentinel), details: { code: 'tracker_read_failed' } }
  ])('normalizes $label identically at lookup and start', async ({ projectSettings, failure, details }) => {
    const { lookup, start, read, createConversationWithFirstRun } = await setup(projectSettings);
    if (failure) read.mockRejectedValue(failure);
    const preview = await lookup();
    const create = await start();
    for (const response of [preview, create]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('intake_routing_error');
      expect(response.json().error.details).toEqual(details);
      expect(response.body).not.toContain(sentinel);
      expect(response.body).not.toContain('credential-ref-sentinel');
    }
    expect(create.json()).toEqual(preview.json());
    if (failure === authFailure) expect(create.json().error.message).toBe('Failed to read issue from tracker: tracker_auth_failed.');
    expect(createConversationWithFirstRun).not.toHaveBeenCalled();
  });

  it('hides absent and cross-tenant projects identically and preserves the POST intake error', async () => {
    const { lookup, start, read, createConversationWithFirstRun } = await setup();
    for (const id of ['missing', 'other']) {
      const response = await lookup(`/v1/projects/${id}/issues/27`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Project not found.', details: { resource: 'project' } } });
      const create = await start(id);
      expect(create.statusCode).toBe(400);
      expect(create.json()).toEqual({
        error: { code: 'intake_routing_error', message: `Project '${id}' is not accessible.`, details: { code: 'project_not_accessible' } }
      });
    }
    expect(read).not.toHaveBeenCalled();
    expect(createConversationWithFirstRun).not.toHaveBeenCalled();
  });

  it('distinguishes a missing issue in GET and rereads when starting a run', async () => {
    const { lookup, start, read, createConversationWithFirstRun } = await setup();
    expect((await lookup()).statusCode).toBe(200);
    read.mockRejectedValue(new IssueTrackerError('issue_not_found', sentinel, { safeDetails: trackerContext }));
    const create = await start();
    expect(create.statusCode).toBe(400);
    expect(create.json()).toEqual({ error: {
      code: 'intake_routing_error', message: 'Failed to read issue from tracker: issue_not_found.',
      details: { code: 'issue_not_found', trackerCode: 'issue_not_found', ...trackerContext }
    } });
    const missing = await lookup();
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'Issue not found.', details: { resource: 'issue' } } });
    expect(read).toHaveBeenCalledTimes(3);
    expect(createConversationWithFirstRun).not.toHaveBeenCalled();
  });

  it('returns a sanitized 500 on unexpected repository and issue projection failures', async () => {
    const { lookup, findById, read } = await setup();
    findById.mockRejectedValueOnce(new Error(sentinel));
    read.mockResolvedValueOnce({ ...issue, url: sentinel });
    for (let i = 0; i < 2; i++) {
      const lookupResponse = await lookup();
      expect(lookupResponse.statusCode).toBe(500);
      expect(lookupResponse.json()).toEqual({ error: { code: 'internal_error', message: 'An internal server error occurred.' } });
    }
  });
});

async function buildServer(overrides?: Partial<ControlPlaneRouteDependencies>) {
  const bearerToken = 'test-token';
  const policyCalls: PolicyDecisionInput[] = [];
  const stored = new Map<string, ProbeResource>();

  const dependencies: ControlPlaneRouteDependencies = {
    health: { isDatabaseReachable: async () => true },
    auth: { bearerToken },
    policy: { authorize: async (input) => { policyCalls.push(input); return { allowed: true }; } },
    probeResources: {
      create: vi.fn(async (input) => {
        const resource: ProbeResource = { id: 'probe_123', value: input.value, createdAt: '2026-01-01T00:00:00.000Z' };
        stored.set(resource.id, resource);
        return resource;
      }),
      findById: vi.fn(async (id) => stored.get(id) ?? null)
    },
    configurationRecords: {
      create: vi.fn(async () => ({ id: 'cfg_123', tenant: 'tenant_dev', kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'openai', settings: { profileName: 'default' }, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' })),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    },
    secrets: {
      createSecret: vi.fn(async () => ({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' })),
      hasSecret: vi.fn(async () => true)
    },
    projects: {
      create: vi.fn(async () => { throw new Error('projects.create not stubbed for this test'); }),
      findById: (vi.fn(async () => null)) as ControlPlaneRouteDependencies['projects']['findById'],
      list: vi.fn(async () => []),
      update: vi.fn(async () => null)
    },
    controlPlane: createFakeControlPlaneService(),
    ...overrides
  };

  const app = Fastify({ logger: false });
  await registerControlPlaneRoutes(app, dependencies);
  return { app, authorization: { authorization: `Bearer ${bearerToken}` }, policyCalls };
}

describe('registerControlPlaneRoutes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>['app'] | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('registers unversioned health and returns degraded status when database is unreachable', async () => {
    const { app } = await buildServer({ health: { isDatabaseReachable: async () => false } });
    server = app;

    const healthy = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(healthy.statusCode).toBe(404);

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(degradedHealthStatusCode);
    expect(healthResponseSchema.parse(response.json())).toEqual({
      status: 'degraded',
      database: { status: 'unreachable' }
    });
  });

  it('serves /health without auth', async () => {
    const { app } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('rejects protected v1 requests without a valid bearer token before handlers run', async () => {
    const { app } = await buildServer();
    server = app;

    // Missing token
    const missing = await app.inject({ method: 'POST', url: '/v1/probe-resources', payload: { value: 'x' } });
    expect(missing.statusCode).toBe(401);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe('unauthorized');

    // Wrong token
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/probe-resources',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { value: 'x' }
    });
    expect(invalid.statusCode).toBe(401);
  });

  it('creates and reads a probe resource with contract status and shapes', async () => {
    const { app, authorization } = await buildServer();
    server = app;

    const created = await app.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      headers: authorization,
      payload: { value: 'through route' }
    });

    expect(created.statusCode).toBe(createProbeResourceSuccessStatusCode);
    const createdBody = probeResourceSchema.parse(created.json());
    expect(createdBody.value).toBe('through route');

    const read = await app.inject({
      method: 'GET',
      url: `${probeResourceCollectionPath}/${createdBody.id}`,
      headers: authorization
    });
    expect(read.statusCode).toBe(200);
    expect(probeResourceSchema.parse(read.json())).toEqual(createdBody);
  });

  it('consults policy for probe resource create', async () => {
    const { app, authorization, policyCalls } = await buildServer();
    server = app;

    await app.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      headers: authorization,
      payload: { value: 'policy test' }
    });

    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'probe_resource.create',
      resource: { kind: 'probe_resource_collection', path: '/v1/probe-resources' }
    });
  });

  it('returns contract error envelopes for invalid requests and missing resources', async () => {
    const { app, authorization } = await buildServer();
    server = app;

    const invalid = await app.inject({
      method: 'POST',
      url: probeResourceCollectionPath,
      headers: authorization,
      payload: { value: '' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalid.json()).error.code).toBe('validation_error');

    const missing = await app.inject({
      method: 'GET',
      url: `${probeResourceCollectionPath}/missing`,
      headers: authorization
    });
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe('not_found');
  });

  it('exposes the protected hardcoded principal diagnostic route', async () => {
    const { app, authorization, policyCalls } = await buildServer();
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/principal', headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(principalDiagnosticResponseSchema.parse(response.json())).toEqual({
      principal: hardcodedDevelopmentPrincipal
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'principal.diagnostic.read',
      resource: { kind: 'principal_diagnostic', path: '' }
    });
  });

  it('creates, lists, reads, updates, and deletes configuration records', async () => {
    const record = {
      id: 'cfg_123',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default' },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async () => record),
      list: vi.fn(async (_tenant: string) => [record]),
      findById: vi.fn(async (_tenant: string, id: string) => id === 'cfg_123' ? record : null),
      update: vi.fn(async (_tenant: string, id: string) => id === 'cfg_123' ? { ...record, updatedAt: '2026-06-08T01:00:00.000Z' } : null),
      delete: vi.fn(async (_tenant: string, id: string) => id === 'cfg_123')
    };
    const { app, authorization, policyCalls } = await buildServer({ configurationRecords: configRepo });
    server = app;

    // Create
    const createResponse = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: { kind: 'provider_profile', providerKind: 'model_runner', adapterId: 'openai', settings: { profileName: 'default' } }
    });
    expect(createResponse.statusCode).toBe(201);
    expect(configurationRecordResponseSchema.parse(createResponse.json())).toEqual(record);
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'configuration_record.create',
      resource: { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
    });

    // List
    const listResponse = await app.inject({ method: 'GET', url: '/v1/configuration-records', headers: authorization });
    expect(listResponse.statusCode).toBe(200);
    expect(configurationRecordListResponseSchema.parse(listResponse.json())).toEqual({ records: [record] });

    // Read
    const readResponse = await app.inject({ method: 'GET', url: '/v1/configuration-records/cfg_123', headers: authorization });
    expect(readResponse.statusCode).toBe(200);
    expect(configurationRecordResponseSchema.parse(readResponse.json())).toEqual(record);

    // Update
    const patchResponse = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/cfg_123', headers: authorization,
      payload: { kind: 'provider_profile', providerKind: 'updated_runner' }
    });
    expect(patchResponse.statusCode).toBe(200);

    // Delete
    const deleteResponse = await app.inject({ method: 'DELETE', url: '/v1/configuration-records/cfg_123', headers: authorization });
    expect(deleteResponse.statusCode).toBe(204);
    expect(deleteResponse.body).toBe('');
  });

  it('returns 404 for missing config records', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/configuration-records/cfg_missing', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('returns 400 for invalid config create request', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: { kind: 'provider_profile', providerKind: 'x', adapterId: 'y', settings: { profileName: '' } }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('returns 400 for empty patch body', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/cfg_123', headers: authorization,
      payload: {}
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when deleting a missing config record', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'DELETE', url: '/v1/configuration-records/cfg_missing', headers: authorization });
    expect(response.statusCode).toBe(404);
  });

  it('returns 422 when creating an active routing table that references a profile without model', async () => {
    const profileWithoutModel = {
      id: 'cfg_no_model',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: { profileName: 'No Model', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async (input: { kind: string }) => ({ ...profileWithoutModel, kind: input.kind })),
      list: vi.fn(async () => [profileWithoutModel]),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: {
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_model' }]
        }
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('profile_incomplete');
  });

  it('returns 422 when creating an active routing table that references a profile without credential', async () => {
    const profileWithoutCredential = {
      id: 'cfg_no_cred',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: {
        profileName: 'No Cred',
        model: { provider: 'anthropic', model: 'claude-sonnet-4' }
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async (input: { kind: string }) => ({ ...profileWithoutCredential, kind: input.kind })),
      list: vi.fn(async () => [profileWithoutCredential]),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: {
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_cred' }]
        }
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('profile_incomplete');
  });

  it('returns 422 when creating an active routing table that references a non-existent profile', async () => {
    const configRepo = {
      create: vi.fn(async (input: { kind: string }) => ({ id: 'cfg_new', tenant: 'tenant_dev', kind: input.kind, settings: {}, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' })),
      list: vi.fn(async () => []),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: {
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_does_not_exist' }]
        }
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('profile_not_found');
  });

  it('returns 422 when patching a routing table to active:true referencing a profile without model', async () => {
    const profileWithoutModel = {
      id: 'cfg_no_model',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: { profileName: 'No Model', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const existingRoutingTable = {
      id: 'tbl_existing',
      tenant: 'tenant_dev',
      kind: 'model_routing_table',
      settings: {
        active: false,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_model' }]
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async () => existingRoutingTable),
      list: vi.fn(async () => [profileWithoutModel, existingRoutingTable]),
      findById: vi.fn(async (_tenant: string, id: string) => id === 'tbl_existing' ? existingRoutingTable : null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/tbl_existing', headers: authorization,
      payload: {
        kind: 'model_routing_table',
        settings: { active: true }
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('profile_incomplete');
  });

  it('returns 422 when patching a routing table to active:true referencing a profile without credential', async () => {
    const profileWithoutCredential = {
      id: 'cfg_no_credential',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: { profileName: 'No Credential', model: { provider: 'anthropic', model: 'claude-sonnet-4' } },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const existingRoutingTable = {
      id: 'tbl_existing_nocred',
      tenant: 'tenant_dev',
      kind: 'model_routing_table',
      settings: {
        active: false,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_no_credential' }]
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async () => existingRoutingTable),
      list: vi.fn(async () => [profileWithoutCredential, existingRoutingTable]),
      findById: vi.fn(async (_tenant: string, id: string) => id === 'tbl_existing_nocred' ? existingRoutingTable : null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/tbl_existing_nocred', headers: authorization,
      payload: {
        kind: 'model_routing_table',
        settings: { active: true }
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('profile_incomplete');
  });

  it('allows creating an active routing table when the referenced profile is complete', async () => {
    const completeProfile = {
      id: 'cfg_complete',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: {
        profileName: 'Complete',
        credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
        model: { provider: 'anthropic', model: 'claude-sonnet-4' }
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const routingTableRecord = {
      id: 'tbl_new',
      tenant: 'tenant_dev',
      kind: 'model_routing_table',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_complete' }]
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async () => routingTableRecord),
      list: vi.fn(async () => [completeProfile]),
      findById: vi.fn(async () => null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/configuration-records', headers: authorization,
      payload: {
        kind: 'model_routing_table',
        settings: {
          active: true,
          entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_complete' }]
        }
      }
    });
    expect(response.statusCode).toBe(201);
  });

  it('returns 422 when patching a provider_profile to clear model while an active routing table references it', async () => {
    const completeProfile = {
      id: 'cfg_pp_model',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: {
        profileName: 'Complete',
        credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
        model: { provider: 'anthropic', model: 'claude-sonnet-4' }
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const activeRoutingTable = {
      id: 'tbl_active_pp',
      tenant: 'tenant_dev',
      kind: 'model_routing_table',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_pp_model' }]
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async () => completeProfile),
      list: vi.fn(async () => [completeProfile, activeRoutingTable]),
      findById: vi.fn(async (_tenant: string, id: string) => id === 'cfg_pp_model' ? completeProfile : null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/cfg_pp_model', headers: authorization,
      payload: {
        kind: 'provider_profile',
        settings: { model: null }
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('profile_incomplete');
  });

  it('returns 422 when patching a provider_profile to clear credential while an active routing table references it', async () => {
    const completeProfile = {
      id: 'cfg_pp_cred',
      tenant: 'tenant_dev',
      kind: 'provider_profile',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      settings: {
        profileName: 'Complete',
        credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
        model: { provider: 'anthropic', model: 'claude-sonnet-4' }
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const activeRoutingTable = {
      id: 'tbl_active_cred',
      tenant: 'tenant_dev',
      kind: 'model_routing_table',
      settings: {
        active: true,
        entries: [{ id: 'r1', route: { mode: 'agent', step: 'impl', role: 'implementer' }, profileId: 'cfg_pp_cred' }]
      },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    const configRepo = {
      create: vi.fn(async () => completeProfile),
      list: vi.fn(async () => [completeProfile, activeRoutingTable]),
      findById: vi.fn(async (_tenant: string, id: string) => id === 'cfg_pp_cred' ? completeProfile : null),
      update: vi.fn(async () => null),
      delete: vi.fn(async () => false)
    };
    const { app, authorization } = await buildServer({ configurationRecords: configRepo });
    server = app;
    const response = await app.inject({
      method: 'PATCH', url: '/v1/configuration-records/cfg_pp_cred', headers: authorization,
      payload: {
        kind: 'provider_profile',
        settings: { credentialSecretHandle: null }
      }
    });
    expect(response.statusCode).toBe(422);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('profile_incomplete');
  });

  it('creates a secret handle via POST /v1/secrets', async () => {
    const { app, authorization, policyCalls } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/secrets', headers: authorization,
      payload: { value: 'sk-test-secret' }
    });
    expect(response.statusCode).toBe(201);
    expect(createSecretResponseSchema.parse(response.json())).toEqual({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' });
    expect(response.body).not.toContain('sk-test-secret');
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'secret.create',
      resource: { kind: 'secret_collection', path: '/v1/secrets' }
    });
  });

  it('returns 400 for empty secret value', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/secrets', headers: authorization,
      payload: { value: '' }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('maps SecretStoreLockedError to 400 secret_store_locked without echoing value', async () => {
    const lockedSecrets = { createSecret: vi.fn(async () => { throw new SecretStoreLockedError(); }), hasSecret: vi.fn(async () => true) };
    const { app, authorization } = await buildServer({ secrets: lockedSecrets });
    server = app;
    const response = await app.inject({
      method: 'POST', url: '/v1/secrets', headers: authorization,
      payload: { value: 'my-secret-value' }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('secret_store_locked');
    expect(response.body).not.toContain('my-secret-value');
  });

  it('POST /v1/conversations returns 201 with the orchestrated result on success', async () => {
    const orchestratedResult = {
      conversation: { id: 'conv_1', projectId: 'proj_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', identity: 'I', activeTopicId: 'topic_1', createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' },
      topic: { id: 'topic_1', conversationId: 'conv_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', title: 'My Topic', kind: 'main', createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' },
      message: { id: 'msg_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', author: hardcodedDevelopmentPrincipal, direction: 'inbound', body: 'hello', createdAt: '2026-06-08T00:00:00.000Z' },
      run: { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' },
      runStep: { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: '2026-06-08T00:00:00.000Z', endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null }
    };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createConversationWithFirstRun as ReturnType<typeof vi.fn>).mockResolvedValue(orchestratedResult);
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: {
        projectId: 'proj_1',
        identity: 'I',
        topic: { title: 'My Topic' },
        submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(orchestratedResult);
    expect(controlPlane.createConversationWithFirstRun).toHaveBeenCalledWith(expect.objectContaining({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev'
    }));
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'conversation.create',
      resource: { kind: 'conversation_collection', path: '/v1/conversations' }
    });
  });

  it('POST /v1/conversations returns 400 for invalid bodies', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: { projectId: '' }
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('POST /v1/conversations maps intake_routing_error to 400 with details', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createConversationWithFirstRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('intake_routing_error', 'Unknown work kind.', { details: { code: 'unknown_work_kind' } })
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: {
        projectId: 'proj_1',
        identity: 'I',
        topic: { title: 'My Topic' },
        submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
      }
    });
    expect(response.statusCode).toBe(400);
    const parsed = errorResponseSchema.parse(response.json());
    expect(parsed.error.code).toBe('intake_routing_error');
    expect(parsed.error.details).toEqual({ code: 'unknown_work_kind' });
  });

  it('POST /v1/conversations maps active_run_conflict to 409 with details', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createConversationWithFirstRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('active_run_conflict', 'Active run conflict.', {
        details: { topicId: 'topic_1', existingRunId: 'run_99' }
      })
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: authorization,
      payload: {
        projectId: 'proj_1',
        identity: 'I',
        topic: { title: 'My Topic' },
        submission: { kind: 'free_form', body: 'hello', workKind: 'feature' }
      }
    });
    expect(response.statusCode).toBe(409);
    const parsed = errorResponseSchema.parse(response.json());
    expect(parsed.error.code).toBe('active_run_conflict');
    expect(parsed.error.details).toEqual({ topicId: 'topic_1', existingRunId: 'run_99' });
  });

  const routeRun: Run = {
    id: 'run_1',
    topicId: 'topic_1',
    owner: hardcodedDevelopmentPrincipal,
    tenant: 'tenant_dev',
    workKind: 'feature',
    currentStep: 'intake',
    terminal: false,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z'
  };

  it('GET /v1/runs returns 200 with tenant runs and calls listRuns with principal tenant', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ runs: [routeRun] });
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs', headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(runListResponseSchema.parse(response.json())).toEqual({ runs: [routeRun] });
    expect(controlPlane.listRuns).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev'
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run.list',
      resource: { kind: 'run_collection', path: '/v1/runs' }
    });
  });

  it('GET /v1/runs rejects unauthenticated requests with 401', async () => {
    const { app } = await buildServer();
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs' });

    expect(response.statusCode).toBe(401);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('unauthorized');
  });

  it('GET /v1/runs maps forbidden service errors to 403', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRuns as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('forbidden', 'Not authorized to list runs.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs', headers: authorization });

    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
  });

  it('GET /v1/runs passes normalized filters, limit, and decoded cursor to the service and encodes nextCursor', async () => {
    const controlPlane = createFakeControlPlaneService();
    const nextCursor = { createdAt: '2026-06-08T00:00:00.000Z', id: 'run_1' };
    (controlPlane.listRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ runs: [routeRun], nextCursor });
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const inboundCursor = encodeRunListCursor({ createdAt: '2026-06-07T00:00:00.000Z', id: 'run_0' });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/runs?status=failed,in_progress&projectId=proj_1&limit=25&cursor=${encodeURIComponent(inboundCursor)}`,
      headers: authorization
    });

    expect(response.statusCode).toBe(200);
    expect(controlPlane.listRuns).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      limit: 25,
      cursor: { createdAt: '2026-06-07T00:00:00.000Z', id: 'run_0' },
      filters: { status: ['failed', 'in_progress'], projectId: ['proj_1'] }
    });
    expect(runListResponseSchema.parse(response.json()).nextCursor).toBe(encodeRunListCursor(nextCursor));
  });

  it('GET /v1/runs rejects unknown query fields with 400 validation_error', async () => {
    const controlPlane = createFakeControlPlaneService();
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs?unknown=x', headers: authorization });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
    expect(controlPlane.listRuns).not.toHaveBeenCalled();
  });

  it('GET /v1/runs rejects repeated filter keys with 400 validation_error', async () => {
    const controlPlane = createFakeControlPlaneService();
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs?status=failed&status=in_progress', headers: authorization });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
    expect(controlPlane.listRuns).not.toHaveBeenCalled();
  });

  it.each(['status=failed,', 'status=,', 'status='])('GET /v1/runs rejects empty filter items (%s) with 400', async (queryString) => {
    const controlPlane = createFakeControlPlaneService();
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: `/v1/runs?${queryString}`, headers: authorization });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('GET /v1/runs rejects invalid enum values with 400', async () => {
    const controlPlane = createFakeControlPlaneService();
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs?status=paused', headers: authorization });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('GET /v1/runs rejects malformed cursors with 400 validation_error', async () => {
    const controlPlane = createFakeControlPlaneService();
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs?cursor=not-a-valid-cursor', headers: authorization });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
    expect(controlPlane.listRuns).not.toHaveBeenCalled();
  });

  it('GET /v1/runs/:id still reaches the single-run route', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRun as ReturnType<typeof vi.fn>).mockResolvedValue({ run: routeRun });
    (controlPlane.listRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ runs: [] });
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1', headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(routeRun);
    expect(controlPlane.getRun).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      runId: 'run_1'
    });
    expect(controlPlane.listRuns).not.toHaveBeenCalled();
  });

  it('GET /v1/runs/:id returns 200 with the run on success', async () => {
    const run = { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRun as ReturnType<typeof vi.fn>).mockResolvedValue({ run });
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1', headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(run);
    expect(controlPlane.getRun).toHaveBeenCalledWith({ principal: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', runId: 'run_1' });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run.read',
      resource: { kind: 'run', id: 'run_1', path: '/v1/runs/:id' }
    });
  });

  it('GET /v1/runs/:id maps not_found to 404', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id rejects unauthenticated requests with 401', async () => {
    const { app } = await buildServer();
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/runs/:id/steps returns 200 with the run-step list', async () => {
    const steps = [
      { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: '2026-06-08T00:00:00.000Z', endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null }
    ];
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRunSteps as ReturnType<typeof vi.fn>).mockResolvedValue({ steps });
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1/steps', headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ steps });
  });

  it('GET /v1/runs/:id/steps maps not_found to 404', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRunSteps as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing/steps', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id/events maps subscribeRunEvents not_found to 404 before writing SSE headers', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing/events', headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).not.toMatch(/event-stream/u);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id/events forwards last-event-id header to subscribeRunEvents', async () => {
    const events: AsyncIterable<never> = { async *[Symbol.asyncIterator]() { /* no events */ } };
    const subscription: RunEventSubscription = { events, close: () => {} };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected server address to be an object.');
    }

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${(address as { port: number }).port}/v1/runs/run_1/events`,
      { signal: controller.signal, headers: { ...authorization, 'last-event-id': 'evt_42' } }
    );
    // Read the body so the server's async iterator can detect end-of-stream
    await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);
    expect(controlPlane.subscribeRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', tenant: 'tenant_dev' })
    );
    expect(controlPlane.replayRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', tenant: 'tenant_dev', lastEventId: 'evt_42' })
    );
    controller.abort();
  });

  it('passes replay=retained to the service when ?replay=retained is set', async () => {
    const events: AsyncIterable<never> = { async *[Symbol.asyncIterator]() { /* no events */ } };
    const subscription: RunEventSubscription = { events, close: () => {} };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected server address to be an object.');
    }

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${(address as { port: number }).port}/v1/runs/run_1/events?replay=retained`,
      { signal: controller.signal, headers: authorization }
    );
    await response.text();
    expect(response.status).toBe(200);
    expect(controlPlane.replayRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', tenant: 'tenant_dev', replay: 'retained' })
    );
    controller.abort();
  });

  it('GET /v1/runs/:id/events writes event/id/data SSE frames for each published event', async () => {
    const timestamp = '2026-06-08T00:00:00.000Z';
    const run = { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: timestamp, updatedAt: timestamp };
    const runStep = { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: timestamp, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null };
    const sseEvent = {
      id: 'evt_abc',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: { directive: 'start' as const, toStep: 'intake' },
      run,
      runStep,
      tenant: 'tenant_dev',
      createdAt: timestamp
    };

    async function* generateEvents() { yield sseEvent; }
    const closeSpy = vi.fn();
    const subscription: RunEventSubscription = { events: { [Symbol.asyncIterator]: generateEvents }, close: closeSpy };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/run_1/events`, {
      headers: authorization
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);

    const body = await response.text();
    expect(body).toContain('event: run_state_transition\n');
    expect(body).toContain('id: evt_abc\n');
    expect(body).toContain(`data: ${JSON.stringify(sseEvent)}\n\n`);
  });

  it('GET /v1/runs/:id/events delivers live events when replay returns only pre-existing events', async () => {
    // Regression for dedup bug: if replay returns events that existed before subscribe(),
    // those ids will never appear in the live buffer. The route must still deliver live
    // events whose ids are not in the replay set.
    const timestamp = '2026-06-08T00:00:00.000Z';
    const run = { id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'intake', terminal: false, createdAt: timestamp, updatedAt: timestamp };
    const runStep = { id: 'step_1', runId: 'run_1', phase: 'intake', step: 'intake', role: 'none', startedAt: timestamp, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null };

    const replayEvent = {
      id: 'evt_replay_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: { directive: 'start' as const, toStep: 'intake' },
      run, runStep, tenant: 'tenant_dev', createdAt: timestamp
    };
    const liveEvent = {
      id: 'evt_live_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: { directive: 'start' as const, toStep: 'intake' },
      run, runStep, tenant: 'tenant_dev', createdAt: timestamp
    };

    async function* generateLive() { yield liveEvent; }
    const subscription: RunEventSubscription = {
      events: { [Symbol.asyncIterator]: generateLive },
      close: vi.fn()
    };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);
    (controlPlane.replayRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok' as const, events: [replayEvent]
    });

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/run_1/events`, {
      headers: { ...authorization, 'last-event-id': 'evt_prior' }
    });
    expect(response.status).toBe(200);
    const body = await response.text();

    // Both the replayed event and the subsequent live event must be present.
    expect(body).toContain('id: evt_replay_1\n');
    expect(body).toContain('id: evt_live_1\n');
  });

  it('GET /v1/runs/:id/events calls subscription.close() when server closes after stream ends', async () => {
    // Verify subscription.close() is called when the event stream completes naturally.
    // (The close() call in the finally block guarantees this.)
    let closeCalled = false;
    const events: AsyncIterable<never> = { async *[Symbol.asyncIterator]() { /* yields nothing */ } };
    const closeSpy = vi.fn(() => { closeCalled = true; });
    const subscription: RunEventSubscription = { events, close: closeSpy };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue(subscription);

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/run_1/events`, {
      headers: authorization
    });
    expect(response.status).toBe(200);

    // Read body to completion — when the generator ends naturally, finally calls close()
    await response.text();

    expect(closeSpy).toHaveBeenCalled();
    expect(closeCalled).toBe(true);
  });

  // Spec review route tests
  const specArtifact = {
    id: 'artifact_spec_1',
    runId: 'run_1',
    owner: hardcodedDevelopmentPrincipal,
    tenant: 'tenant_dev',
    kind: 'feature_spec',
    canonicalRecord: 'file',
    location: 'context-human/specs/feature-my-feature.md',
    cachedStatus: 'approved',
    publicationRefs: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z'
  };

  const specRunSpecResponse = {
    artifact: specArtifact,
    markdown: '# Feature Spec\n\nSome content.',
    frontmatter: {
      created: '2026-06-01',
      last_updated: '2026-06-08',
      status: 'approved',
      specced_by: 'mark-stafford'
    }
  };

  const specFeedback = {
    id: 'fbk_1',
    runId: 'run_1',
    owner: hardcodedDevelopmentPrincipal,
    tenant: 'tenant_dev',
    target: 'artifact' as const,
    status: 'open' as const,
    title: 'Missing acceptance criteria',
    body: 'Please add acceptance criteria to section 2.',
    thread: [
      {
        id: 'thread_1',
        author: hardcodedDevelopmentPrincipal,
        body: 'Please add acceptance criteria to section 2.',
        createdAt: '2026-06-08T00:00:00.000Z'
      }
    ],
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z'
  };

  it('GET /v1/runs/:id/spec returns 200 with spec response on success', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRunSpec as ReturnType<typeof vi.fn>).mockResolvedValue(specRunSpecResponse);
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1/spec', headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(runSpecResponseSchema.parse(response.json())).toEqual(specRunSpecResponse);
    expect(controlPlane.getRunSpec).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      runId: 'run_1'
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run_spec.read',
      resource: { kind: 'run_spec', id: 'run_1', path: '/v1/runs/:id/spec' }
    });
  });

  it('GET /v1/runs/:id/spec maps not_found to 404', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRunSpec as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing/spec', headers: authorization });

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id/spec maps persistence_failed to 500 without path details', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRunSpec as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('persistence_failed', 'Failed to read spec file from /absolute/path/on/disk.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1/spec', headers: authorization });

    expect(response.statusCode).toBe(500);
    const parsed = errorResponseSchema.parse(response.json());
    expect(parsed.error.code).toBe('internal_error');
    expect(parsed.error.message).toBe('An internal server error occurred.');
    expect(response.body).not.toContain('/absolute/path');
  });

  it('POST /v1/runs/:id/feedback returns 201 with the created feedback on success', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createRunFeedback as ReturnType<typeof vi.fn>).mockResolvedValue(specFeedback);
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback',
      headers: authorization,
      payload: { target: 'artifact', title: 'Missing acceptance criteria', body: 'Please add acceptance criteria to section 2.' }
    });

    expect(response.statusCode).toBe(201);
    expect(feedbackSchema.parse(response.json())).toEqual(specFeedback);
    expect(controlPlane.createRunFeedback).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      runId: 'run_1',
      request: { target: 'artifact', title: 'Missing acceptance criteria', body: 'Please add acceptance criteria to section 2.' }
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run_feedback.create',
      resource: { kind: 'run_feedback', id: 'run_1', path: '/v1/runs/:id/feedback' }
    });
  });

  it('GET /v1/runs/:id serializes reviewer_result_missing and SSE delivers matching transition.reason', async () => {
    const timestamp = '2026-06-08T00:00:00.000Z';
    const failedRun: Run = {
      id: 'run_reviewer_missing_1',
      topicId: 'topic_1',
      owner: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      workKind: 'feature',
      currentStep: 'failed',
      terminal: true,
      failureReason: 'reviewer_result_missing',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const runStep = {
      id: 'step_1',
      runId: 'run_reviewer_missing_1',
      phase: null,
      step: 'failed',
      role: 'none',
      startedAt: timestamp,
      endedAt: null,
      durationMs: null,
      occurrence: { index: 0, attempt: 1 },
      checkpointResult: null
    };
    const failTransitionEvent = {
      id: 'evt_reviewer_missing_1',
      type: 'run_state_transition' as const,
      runId: 'run_reviewer_missing_1',
      transition: { directive: 'fail' as const, fromStep: 'spec.author', toStep: 'failed', reason: 'reviewer_result_missing' },
      run: failedRun,
      runStep,
      tenant: 'tenant_dev',
      createdAt: timestamp
    };

    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRun as ReturnType<typeof vi.fn>).mockResolvedValue({ run: failedRun });
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: { async *[Symbol.asyncIterator]() { /* no events */ } },
      close: vi.fn()
    });
    (controlPlane.replayRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok' as const,
      events: [failTransitionEvent]
    });

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    // GET /v1/runs/:id — must include failureReason
    const getResponse = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_reviewer_missing_1',
      headers: authorization
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().failureReason).toBe('reviewer_result_missing');
    expectNoSentinels(getResponse.body);

    // GET /v1/runs/:id/events (SSE via inject) — must contain reason and failureReason
    const sseResponse = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_reviewer_missing_1/events',
      headers: authorization
    });
    expect(sseResponse.statusCode).toBe(200);
    expect(sseResponse.body).toContain('event: run_state_transition');
    expect(sseResponse.body).toContain('"reason":"reviewer_result_missing"');
    expect(sseResponse.body).toContain('"failureReason":"reviewer_result_missing"');
    expect(sseResponse.body).not.toContain('API Error: Overloaded');
    expect(sseResponse.body).not.toContain('sk-test-secret');
    expectNoSentinels(sseResponse.body);
  });

  it('POST /v1/runs/:id/feedback returns 400 for an anchor on implementation feedback', async () => {
    const controlPlane = createFakeControlPlaneService();
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback',
      headers: authorization,
      payload: {
        target: 'implementation',
        title: 'Missing acceptance criteria',
        body: 'Please add acceptance criteria.',
        anchor: { kind: 'artifact', artifactId: 'art_1' }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
    expect(controlPlane.createRunFeedback).not.toHaveBeenCalled();
  });

  it('POST /v1/runs/:id/feedback maps not_found to 404', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createRunFeedback as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/missing/feedback',
      headers: authorization,
      payload: { target: 'artifact', title: 'Title', body: 'Body text.' }
    });

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('POST /v1/runs/:id/feedback maps unauthorized to 403', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createRunFeedback as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('unauthorized', 'Not authorized to create run feedback.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback',
      headers: authorization,
      payload: { target: 'artifact', title: 'Title', body: 'Body text.' }
    });

    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
  });

  it('GET /v1/runs/:id/feedback returns 200 with feedback list on success', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRunFeedback as ReturnType<typeof vi.fn>).mockResolvedValue({ feedback: [specFeedback] });
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_1/feedback', headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(runFeedbackListResponseSchema.parse(response.json())).toEqual({ feedback: [specFeedback] });
    expect(controlPlane.listRunFeedback).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      runId: 'run_1'
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run_feedback.list',
      resource: { kind: 'run_feedback', id: 'run_1', path: '/v1/runs/:id/feedback' }
    });
  });

  it('GET /v1/runs/:id/feedback maps not_found to 404', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.listRunFeedback as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'GET', url: '/v1/runs/missing/feedback', headers: authorization });

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('GET /v1/runs/:id serializes failureReason and SSE delivers matching transition.reason', async () => {
    const timestamp = '2026-06-08T00:00:00.000Z';
    const failedRun: Run = {
      id: 'run_failed_1',
      topicId: 'topic_1',
      owner: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      workKind: 'feature',
      currentStep: 'failed',
      terminal: true,
      failureReason: 'provider_auth_failed',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const runStep = {
      id: 'step_1',
      runId: 'run_failed_1',
      phase: null,
      step: 'failed',
      role: 'none',
      startedAt: timestamp,
      endedAt: null,
      durationMs: null,
      occurrence: { index: 0, attempt: 1 },
      checkpointResult: null
    };
    const failTransitionEvent = {
      id: 'evt_fail_1',
      type: 'run_state_transition' as const,
      runId: 'run_failed_1',
      transition: { directive: 'fail' as const, fromStep: 'spec.author', toStep: 'failed', reason: 'provider_auth_failed' },
      run: failedRun,
      runStep,
      tenant: 'tenant_dev',
      createdAt: timestamp
    };

    const controlPlane = createFakeControlPlaneService();
    (controlPlane.getRun as ReturnType<typeof vi.fn>).mockResolvedValue({ run: failedRun });
    (controlPlane.subscribeRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      events: { async *[Symbol.asyncIterator]() { /* no events */ } },
      close: vi.fn()
    });
    (controlPlane.replayRunEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'ok' as const,
      events: [failTransitionEvent]
    });

    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    // GET /v1/runs/:id — must include failureReason
    const getResponse = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_failed_1',
      headers: authorization
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().failureReason).toBe('provider_auth_failed');
    expectNoSentinels(getResponse.body);

    // GET /v1/runs/:id/events (SSE via inject) — must contain reason and failureReason
    const sseResponse = await app.inject({
      method: 'GET',
      url: '/v1/runs/run_failed_1/events',
      headers: authorization
    });
    expect(sseResponse.statusCode).toBe(200);
    expect(sseResponse.body).toContain('event: run_state_transition');
    expect(sseResponse.body).toContain('"reason":"provider_auth_failed"');
    expect(sseResponse.body).toContain('"failureReason":"provider_auth_failed"');
    expectNoSentinels(sseResponse.body);
  });

  it('POST /v1/runs/:id/feedback/:feedbackId/thread appends a thread reply and returns 200', async () => {
    const feedbackWithTwoReplies = {
      ...specFeedback,
      thread: [
        {
          id: 'thread_1',
          author: hardcodedDevelopmentPrincipal,
          body: 'Please add acceptance criteria to section 2.',
          createdAt: '2026-06-08T00:00:00.000Z'
        },
        {
          id: 'thread_2',
          author: hardcodedDevelopmentPrincipal,
          body: 'Reply body',
          createdAt: '2026-06-14T00:00:00.000Z'
        }
      ]
    };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.appendRunFeedbackThreadReply as ReturnType<typeof vi.fn>).mockResolvedValue(feedbackWithTwoReplies);
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback/fb_1/thread',
      headers: authorization,
      payload: { body: 'Reply body' }
    });

    expect(response.statusCode).toBe(200);
    const parsed = feedbackSchema.parse(response.json());
    expect(parsed.thread).toHaveLength(2);
    expect(controlPlane.appendRunFeedbackThreadReply).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      runId: 'run_1',
      feedbackId: 'fb_1',
      body: 'Reply body'
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run_feedback.thread.append',
      resource: { kind: 'run_feedback_thread', id: 'run_1', path: '/v1/runs/:id/feedback/:feedbackId/thread' }
    });
  });

  it('POST /v1/runs/:id/feedback/:feedbackId/thread returns 404 for unknown feedback', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.appendRunFeedbackThreadReply as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', 'Feedback not found.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback/fb_missing/thread',
      headers: authorization,
      payload: { body: 'Reply body' }
    });

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('POST /v1/runs/:id/feedback/:feedbackId/thread returns 400 for invalid body', async () => {
    const { app, authorization } = await buildServer();
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback/fb_1/thread',
      headers: authorization,
      payload: { body: '' }
    });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('POST /v1/runs/:id/feedback/:feedbackId/thread maps unauthorized to 403', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.appendRunFeedbackThreadReply as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('unauthorized', 'Not authorized.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback/fb_1/thread',
      headers: authorization,
      payload: { body: 'Reply body' }
    });

    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
  });

  it('POST /v1/runs/:id/feedback round-trips an artifact_range anchor with emoji codepoints', async () => {
    const anchorRangeFeedback = {
      ...specFeedback,
      id: 'fbk_range_1',
      title: 'Range anchor feedback',
      body: 'Test emoji codepoints.',
      anchor: {
        kind: 'artifact_range' as const,
        artifactId: 'art_spec_1',
        from: 6,
        to: 8,
        quotedText: '😄x'
      },
      thread: [
        {
          id: 'thread_1',
          author: hardcodedDevelopmentPrincipal,
          body: 'Test emoji codepoints.',
          createdAt: '2026-06-14T00:00:00.000Z'
        }
      ]
    };

    const controlPlane = createFakeControlPlaneService();
    (controlPlane.createRunFeedback as ReturnType<typeof vi.fn>).mockResolvedValue(anchorRangeFeedback);
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/feedback',
      headers: authorization,
      payload: {
        target: 'artifact',
        title: 'Range anchor feedback',
        body: 'Test emoji codepoints.',
        anchor: { kind: 'artifact_range', artifactId: 'art_spec_1', from: 6, to: 8, quotedText: '😄x' }
      }
    });

    expect(response.statusCode).toBe(201);
    const parsed = feedbackSchema.parse(response.json());
    expect(parsed.anchor).toEqual({
      kind: 'artifact_range',
      artifactId: 'art_spec_1',
      from: 6,
      to: 8,
      quotedText: '😄x'
    });
  });

  it('POST /v1/runs/:id/replies returns 200 with classification on success', async () => {
    const replyResponse = {
      run: {
        id: 'run_1',
        topicId: 'topic_1',
        owner: hardcodedDevelopmentPrincipal,
        tenant: 'tenant_dev',
        workKind: 'feature',
        currentStep: 'spec.human_review',
        terminal: false,
        waitingOn: 'human',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z'
      },
      classification: { directive: 'advance' as const, target: 'artifact' as const }
    };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.replyToRun as ReturnType<typeof vi.fn>).mockResolvedValue(replyResponse);
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/replies',
      headers: authorization,
      payload: { kind: 'approve' }
    });

    expect(response.statusCode).toBe(200);
    expect(runReplyResponseSchema.parse(response.json())).toMatchObject({ classification: { directive: 'advance', target: 'artifact' } });
    expect(controlPlane.replyToRun).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      runId: 'run_1',
      request: { kind: 'approve' }
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run_replies.create',
      resource: { kind: 'run_replies', id: 'run_1', path: '/v1/runs/:id/replies' }
    });
  });

  it('POST /v1/runs/:id/replies maps conflict error to 409', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.replyToRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('conflict', 'Run is terminal.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/replies',
      headers: authorization,
      payload: { kind: 'guidance', body: 'Use A.' }
    });

    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('conflict');
  });

  it('POST /v1/runs/:id/recover returns 200 with the reopened run and mode, and authorizes recovery', async () => {
    const recoveredRun = {
      id: 'run_1',
      topicId: 'topic_1',
      owner: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      workKind: 'feature',
      currentStep: 'implementation.build',
      terminal: false,
      waitingOn: 'ai' as const,
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T00:00:00.000Z'
    };
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.recoverRun as ReturnType<typeof vi.fn>).mockResolvedValue({ run: recoveredRun, mode: 'resume' });
    const { app, authorization, policyCalls } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/recover',
      headers: authorization,
      payload: { mode: 'resume' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: 'resume', run: { id: 'run_1' } });
    expect(controlPlane.recoverRun).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      tenant: 'tenant_dev',
      runId: 'run_1',
      request: { mode: 'resume' }
    });
    expect(policyCalls).toContainEqual({
      principal: hardcodedDevelopmentPrincipal,
      action: 'run_recovery.create',
      resource: { kind: 'run_recovery', id: 'run_1', path: '/v1/runs/:id/recover' }
    });
  });

  it('POST /v1/runs/:id/recover treats a missing body as an empty recovery request', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.recoverRun as ReturnType<typeof vi.fn>).mockResolvedValue({
      run: {
        id: 'run_1', topicId: 'topic_1', owner: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev',
        workKind: 'feature', currentStep: 'spec.author', terminal: false, waitingOn: 'ai' as const,
        createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z'
      },
      mode: 'start_over'
    });
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'POST', url: '/v1/runs/run_1/recover', headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(controlPlane.recoverRun).toHaveBeenCalledWith(expect.objectContaining({ request: {} }));
  });

  it('POST /v1/runs/:id/recover rejects an unknown field with 400', async () => {
    const controlPlane = createFakeControlPlaneService();
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/recover',
      headers: authorization,
      payload: { mode: 'resume', unexpected: true }
    });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
    expect(controlPlane.recoverRun).not.toHaveBeenCalled();
  });

  it('POST /v1/runs/:id/recover maps conflict error to 409', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.recoverRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('conflict', 'run_branch_missing')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({ method: 'POST', url: '/v1/runs/run_1/recover', headers: authorization, payload: { mode: 'resume' } });

    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('conflict');
  });

  it('POST /v1/runs/:id/recover maps not_found to 404 and active_run_conflict to 409', async () => {
    const notFound = createFakeControlPlaneService();
    (notFound.recoverRun as ReturnType<typeof vi.fn>).mockRejectedValue(new ControlPlaneServiceError('not_found', 'Run not found.'));
    const nf = await buildServer({ controlPlane: notFound });
    const nfResponse = await nf.app.inject({ method: 'POST', url: '/v1/runs/run_x/recover', headers: nf.authorization, payload: {} });
    expect(nfResponse.statusCode).toBe(404);
    await nf.app.close();

    const conflict = createFakeControlPlaneService();
    (conflict.recoverRun as ReturnType<typeof vi.fn>).mockRejectedValue(new ControlPlaneServiceError('active_run_conflict', 'Active run conflict.'));
    const { app, authorization } = await buildServer({ controlPlane: conflict });
    server = app;
    const response = await app.inject({ method: 'POST', url: '/v1/runs/run_1/recover', headers: authorization, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('active_run_conflict');
  });

  it('POST /v1/runs/:id/replies maps invalid_transition error to 400', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.replyToRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('invalid_transition', 'Feedback blocks review approval.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/replies',
      headers: authorization,
      payload: { kind: 'approve' }
    });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('invalid_transition');
  });

  it('POST /v1/runs/:id/replies maps unsupported_pause error to 409', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.replyToRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('unsupported_pause', 'Unsupported human pause.')
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/replies',
      headers: authorization,
      payload: { kind: 'guidance', body: 'Use option A.' }
    });

    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('unsupported_pause');
  });

  it('POST /v1/runs/:id/replies returns 400 for invalid body', async () => {
    const { app, authorization } = await buildServer();
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run_1/replies',
      headers: authorization,
      payload: { kind: 'unknown_kind' }
    });

    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('POST /v1/runs/:id/replies returns 404 when run is not found', async () => {
    const controlPlane = createFakeControlPlaneService();
    (controlPlane.replyToRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ControlPlaneServiceError('not_found', "Run 'missing' not found.")
    );
    const { app, authorization } = await buildServer({ controlPlane });
    server = app;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/missing/replies',
      headers: authorization,
      payload: { kind: 'approve' }
    });

    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('exposes an SSE route with event-stream semantics', async () => {
    const { app, authorization } = await buildServer();
    server = app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected server address to be an object.');
    }

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${(address as { port: number }).port}${eventsStreamPath}`,
      {
        signal: controller.signal,
        headers: authorization
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/u);
    expect(response.headers.get('cache-control')).toContain('no-cache');

    controller.abort(); // Close the SSE connection cleanly
  });

  describe('POST /v1/pull-requests/reconcile', () => {
    it('returns 200 with reconciliation summary and calls service with principal and tenant', async () => {
      const controlPlane = createFakeControlPlaneService();
      (controlPlane.reconcilePullRequests as ReturnType<typeof vi.fn>).mockResolvedValue({ checked: 3, merged: 1, closed: 1, failed: 0, timedOut: false });
      const { app, authorization, policyCalls } = await buildServer({ controlPlane });
      server = app;

      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath,
        headers: authorization
      });

      expect(response.statusCode).toBe(reconcilePullRequestsSuccessStatusCode);
      expect(pullRequestReconciliationResponseSchema.parse(response.json())).toEqual({ checked: 3, merged: 1, closed: 1, failed: 0, timedOut: false });
      expect(controlPlane.reconcilePullRequests).toHaveBeenCalledWith({
        principal: hardcodedDevelopmentPrincipal,
        tenant: hardcodedDevelopmentPrincipal.tenantId
      });
      expect(policyCalls).toContainEqual({
        principal: hardcodedDevelopmentPrincipal,
        action: 'pull_request.reconcile',
        resource: { kind: 'pull_request_reconciliation', path: '/v1/pull-requests/reconcile' }
      });
    });

    it('returns 401 when no auth header is provided', async () => {
      const { app } = await buildServer();
      server = app;

      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath
      });

      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('unauthorized');
    });

    it('ignores body fields and does not leak attacker-provided token', async () => {
      const { app, authorization } = await buildServer();
      server = app;

      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath,
        headers: authorization,
        payload: { tenant: 'attacker_tenant', runId: 'run_attacker', token: 'ghp_TEST_TOKEN_123' }
      });

      expect(response.statusCode).toBe(reconcilePullRequestsSuccessStatusCode);
      expect(response.body).not.toContain('ghp_TEST_TOKEN_123');
    });

    it('returns 500 sanitized response when service throws persistence_failed', async () => {
      const controlPlane = createFakeControlPlaneService();
      (controlPlane.reconcilePullRequests as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ControlPlaneServiceError('persistence_failed', 'DB connection failed at /internal/path.')
      );
      const { app, authorization } = await buildServer({ controlPlane });
      server = app;

      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath,
        headers: authorization
      });

      expect(response.statusCode).toBe(500);
      const parsed = errorResponseSchema.parse(response.json());
      expect(parsed.error.code).toBe('internal_error');
      expect(parsed.error.message).toBe('An internal server error occurred.');
      expect(response.body).not.toContain('/internal/path');
    });

    it('returns 403 when policy denies the request', async () => {
      const { app, authorization } = await buildServer({
        policy: { authorize: async () => ({ allowed: false }) }
      });
      server = app;

      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath,
        headers: authorization
      });

      expect(response.statusCode).toBe(403);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
    });

    it('returns 403 when an authenticated model principal calls the route', async () => {
      const { app, authorization } = await buildServer({
        auth: {
          bearerToken: 'test-token',
          resolvePrincipal: async () => ({ id: 'principal_model_123', kind: 'model' as const, tenantId: 'tenant_dev' })
        }
      });
      server = app;

      const response = await app.inject({
        method: 'POST',
        url: pullRequestReconciliationPath,
        headers: authorization
      });

      expect(response.statusCode).toBe(403);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
    });
  });

  describe('project routes', () => {
    const now = '2026-06-08T00:00:00.000Z';
    const makeProject = (overrides: Record<string, unknown> = {}) => ({
      id: 'proj_1',
      owner: { id: 'principal_dev_human', kind: 'human', tenantId: 'tenant_dev', displayName: 'Development Principal' },
      tenant: 'tenant_dev',
      displayName: 'Autocatalyst',
      repoUrl: 'https://github.com/example/repo',
      hostRepository: { provider: 'github', owner: 'example', name: 'repo' },
      workspaceRootOverride: null,
      issueTrackerSetting: null,
      codeHostSetting: null,
      credentialRefs: [],
      createdAt: now,
      updatedAt: now,
      ...overrides
    });
    const validCreateBody = {
      displayName: 'Autocatalyst',
      repoUrl: 'https://github.com/example/repo',
      hostRepository: { provider: 'github', owner: 'example', name: 'repo' }
    };

    it('creates a project and returns 201 after calling the policy point', async () => {
      const create = vi.fn(async () => makeProject());
      const { app, authorization, policyCalls } = await buildServer({
        projects: {
          create: create as never,
          findById: (vi.fn(async () => null)) as never,
          list: vi.fn(async () => []),
          update: vi.fn(async () => null)
        }
      });
      server = app;

      const response = await app.inject({ method: 'POST', url: projectCollectionPath, headers: authorization, payload: validCreateBody });
      expect(response.statusCode).toBe(201);
      expect(projectResponseSchema.parse(response.json()).id).toBe('proj_1');
      expect(create).toHaveBeenCalled();
      expect(policyCalls.some((c) => c.action === 'project.create')).toBe(true);
    });

    it('returns 400 for an unsafe non-https repo url', async () => {
      const { app, authorization } = await buildServer();
      server = app;
      const response = await app.inject({ method: 'POST', url: projectCollectionPath, headers: authorization, payload: { ...validCreateBody, repoUrl: 'http://github.com/example/repo' } });
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
    });

    it('returns 403 for a model principal creating a project', async () => {
      const { app, authorization } = await buildServer({
        auth: { bearerToken: 'test-token', resolvePrincipal: async () => ({ id: 'principal_model', kind: 'model' as const, tenantId: 'tenant_dev' }) }
      });
      server = app;
      const response = await app.inject({ method: 'POST', url: projectCollectionPath, headers: authorization, payload: validCreateBody });
      expect(response.statusCode).toBe(403);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
    });

    it('returns 409 when the host repository already exists in the tenant', async () => {
      const { app, authorization } = await buildServer({
        projects: {
          create: (vi.fn(async () => makeProject())) as never,
          findById: (vi.fn(async () => null)) as never,
          list: vi.fn(async () => [makeProject()]),
          update: vi.fn(async () => null)
        }
      });
      server = app;
      const response = await app.inject({ method: 'POST', url: projectCollectionPath, headers: authorization, payload: validCreateBody });
      expect(response.statusCode).toBe(409);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('conflict');
    });

    it('maps unknown_credential_reference to 422 with safe code, message, and field paths on create', async () => {
      const create = vi.fn(async () => makeProject());
      const handle = 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
      const { app, authorization } = await buildServer({
        secrets: {
          createSecret: vi.fn(async () => ({ handle })),
          hasSecret: vi.fn(async () => false)
        },
        projects: {
          create: create as never,
          findById: (vi.fn(async () => null)) as never,
          list: vi.fn(async () => []),
          update: vi.fn(async () => null)
        }
      });
      server = app;

      const response = await app.inject({
        method: 'POST',
        url: projectCollectionPath,
        headers: authorization,
        payload: { ...validCreateBody, credentialRefs: [{ id: handle, purpose: 'repo' }] }
      });
      expect(response.statusCode).toBe(422);
      const parsed = errorResponseSchema.parse(response.json());
      expect(parsed.error.code).toBe('unknown_credential_reference');
      expect(parsed.error.message).toBeTruthy();
      expect(parsed.error.details).toEqual({ fields: ['credentialRefs[0]'] });
      // The offending handle value must not be echoed back to the client.
      expect(JSON.stringify(parsed)).not.toContain(handle);
      // Validation failed before persistence.
      expect(create).not.toHaveBeenCalled();
    });

    it('maps unknown_credential_reference to 422 on patch', async () => {
      const update = vi.fn(async () => makeProject());
      const handle = 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
      const { app, authorization } = await buildServer({
        secrets: {
          createSecret: vi.fn(async () => ({ handle })),
          hasSecret: vi.fn(async () => false)
        },
        projects: {
          create: (vi.fn()) as never,
          // The patched project exists in the tenant; the unknown handle is what triggers 422.
          findById: (vi.fn(async (_tenant: string, id: string) => (id === 'proj_1' ? makeProject() : null))) as never,
          list: vi.fn(async () => []),
          update: update as never
        }
      });
      server = app;

      const response = await app.inject({
        method: 'PATCH',
        url: `${projectCollectionPath}/proj_1`,
        headers: authorization,
        payload: { credentialRefs: [{ id: handle, purpose: 'repo' }] }
      });
      expect(response.statusCode).toBe(422);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('unknown_credential_reference');
      expect(update).not.toHaveBeenCalled();
    });

    it('lists projects for the caller tenant', async () => {
      const { app, authorization } = await buildServer({
        projects: {
          create: (vi.fn()) as never,
          findById: (vi.fn(async () => null)) as never,
          list: vi.fn(async () => [makeProject()]),
          update: vi.fn(async () => null)
        }
      });
      server = app;
      const response = await app.inject({ method: 'GET', url: projectCollectionPath, headers: authorization });
      expect(response.statusCode).toBe(200);
      expect(projectListResponseSchema.parse(response.json()).projects).toHaveLength(1);
    });

    it('reads a single project and returns 404 for missing/cross-tenant ids', async () => {
      const { app, authorization } = await buildServer({
        projects: {
          create: (vi.fn()) as never,
          findById: (vi.fn(async (_tenant: string, id: string) => (id === 'proj_1' ? makeProject() : null))) as never,
          list: vi.fn(async () => []),
          update: vi.fn(async () => null)
        }
      });
      server = app;
      const ok = await app.inject({ method: 'GET', url: `${projectCollectionPath}/proj_1`, headers: authorization });
      expect(ok.statusCode).toBe(200);
      const missing = await app.inject({ method: 'GET', url: `${projectCollectionPath}/proj_absent`, headers: authorization });
      expect(missing.statusCode).toBe(404);
    });

    it('updates a project, rejects empty/immutable patches, and 404s missing ids', async () => {
      const update = vi.fn(async () => makeProject({ displayName: 'Renamed' }));
      const { app, authorization } = await buildServer({
        projects: {
          create: (vi.fn()) as never,
          // proj_1 exists in the tenant so the rename reaches the update path; other ids 404.
          findById: (vi.fn(async (_tenant: string, id: string) => (id === 'proj_1' ? makeProject() : null))) as never,
          list: vi.fn(async () => []),
          update: update as never
        }
      });
      server = app;

      const ok = await app.inject({ method: 'PATCH', url: `${projectCollectionPath}/proj_1`, headers: authorization, payload: { displayName: 'Renamed' } });
      expect(ok.statusCode).toBe(200);
      expect(projectResponseSchema.parse(ok.json()).displayName).toBe('Renamed');

      const empty = await app.inject({ method: 'PATCH', url: `${projectCollectionPath}/proj_1`, headers: authorization, payload: {} });
      expect(empty.statusCode).toBe(400);

      const immutable = await app.inject({ method: 'PATCH', url: `${projectCollectionPath}/proj_1`, headers: authorization, payload: { repoUrl: 'https://github.com/example/other' } });
      expect(immutable.statusCode).toBe(400);
    });

    it('returns 404 when updating a missing or cross-tenant project', async () => {
      const { app, authorization } = await buildServer({
        projects: {
          create: (vi.fn()) as never,
          findById: (vi.fn(async () => null)) as never,
          list: vi.fn(async () => []),
          update: vi.fn(async () => null)
        }
      });
      server = app;
      const response = await app.inject({ method: 'PATCH', url: `${projectCollectionPath}/proj_absent`, headers: authorization, payload: { displayName: 'x' } });
      expect(response.statusCode).toBe(404);
    });

    it('returns 403 for a model principal updating a project', async () => {
      const { app, authorization } = await buildServer({
        auth: { bearerToken: 'test-token', resolvePrincipal: async () => ({ id: 'principal_model', kind: 'model' as const, tenantId: 'tenant_dev' }) }
      });
      server = app;
      const response = await app.inject({ method: 'PATCH', url: `${projectCollectionPath}/proj_1`, headers: authorization, payload: { displayName: 'x' } });
      expect(response.statusCode).toBe(403);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('forbidden');
    });
  });
});

describe('GET /v1/runs/:id/workflow', () => {
  const run: Run = {
    id: 'run_workflow', topicId: 'topic_workflow', tenant: hardcodedDevelopmentPrincipal.tenantId,
    owner: { ...hardcodedDevelopmentPrincipal, kind: 'human' }, workKind: 'question',
    currentStep: 'intake', terminal: false,
    createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z'
  };
  const url = `/v1/runs/${run.id}/workflow`;
  const fault = { error: { code: 'internal_error', message: 'An internal server error occurred.' } };
  let app: Awaited<ReturnType<typeof buildServer>>['app'] | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function setup(kind: 'human' | 'model' = 'human') {
    const principal = { ...hardcodedDevelopmentPrincipal, kind };
    const routePolicy = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const servicePolicy = { authorize: vi.fn().mockResolvedValue({ allowed: true }) };
    const findById = vi.fn<RunRepository['findById']>().mockResolvedValue(run);
    const listByRun = vi.fn<RunStepRepository['listByRun']>();
    const resolver = vi.fn().mockResolvedValue(runWorkflows.question);
    const controlPlane = new DefaultControlPlaneService({
      ...({} as DefaultControlPlaneServiceOptions),
      policy: servicePolicy,
      runs: { ...({} as RunRepository), findById },
      runSteps: { ...({} as RunStepRepository), listByRun },
      workflowResolver: resolver
    });
    const server = await buildServer({
      auth: { bearerToken: 'test-token', resolvePrincipal: () => principal },
      controlPlane,
      policy: routePolicy
    });
    app = server.app;
    const request = () => server.app.inject({ url, headers: server.authorization });
    const decision = { principal, action: 'run_workflow.read', resource: { kind: 'run_workflow', id: run.id, path: '/v1/runs/:id/workflow' } };
    return { server, request, decision, routePolicy, servicePolicy, findById, listByRun, resolver };
  }

  it('authenticates and authorizes both layers before loading the run and never reads history', async () => {
    const { server, request, decision, routePolicy, servicePolicy, findById, listByRun, resolver } = await setup();
    expect((await server.app.inject({ url })).statusCode).toBe(401);
    expect(routePolicy.authorize).not.toHaveBeenCalled();

    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ workflowId: 'question', phases: [] });
    expect(routePolicy.authorize).toHaveBeenCalledExactlyOnceWith(decision);
    expect(servicePolicy.authorize).toHaveBeenCalledExactlyOnceWith(decision);
    expect(findById).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(resolver).toHaveBeenCalledExactlyOnceWith({ kind: 'existing_run', run });
    const order = [routePolicy.authorize, servicePolicy.authorize, findById, resolver]
      .map(spy => spy.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(listByRun).not.toHaveBeenCalled();
  });

  it('returns a validation envelope for an empty run ID without loading a run', async () => {
    const { server, findById, servicePolicy, resolver } = await setup();
    const response = await server.app.inject({ url: '/v1/runs//workflow', headers: server.authorization });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(servicePolicy.authorize).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('checks route policy, then service policy, then rejects a model principal before repository access', async () => {
    const { request, decision, routePolicy, servicePolicy, findById, resolver } = await setup('model');
    routePolicy.authorize.mockResolvedValueOnce({ allowed: false });
    expect((await request()).statusCode).toBe(403);
    expect(routePolicy.authorize).toHaveBeenCalledWith(decision);
    expect(servicePolicy.authorize).not.toHaveBeenCalled();

    servicePolicy.authorize.mockResolvedValueOnce({ allowed: false });
    const denied = await request();
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: { code: 'forbidden', message: 'Not authorized to read run workflows.' } });

    const model = await request();
    expect(model.statusCode).toBe(403);
    expect(model.json()).toEqual({ error: { code: 'forbidden', message: 'Model principals cannot read run workflows.' } });
    expect(findById).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns identical 404s for absent and foreign runs without resolving them', async () => {
    const { request, findById, resolver } = await setup();
    findById.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...run, tenant: 'foreign-tenant' });
    for (let i = 0; i < 2; i++) {
      const response = await request();
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Run not found.' } });
    }
    expect(findById).toHaveBeenCalledTimes(2);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns sanitized faults for invalid, missing, and throwing resolvers', async () => {
    const { request, resolver } = await setup();
    resolver
      .mockResolvedValueOnce({ ...runWorkflows.question, id: 'invalid-workflow-sentinel' })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('resolver-error-sentinel'));
    for (let i = 0; i < 3; i++) {
      const response = await request();
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(fault);
    }
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('does not publish malformed success data from the service', async () => {
    const controlPlane = createFakeControlPlaneService();
    vi.mocked(controlPlane.getRunWorkflow).mockResolvedValueOnce({
      workflowId: '', workKind: 'question', phases: [], steps: [], transitions: []
    });
    const server = await buildServer({ controlPlane });
    app = server.app;
    const response = await app.inject({ url, headers: server.authorization });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(fault);
  });
});
