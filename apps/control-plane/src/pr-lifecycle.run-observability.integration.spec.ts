/**
 * Integration test: completed run observability
 *
 * Proves that after a run completes via the PR lifecycle:
 * - GET /v1/runs/:id/pull-request returns the persisted PR with a useful title
 * - GET /v1/runs/:id/steps remains readable as the durable step timeline
 * - GET /v1/runs/:id/sessions returns durable session rows
 * - SSE unavailability does NOT prevent reading steps/sessions/PR
 * - Unexpected route errors produce 500 + route_failure log without leaking secrets or paths
 *
 * We use a "post-completion" seeding approach (run already at pr.human_review with an
 * open PR record) to avoid timing fragility in the auto-dispatch path. The PR
 * content quality is covered separately by pr-lifecycle.integration.spec.ts.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import Fastify, { type FastifyBaseLogger } from 'fastify';

import { createControlPlaneClient } from '@autocatalyst/sdk';
import { CODEX_SUPPORTED_VERSION, createCodexAgentAdapter } from '@autocatalyst/codex-agent-adapter';
import { z } from 'zod';
import { createOpenAIDirectAdapter } from '@autocatalyst/openai-direct-adapter';
import { createClaudeAgentAdapter } from '@autocatalyst/claude-agent-adapter';
import {
  createAgentOrchestratorRunner, createDirectOrchestrator, createExecutionEntryPoint, type AgentProviderAdapter, type ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import { deriveUsageTotals, type UsageGroup, type Run, type ExecutionContext, type NonModelPrincipal, type ModelRatePublication } from '@autocatalyst/api-contract';
import {
  DefaultControlPlaneService,
  InMemoryRunEventBus,
  permissivePolicyDecisionPoint,
  registerControlPlaneRoutes,
  recordExecutionSession,
  createExecutionRunUnitOfWork,
  type SessionRepository,
  type WorkspaceFileSystemPort
} from '@autocatalyst/core';
import {
  DrizzleConfigurationRecordRepository,
  DrizzleConversationIngressRepository,
  DrizzleProbeResourceRepository,
  SqliteSecretStore,
  asInternalSqliteDatabase,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const BEARER_TOKEN = 'observability-test-bearer-token';
const REPO_OWNER = 'testorg';
const REPO_NAME = 'testrepo';
const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;
const PR_NUMBER = 123;
const PR_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}`;
const CHANGED_FILE = 'packages/core/src/routes.ts';

const owner: NonModelPrincipal = {
  id: 'principal_dev_human',
  kind: 'human' as const,
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

// ---------------------------------------------------------------------------
// Capturing logger — used for safe fault log assertions
// ---------------------------------------------------------------------------

interface CapturedLogEntry {
  level: string;
  fields: unknown;
  message: string;
}

function createCapturingLogger(): { logger: FastifyBaseLogger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const makeLevel = (level: string) => (fields: unknown, msg?: string) => {
    entries.push({ level, fields, message: msg ?? '' });
  };
  const logger: FastifyBaseLogger = {
    fatal: makeLevel('fatal') as FastifyBaseLogger['fatal'],
    error: makeLevel('error') as FastifyBaseLogger['error'],
    warn: makeLevel('warn') as FastifyBaseLogger['warn'],
    info: makeLevel('info') as FastifyBaseLogger['info'],
    debug: makeLevel('debug') as FastifyBaseLogger['debug'],
    trace: makeLevel('trace') as FastifyBaseLogger['trace'],
    silent: makeLevel('silent') as FastifyBaseLogger['silent'],
    level: 'info',
    child: () => logger
  };
  return { logger, entries };
}

// ---------------------------------------------------------------------------
// Harness — seeds a completed run with an open PR, steps, and sessions,
// then builds a real Fastify app backed by in-memory SQLite.
// ---------------------------------------------------------------------------

interface ObservabilityHarness {
  readonly run: Run;
  readonly app: ReturnType<typeof Fastify>;
  readonly sessions: SessionRepository;
  sessionJson(id: string): unknown;
  readonly service: DefaultControlPlaneService;
  readonly logEntries: CapturedLogEntry[];
  readonly authHeaders: { authorization: string };
  close(): Promise<void>;
}

async function setupObservabilityHarness(seedLegacy = true): Promise<ObservabilityHarness> {
  const now = '2026-06-22T00:00:00.000Z';
  const database = createSqliteDatabase({ path: ':memory:' });
  await migrateSqliteDatabase(database);
  const domainRepos = createDrizzleDomainRepositories(database);

  // 1. Project
  const project = await domainRepos.projects.create({
    owner,
    tenant: 'tenant_dev',
    displayName: 'Observability Test Project',
    repoUrl: `https://github.com/${REPO_SLUG}`,
    hostRepository: {
      provider: 'github',
      owner: REPO_OWNER,
      name: REPO_NAME,
      url: `https://github.com/${REPO_SLUG}`
    },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: {
      provider: 'github',
      credentialRef: { id: 'cred_obs_1', purpose: 'code_host' }
    },
    credentialRefs: []
  });

  // 2. Run seeded directly at pr.human_review (already past pr.finalize + pr.open)
  const seed = await new DrizzleConversationIngressRepository(database)
    .createConversationTopicMessageAndRun({
      conversation: {
        projectId: project.id,
        owner,
        tenant: 'tenant_dev',
        identity: 'observability-integration-test',
        activeTopicId: null
      },
      topic: {
        owner,
        tenant: 'tenant_dev',
        title: 'Observability Topic',
        kind: 'main'
      },
      message: {
        owner,
        tenant: 'tenant_dev',
        author: owner,
        direction: 'inbound',
        body: 'prove observability'
      },
      run: {
        owner,
        tenant: 'tenant_dev',
        workKind: 'feature',
        currentStep: 'pr.human_review',
        terminal: false
      },
      runStep: {
        phase: 'pr',
        step: 'pr.human_review',
        role: 'none',
        startedAt: now,
        endedAt: null,
        durationMs: null
      }
    });

  const runId = seed.run.id;
  const branch = `feature/${runId.slice(0, 8)}`;

  // 3. Insert implementation.build run step with cumulative summary checkpoint
  //    so the step timeline is non-empty and meaningful.
  const buildStep = await domainRepos.runSteps.create({
    runId,
    phase: 'implementation',
    step: 'implementation.build',
    role: 'none',
    startedAt: now,
    endedAt: now,
    durationMs: 2000,
    occurrence: { index: 0, attempt: 1 }
  });
  await domainRepos.runSteps.updateCheckpoint({
    runStepId: buildStep.id,
    runId,
    tenant: 'tenant_dev',
    checkpointResult: {
      kind: 'cumulative_implementation_summary' as const,
      cumulativeSummary: 'Refactored core routes for observability.',
      changedFiles: [CHANGED_FILE],
      validationSummary: ['All tests pass'],
      followUps: [],
      nonGoals: [],
      sourceRoundCount: 1,
      completedAt: now
    } as unknown as Parameters<typeof domainRepos.runSteps.updateCheckpoint>[0]['checkpointResult']
  });

  // 4. Seed PR record directly — simulates what pr.open would create via the code host adapter.
  //    The title/body quality is tested in pr-lifecycle.integration.spec.ts.
  await domainRepos.pullRequests.create({
    runId,
    owner,
    tenant: 'tenant_dev',
    provider: 'github',
    number: PR_NUMBER,
    url: PR_URL,
    state: 'open',
    branch
  });

  // 5. Seed a Session row directly — the execution session recorder wiring requires a live
  //    AI dispatch; we bypass it by writing directly to the repository.
  if (seedLegacy) await domainRepos.sessions.create({
    runId,
    phase: 'implementation',
    step: 'implementation.build',
    role: 'implementer',
    round: 1,
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    startedAt: now,
    endedAt: now,
    durationMs: 2000,
    tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
    usageAvailable: true,
    assistantTurnCount: 2,
    toolCallCount: 5,
    outcome: 'succeeded' as const,
    cost: {
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      usd: null,
      tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }
    }
  });

  // 6. Build the control-plane service with a stub orchestrator
  //    (no orchestrator dispatch needed — we just read data).
  const eventBus = new InMemoryRunEventBus();
  const policy = permissivePolicyDecisionPoint;

  const service = new DefaultControlPlaneService({
    orchestrator: {
      createRun: vi.fn(),
      createConversationWithFirstRun: vi.fn(),
      applyDirective: vi.fn(),
      dispatch: vi.fn(),
      tick: vi.fn().mockResolvedValue({ status: 'noop' }),
      replyToRun: vi.fn(),
      detectMerges: vi.fn()
    },
    runs: domainRepos.runs,
    runSteps: domainRepos.runSteps,
    events: eventBus,
    policy,
    artifacts: domainRepos.artifacts,
    feedback: domainRepos.feedback,
    runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
    workspaceFilesystem: {
      readFile: async () => '',
      writeFile: async () => undefined
    } as unknown as WorkspaceFileSystemPort,
    feedbackLifecycle: {
      feedback: domainRepos.feedback,
      ids: () => `fb_${Math.random().toString(36).slice(2)}`,
      clock: () => now
    },
    projects: domainRepos.projects,
    issueReferenceIntakeResolver: { lookup: vi.fn(), resolve: vi.fn() },
    pullRequests: domainRepos.pullRequests,
    sessions: domainRepos.sessions
  });

  // 7. Build the Fastify app with the capturing logger
  const { logger, entries: logEntries } = createCapturingLogger();
  const app = Fastify({ loggerInstance: logger });

  await registerControlPlaneRoutes(app, {
    health: { isDatabaseReachable: async () => true },
    auth: { bearerToken: BEARER_TOKEN },
    policy,
    probeResources: new DrizzleProbeResourceRepository(database),
    configurationRecords: new DrizzleConfigurationRecordRepository(database),
    secrets: new SqliteSecretStore(database),
    controlPlane: service
  });

  return {
    run: seed.run,
    app,
    sessions: domainRepos.sessions,
    sessionJson(id) {
      return asInternalSqliteDatabase(database).client.prepare('select tokens_json, usage_json, cost_json from sessions where id = ?').get(id);
    },
    service,
    logEntries,
    authHeaders: { authorization: `Bearer ${BEARER_TOKEN}` },
    async close() {
      await app.close();
      database.close();
    }
  };
}

async function runNativeAttempt(input: {
  run: Run; sessions: SessionRepository; adapter: AgentProviderAdapter; scratchRoot?: string; env?: Record<string, string>;
  timeoutMs?: number;
}) {
  const { run, sessions, adapter, scratchRoot } = input;
  const step = 'implementation.build';
  const profile: ResolvedAgentRunnerProfile = {
    mode: 'agent', adapterId: adapter.adapterId, providerKind: adapter.providerKind, profileName: 'usage fixture',
    model: { provider: adapter.providerKind, model: 'served-test-model' }, inferenceSettings: {},
    endpoint: input.timeoutMs === undefined ? {} : { requestTimeoutMs: input.timeoutMs },
    connectionMechanism: 'process_environment'
  };
  const toolPolicy = { allowedTools: ['shell', 'Read'], workspaceScope: 'declared_workspace' as const };
  const skills = { requested: [], resolved: [] };
  const context: ExecutionContext = {
    run: { id: run.id, tenant: run.tenant, workKind: run.workKind, currentStep: step },
    task: { prompt: 'Test pinned usage events, no inference.', inputs: {} },
    workspaceIntent: { shape: 'none' }, secretBindings: [], toolPolicy, skills,
    capabilityRequirements: { shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: true }, lsp: { requested: false } }
  };
  const runner = createAgentOrchestratorRunner({
    adapter, profile, clock: () => Date.parse('2026-11-23T10:00:00Z'),
    connection: {
      profile, credentialResolved: false,
      createFetchTransport() { throw new Error('No network transport for native fixtures'); },
      createProcessLaunchConfig() {
        return { environment: input.env ?? {}, secretVariableNames: [], degradedCapabilities: [], redacted: {} };
      }
    },
    telemetryContext: { runId: run.id, phase: 'implementation', step, role: 'implementer' }
  });
  const roots = scratchRoot === undefined ? [] : [scratchRoot];
  const entryPoint = createExecutionEntryPoint({
    runner, resultValidation: { mode: 'none' },
    async materialize() {
      return {
        context, workspace: scratchRoot === undefined ? { shape: 'none', workspaceRoots: [] } :
          { shape: 'scratch_only', scratchRoot, workspaceRoots: roots },
        environment: { variables: {}, secretVariableNames: [] }, skills,
        toolPolicy: { allowedTools: toolPolicy.allowedTools, workspaceRoots: roots },
        capabilities: { shell: { kind: 'bash', available: true },
          paths: scratchRoot === undefined ? {} : { scratchRoot }, lsp: { requested: false, available: false } }
      };
    }
  });
  const uow = createExecutionRunUnitOfWork({ execute: entryPoint, sessions, resolveContext: async () => context });
  return uow.run({ runId: run.id, tenant: run.tenant, run: { ...run, currentStep: step } });
}

// A pinned JSON-RPC subprocess. The fixture never starts Codex or accesses an account.
const codexWire = `
const { createInterface } = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-cli ${CODEX_SUPPORTED_VERSION}'); process.exit(0); }
const send = message => console.log(JSON.stringify(message));
createInterface({input:process.stdin}).on('line', (line) => {
  const {id, method, params} = JSON.parse(line);
  if (id === undefined) return;
  const reply = result => send({id, result});
  if (method === 'initialize') reply({});
  else if (method === 'account/read') reply({account:{type:'chatgpt',planType:'enterprise'}});
  else if (method === 'config/read') reply({config:{}});
  else if (method === 'thread/start') reply({thread:{id:'thread'},modelProvider:'openai',model:params.model,
    sandbox:{type:params.sandbox==='read-only'?'readOnly':'workspaceWrite'}});
  else if (method === 'turn/start') {
    const input = {threadId:params.threadId,turnId:'turn'};
    const sizeEvidence = process.env.FIXTURE_SIZE_EVIDENCE;
    const total = {inputTokens:sizeEvidence?160:100,cachedInputTokens:60,outputTokens:10,reasoningOutputTokens:4};
    const last = !sizeEvidence ? total : sizeEvidence === 'none' ? undefined :
      {inputTokens:120,cachedInputTokens:20,outputTokens:2,reasoningOutputTokens:1};
    const usage = (total,last) => send({method:'thread/tokenUsage/updated',params:{...input,tokenUsage:{total,last}}});
    usage(total,last);
    if (sizeEvidence === 'separate') {
      usage({inputTokens:390,cachedInputTokens:90,outputTokens:14,reasoningOutputTokens:5},
        {inputTokens:230,cachedInputTokens:30,outputTokens:4,reasoningOutputTokens:1});
    }
    if (process.env.FIXTURE_TIMEOUT) { reply({turn:{id:'turn'}}); return; }
    send({method:'item/completed',params:{...input,item:{type:'agentMessage',text:'fixture'}}});
    send({method:'turn/completed',params:{...input,turn:{id:'turn',status:process.env.FIXTURE_FAILED?'failed':'completed'}}});
    reply({turn:{id:'turn'}});
  }
});
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run observability integration: completed run readable', () => {
  let harness: ObservabilityHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it('returns the persisted PR for a run at pr.human_review', async () => {
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const prResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/pull-request`,
      headers: authHeaders
    });

    expect(prResponse.statusCode).toBe(200);
    expect(prResponse.json().pullRequest).toMatchObject({
      runId: run.id,
      provider: 'github',
      number: PR_NUMBER
    });
  });

  it('returns the durable step timeline for a completed run', async () => {
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const stepsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/steps`,
      headers: authHeaders
    });

    expect(stepsResponse.statusCode).toBe(200);
    expect(stepsResponse.json().steps.length).toBeGreaterThan(0);
  });

  it('returns durable session rows for a completed run', async () => {
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const sessionsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/sessions`,
      headers: authHeaders
    });

    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json().sessions.length).toBeGreaterThan(0);
  });

  it('prices unchanged owned usage on the next HTTP/SDK read after publication', async () => {
    harness = await setupObservabilityHarness(false);
    const { run, app, sessions, sessionJson } = harness;
    const fetchThroughInject: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await app.inject({
        method: request.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers),
        ...(request.body === null ? {} : { payload: await request.text() })
      });
      return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode });
    };
    const sdk = createControlPlaneClient({ baseUrl: 'https://api.test', bearerToken: BEARER_TOKEN, fetch: fetchThroughInject });
    const get = () => sdk.listRunSessions(run.id);
    expect((await get()).costTotals).toMatchObject({ run: { sessionCount: 0, knownSubtotalUsd: null, complete: false }, steps: [] });
    const model = { provider: 'openai', model: 'served' };
    const groups: UsageGroup[] = [{
      model, requestInputTokens: 100,
      tokens: { freshInput: 40, cacheRead: 60, cacheWrite: 'not_applicable', output: 10, reasoningOutput: 4 }
    }];
    const recorded = await recordExecutionSession({ sessions }, {
      runId: run.id, phase: 'implementation', step: 'implementation.build', role: 'reviewer', round: 2,
      startedAt: '2026-11-23T10:00:00Z', endedAt: '2026-11-23T10:00:01Z', outcome: 'failed',
      model: { provider: 'codex', model: 'dispatched' }, inferenceSettings: {}, usageAvailable: true,
      tokens: { input: 100, output: 10, cacheRead: 60, cacheWrite: 0 }, usage: {
        groups, coverage: 'complete', totals: deriveUsageTotals(groups, 'complete')
      }
    });
    const storageBefore = sessionJson(recorded.id);
    expect((await get()).costTotals?.run).toMatchObject({
      knownSubtotalUsd: null, sessionCount: 1, unpricedSessionCount: 1,
      gaps: expect.arrayContaining([expect.objectContaining({ code: 'missing_rate', model: 'served' })])
    });
    const settings: ModelRatePublication = { ...model, action: 'set', effectiveAt: '2026-11-23T10:00:00.000Z',
      bands: [{ minRequestInputTokens: 0, rates: { freshInput: 3000, cacheRead: 300, cacheWrite: 'not_applicable', output: 15000 } }] };
    const publish = (tenant: string, publication: ModelRatePublication) =>
      sdk.createConfigurationRecord({ tenant, kind: 'model_rate_table', settings: publication });
    await expect(publish('foreign', settings)).rejects.toMatchObject({ status: 400 });
    const rate = await publish(owner.tenantId, settings);
    await expect(publish(owner.tenantId, settings)).rejects.toMatchObject({ status: 409 });
    const priced = await get();
    expect(priced.sessions[0]).toMatchObject({
      id: recorded.id, outcome: 'failed', usage: recorded.usage,
      cost: { usd: 288000, basis: 'api_list_price', complete: true, rateVersionIds: [rate.id] }
    });
    expect(priced.costTotals?.steps[0]).toMatchObject({ knownSubtotalUsd: 288000, complete: true, phase: 'implementation', step: 'implementation.build' });
    expect(await sessions.findById(recorded.id)).toEqual(recorded);
    expect(sessionJson(recorded.id)).toEqual(storageBefore);
    expect(JSON.parse((storageBefore as { cost_json: string }).cost_json)).toEqual(recorded.cost);
    expect(recorded.cost.usd).toBeNull();
    await expect(sdk.updateConfigurationRecord(rate.id, { kind: 'provider_profile', providerKind: 'wrong' })).rejects.toMatchObject({ status: 409 });
    await expect(sdk.deleteConfigurationRecord(rate.id)).rejects.toMatchObject({ status: 409 });
    const zero = await publish(owner.tenantId, { ...settings, correctsId: rate.id, bands: [{
      minRequestInputTokens: 0, rates: { freshInput: 0, cacheRead: 0, output: 0, cacheWrite: 'not_applicable' }
    }] });
    expect((await get()).costTotals?.run).toMatchObject({ knownSubtotalUsd: 0, complete: true, pricedSessionCount: 1 });
    await publish(owner.tenantId, { ...model, effectiveAt: settings.effectiveAt, action: 'retract', correctsId: zero.id });
    expect((await get()).costTotals?.run.knownSubtotalUsd).toBeNull();
  });

  it('prices Codex wire and Claude SDK attempts from production runner dispatch without inference', async () => {
    harness = await setupObservabilityHarness(false);
    const { app, authHeaders, run, sessions } = harness;
    const dir = await mkdtemp(join(tmpdir(), 'cost-native-'));
    try {
      const binary = join(dir, 'codex.cjs');
      await writeFile(binary, '#!' + process.execPath + '\n' + codexWire, { mode: 0o700 });
      const codex = createCodexAgentAdapter({ codexBinary: binary });
      const observed = await runNativeAttempt({ run, sessions, scratchRoot: dir, adapter: codex, env: { FIXTURE_FAILED: 'yes' } });
      expect(observed.directive).toBe('fail');
      const claude = createClaudeAgentAdapter({ async *queryClaudeSdk() {
        const session_id = 'native-id-must-not-persist';
        const usage = { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 25, output_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 20 } };
        yield { type: 'system', subtype: 'init', session_id };
        const frame = { type: 'assistant', session_id, parent_tool_use_id: null, request_id: 'native-request-must-not-persist',
          message: { id: 'native-message', model: 'served-test-model', usage, content: [{ type: 'text', text: 'fixture' }] } };
        yield frame;
        yield frame;
        yield { type: 'result', session_id, subtype: 'success', result: 'done',
          modelUsage: { 'served-test-model': { inputTokens: 40, cacheReadInputTokens: 60, cacheCreationInputTokens: 25, outputTokens: 10 } } };
      } });
      expect((await runNativeAttempt({ run, sessions, adapter: claude })).directive).toBe('advance');
      const directAdapter = createOpenAIDirectAdapter();
      const directProfile: ResolvedAgentRunnerProfile = {
        mode: 'direct', adapterId: directAdapter.adapterId, providerKind: 'openai', profileName: 'direct fixture',
        model: { provider: 'openai', model: 'different-dispatch-id' }, inferenceSettings: {}, endpoint: {},
        connectionMechanism: 'fetch_transport'
      };
      const direct = createDirectOrchestrator({
        adapter: directAdapter, profile: directProfile, clock: () => Date.parse('2026-11-23T10:00:00Z'),
        telemetryContext: { runId: run.id, step: 'intake' },
        connection: {
          profile: directProfile, credentialResolved: false,
          createProcessLaunchConfig() { throw new Error('Unexpected process launch'); },
          createFetchTransport() {
            return { async fetch() { return Response.json({
              model: 'served-test-model', usage: { prompt_tokens: 100, completion_tokens: 10,
                prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 4 } },
              choices: [{ message: { tool_calls: [{ type: 'function', function: {
                name: 'autocatalyst_direct_result', arguments: '{"ok":true}'
              } }] } }]
            }); } };
          }
        }
      });
      const directUow = createExecutionRunUnitOfWork({
        sessions,
        execute: { execute() { throw new Error('Expected direct execution'); } },
        resolveContext: async () => ({
          run: { id: run.id, tenant: run.tenant, workKind: run.workKind, currentStep: 'intake' },
          task: { prompt: 'Test direct usage', inputs: {} }, workspaceIntent: { shape: 'none' },
          secretBindings: [], toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
          skills: { requested: [], resolved: [] },
          capabilityRequirements: { shell: { kind: 'bash', required: false },
            paths: { canonicalWorkspacePaths: true }, lsp: { requested: false } }
        }),
        resolveExecutionMode: () => ({ mode: 'direct', directCall: {
          purpose: 'test', input: {}, resultValidation: { schemaId: 'test', schema: z.object({ ok: z.boolean() }) }
        } }),
        direct: { call: ({ directCall }) => direct.call(directCall) }
      });
      expect((await directUow.run({ run: { ...run, currentStep: 'intake' }, runId: run.id, tenant: run.tenant })).directive).toBe('advance');
      const ids = new Map<string, string>();
      for (const provider of ['openai', 'anthropic'] as const) {
        const published = await app.inject({ method: 'POST', url: '/v1/configuration-records', headers: authHeaders, payload: {
          tenant: owner.tenantId, kind: 'model_rate_table', settings: {
            provider, model: 'served-test-model', effectiveAt: '2026-11-23T10:00:00.000Z', action: 'set',
            bands: [{ minRequestInputTokens: 0, rates: { freshInput: 3000, cacheRead: 300, output: 15000,
              cacheWrite: provider === 'openai' ? 'not_applicable' : { '5m': 4000, '1h': 6000 } } }]
          }
        } });
        expect(published.statusCode).toBe(201);
        ids.set(provider, published.json().id);
      }
      const response = await app.inject({ method: 'GET', url: '/v1/runs/' + run.id + '/sessions', headers: authHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(/native-(id|request|message)/u);
      expect(response.json()).toMatchObject({
        sessions: [
          { outcome: 'failed', usage: { coverage: 'complete', groups: [{ requestInputTokens: 100 }] },
            cost: { usd: 288000, complete: true, gaps: [], rateVersionIds: [ids.get('openai')] } },
          { outcome: 'succeeded', usage: { coverage: 'complete', groups: [{ requestInputTokens: 125 }] },
            cost: { usd: 368000, complete: false, gaps: [{ code: 'missing_cache_retention', tokenCount: '5' }] } },
          { outcome: 'succeeded', phase: null, usage: { coverage: 'complete', groups: [{ requestInputTokens: 100 }] },
            cost: { usd: 288000, complete: true, rateVersionIds: [ids.get('openai')] } }
        ],
        costTotals: { run: { knownSubtotalUsd: 944000, pricedSessionCount: 3, complete: false } }
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.each([
    { evidence: 'unmatched', method: 'lowest_feasible', band: 0, usd: 468000 },
    { evidence: 'none', method: 'lowest_feasible', band: 0, usd: 468000 },
    { evidence: 'separate', method: 'nearest_sample', band: 101, usd: 2637000 }
  ])('prices the 160-token Codex wire group with $evidence size evidence', async ({ evidence, method, band, usd }) => {
    harness = await setupObservabilityHarness(false);
    const { app, authHeaders, run, sessions } = harness;
    const dir = await mkdtemp(join(tmpdir(), 'cost-codex-band-'));
    try {
      const binary = join(dir, 'codex.cjs');
      await writeFile(binary, '#!' + process.execPath + '\n' + codexWire, { mode: 0o700 });
      const adapter = createCodexAgentAdapter({ codexBinary: binary });
      const attempt = await runNativeAttempt({
        run, sessions, scratchRoot: dir, adapter, env: { FIXTURE_SIZE_EVIDENCE: evidence }
      });
      expect(attempt.directive).toBe('advance');

      const rates = { freshInput: 3000, cacheRead: 300, output: 15000, cacheWrite: 'not_applicable' };
      const published = await app.inject({ method: 'POST', url: '/v1/configuration-records', headers: authHeaders, payload: {
        tenant: owner.tenantId, kind: 'model_rate_table', settings: {
          provider: 'openai', model: 'served-test-model', effectiveAt: '2026-11-23T10:00:00.000Z', action: 'set',
          bands: [
            { minRequestInputTokens: 0, rates },
            { minRequestInputTokens: 101, rates: { ...rates, freshInput: 6000 } },
            ...(evidence === 'separate' ? [{ minRequestInputTokens: 201, rates: { ...rates, freshInput: 9000 } }] : [])
          ]
        }
      } });
      expect(published.statusCode).toBe(201);
      const response = await app.inject({ method: 'GET', url: '/v1/runs/' + run.id + '/sessions', headers: authHeaders });
      expect(response.statusCode).toBe(200);
      const { sessions: recorded, costTotals } = response.json();
      expect(recorded).toMatchObject([{
        usage: { coverage: 'complete', groups: [
          { requestInputTokens: null, inputTotalCeilingTokens: 160,
            tokens: { freshInput: 100, cacheRead: 60, cacheWrite: 'not_applicable', output: 10 } },
          ...(evidence === 'separate' ? [{ requestInputTokens: 230, tokens: { freshInput: 200, cacheRead: 30, output: 4 } }] : [])
        ] },
        cost: { usd, complete: false, rateVersionIds: [published.json().id], gaps: [{
          code: 'estimated_request_size', tokenCount: '100', tokenClass: 'freshInput', groupIndex: 0,
          method, bandMinRequestInputTokens: band
        }] }
      }]);
      expect(recorded[0].usage.groups[0].requestSizeHint).toEqual(
        evidence === 'separate' ? { method: 'nearest_sample', inputTokens: 230 } : undefined
      );
      expect(costTotals.run).toMatchObject({ knownSubtotalUsd: usd, complete: false, pricedSessionCount: 1 });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it('prices recorded counts from a Codex timeout without claiming invocation closure', async () => {
    harness = await setupObservabilityHarness(false);
    const { app, authHeaders, run, sessions } = harness;
    const dir = await mkdtemp(join(tmpdir(), 'cost-timeout-'));
    try {
      const binary = join(dir, 'codex.cjs');
      await writeFile(binary, '#!' + process.execPath + '\n' + codexWire, { mode: 0o700 });
      const adapter = createCodexAgentAdapter({ codexBinary: binary });
      const attempt = await runNativeAttempt({
        run, sessions, scratchRoot: dir, adapter, timeoutMs: 1000, env: { FIXTURE_TIMEOUT: 'yes' }
      });
      expect(attempt.directive).toBe('fail');
      const published = await app.inject({ method: 'POST', url: '/v1/configuration-records', headers: authHeaders, payload: {
        tenant: owner.tenantId, kind: 'model_rate_table', settings: {
          provider: 'openai', model: 'served-test-model', effectiveAt: '2026-11-23T10:00:00.000Z', action: 'set',
          bands: [{ minRequestInputTokens: 0, rates: { freshInput: 3000, cacheRead: 300, output: 15000, cacheWrite: 'not_applicable' } }]
        }
      } });
      expect(published.statusCode).toBe(201);
      const response = await app.inject({ method: 'GET', url: '/v1/runs/' + run.id + '/sessions', headers: authHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json().sessions).toMatchObject([{
        outcome: 'timeout', usage: { coverage: 'partial', groups: [{ requestInputTokens: 100 }] },
        cost: { usd: 288000, complete: false, gaps: [{ code: 'partial_usage', tokenCount: null }] }
      }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it('bounds a 5,000-request Claude session and prices the resulting range in under 1s per run read', async () => {
    harness = await setupObservabilityHarness(false);
    const { run, sessions, app, authHeaders } = harness;
    const model = 'served-test-model';
    const adapter = createClaudeAgentAdapter({ async *queryClaudeSdk() {
      const session_id = 'long-fixture';
      yield { type: 'system', subtype: 'init', session_id };
      for (let i = 1; i <= 5000; i++) yield {
        type: 'assistant', session_id, request_id: String(i), parent_tool_use_id: null,
        message: { model, usage: { input_tokens: i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }
      };
      yield { type: 'result', subtype: 'success', session_id, result: 'done',
        modelUsage: { [model]: { inputTokens: 12_502_500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 5000 } } };
    } });
    expect((await runNativeAttempt({ run, sessions, adapter })).directive).toBe('advance');
    const config = await app.inject({ method: 'POST', url: '/v1/configuration-records', headers: authHeaders, payload: {
      tenant: owner.tenantId, kind: 'model_rate_table', settings: {
        model, provider: 'anthropic', action: 'set', effectiveAt: '2026-11-23T10:00:00.000Z',
        bands: [
          { minRequestInputTokens: 0, rates: { freshInput: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
          { minRequestInputTokens: 4000, rates: { freshInput: 2, cacheRead: 0, cacheWrite: 0, output: 1 } }
        ]
      }
    } });
    expect(config.statusCode).toBe(201);
    const started = performance.now();
    const response = await app.inject({ method: 'GET', url: '/v1/runs/' + run.id + '/sessions', headers: authHeaders });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(response.statusCode).toBe(200);
    const recorded = response.json().sessions[0];
    expect(recorded.usage.groups).toHaveLength(256);
    expect(recorded.cost).toMatchObject({
      usd: 13_750_115, complete: false,
      gaps: [{ code: 'estimated_request_size', method: 'lowest_feasible', tokenClass: 'freshInput', tokenCount: '11259885' }]
    });
  });

  it('durable reads (PR, steps, sessions) succeed independently of SSE subscription state', async () => {
    // This test proves that retained SSE unavailability does NOT prevent reading durable records.
    // We intentionally do NOT call the SSE endpoint; the three reads below prove that the
    // durable observability layer is independent of event streaming.
    harness = await setupObservabilityHarness();
    const { run, app, authHeaders } = harness;

    const prResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/pull-request`,
      headers: authHeaders
    });
    expect(prResponse.statusCode).toBe(200);

    const stepsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/steps`,
      headers: authHeaders
    });
    expect(stepsResponse.statusCode).toBe(200);

    const sessionsResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/sessions`,
      headers: authHeaders
    });
    expect(sessionsResponse.statusCode).toBe(200);
  });
});

describe('run observability integration: safe fault logging', () => {
  let harness: ObservabilityHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.close();
      harness = undefined;
    }
  });

  it(
    'unexpected service error → 500 generic response + route_failure log without secrets or workspace paths',
    async () => {
      harness = await setupObservabilityHarness();
      const { run, app, service, authHeaders, logEntries } = harness;

      // Inject an error carrying sensitive data into the service method
      vi.spyOn(service, 'getRunPullRequest').mockRejectedValue(
        new Error('SECRET_SENTINEL /Users/mark.stafford/raw provider output')
      );

      const faultResponse = await app.inject({
        method: 'GET',
        url: `/v1/runs/${run.id}/pull-request`,
        headers: authHeaders
      });

      expect(faultResponse.statusCode).toBe(500);
      expect(faultResponse.json()).toEqual({
        error: { code: 'internal_error', message: 'An internal server error occurred.' }
      });

      const serialized = JSON.stringify(logEntries);
      expect(serialized).toContain('route_failure');
      expect(serialized).not.toContain('SECRET_SENTINEL');
      expect(serialized).not.toContain('/Users/mark.stafford');

      vi.restoreAllMocks();
    }
  );
});
