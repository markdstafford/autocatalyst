import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ResolvedSkill, RunnerEvent } from '@autocatalyst/api-contract';
import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentProviderSessionInput,
  ProcessLaunchConfig,
  ProcessLaunchConfigInput,
  ProviderFetchTransport,
  ResolvedAgentRunnerProfile,
  StructuredAgentResultCapture
} from '@autocatalyst/execution';
import {
  ClassifiedProviderFailureError,
  ProviderConnectionError,
  ProviderProtocolError,
  UnsupportedProviderCapabilityError
} from '@autocatalyst/execution';

import {
  codexAgentAdapterId,
  codexProviderKind,
  createCodexAgentAdapter,
  type CodexAgentAdapterOptions,
  type CodexNativeEvent,
  type CodexSessionLaunch,
  type CodexSessionLaunchOptions
} from './codex-agent-adapter.js';
import { CodexAuthenticationError, type CodexAuthProbe } from './codex-auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET_TOKEN = 'sk-codex-secret-xyz';

function makeProfile(overrides?: Partial<ResolvedAgentRunnerProfile>): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: codexProviderKind,
    adapterId: codexAgentAdapterId,
    profileName: 'default',
    model: { provider: 'openai', model: 'gpt-5-codex' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'process_environment',
    ...overrides
  };
}

interface ConnectionRecorder {
  readonly connection: AgentConnection;
  readonly createProcessLaunchConfigCalls: ProcessLaunchConfigInput[];
  fetchTransportCalls: number;
}

function makeConnection(
  profile: ResolvedAgentRunnerProfile,
  extraEnv: Record<string, string> = {}
): ConnectionRecorder {
  const createProcessLaunchConfigCalls: ProcessLaunchConfigInput[] = [];
  const recorder: ConnectionRecorder = {
    connection: undefined as unknown as AgentConnection,
    createProcessLaunchConfigCalls,
    fetchTransportCalls: 0
  };
  const launchConfig: ProcessLaunchConfig = {
    environment: {
      ...extraEnv,
      CODEX_WORKSPACE_DIR: '/workspace',
      CODEX_INTERNAL_TOKEN: SECRET_TOKEN
    },
    secretVariableNames: ['CODEX_INTERNAL_TOKEN'],
    degradedCapabilities: [],
    redacted: { mechanism: 'process_environment', hasInternalToken: true }
  };
  recorder.connection = {
    profile,
    credentialResolved: true,
    createFetchTransport(): ProviderFetchTransport {
      recorder.fetchTransportCalls += 1;
      throw new Error('createFetchTransport should not be called for the Codex adapter');
    },
    createProcessLaunchConfig(input: ProcessLaunchConfigInput): ProcessLaunchConfig {
      createProcessLaunchConfigCalls.push(input);
      return launchConfig;
    }
  };
  return recorder;
}

function makeTelemetry(role?: string): AgentConnectionTelemetryContext {
  return { runId: 'run_1', step: 'implement', ...(role !== undefined ? { role } : {}) };
}

function makeSessionInput(args: {
  profile?: ResolvedAgentRunnerProfile;
  prompt?: string;
  allowedTools?: string[];
  requestedSkills?: string[];
  resolvedSkills?: ResolvedSkill[];
  variables?: Record<string, string>;
  secretVariableNames?: string[];
  scratchRoot?: string;
  repoRoot?: string;
  taskInputs?: Record<string, unknown>;
  role?: string;
} = {}): { input: AgentProviderSessionInput; recorder: ConnectionRecorder } {
  const profile = args.profile ?? makeProfile();
  const recorder = makeConnection(profile);
  const variables = args.variables ?? { CUSTOM_VAR: 'value' };
  const secretVariableNames = args.secretVariableNames ?? [];
  const workspace = args.scratchRoot
    ? args.repoRoot
      ? {
          shape: 'two_roots' as const,
          repoRoot: args.repoRoot,
          scratchRoot: args.scratchRoot,
          branchName: 'work',
          provisionedBaseRef: 'origin/main',
          workspaceRoots: [args.repoRoot, args.scratchRoot]
        }
      : {
          shape: 'scratch_only' as const,
          scratchRoot: args.scratchRoot,
          workspaceRoots: [args.scratchRoot]
        }
    : { shape: 'none' as const, workspaceRoots: [] };

  const input: AgentProviderSessionInput = {
    runInput: {
      environment: {
        context: {
          run: { id: 'run_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
          task: { prompt: args.prompt ?? 'Build the feature', inputs: args.taskInputs ?? {} },
          workspaceIntent: { shape: 'none' },
          secretBindings: [],
          toolPolicy: { allowedTools: args.allowedTools ?? ['bash'], workspaceScope: 'declared_workspace' },
          skills: { requested: args.requestedSkills ?? ['mm:planning'], resolved: args.resolvedSkills ?? [] },
          capabilityRequirements: {
            shell: { kind: 'bash', required: false },
            paths: { canonicalWorkspacePaths: true },
            lsp: { requested: false }
          }
        },
        workspace,
        environment: { variables, secretVariableNames },
        toolPolicy: { allowedTools: args.allowedTools ?? ['bash'], workspaceRoots: workspace.workspaceRoots },
        skills: { requested: args.requestedSkills ?? ['mm:planning'], resolved: args.resolvedSkills ?? [] },
        capabilities: {
          shell: { kind: 'bash', available: true },
          paths:
            workspace.shape === 'two_roots'
              ? { repoRoot: workspace.repoRoot, scratchRoot: workspace.scratchRoot }
              : workspace.shape === 'scratch_only'
                ? { scratchRoot: workspace.scratchRoot }
                : {},
          lsp: { requested: false, available: false }
        }
      }
    },
    profile,
    connection: recorder.connection,
    telemetryContext: makeTelemetry(args.role)
  };
  return { input, recorder };
}

const AUTHED: CodexAuthProbe = () => ({ status: 'authenticated', accountType: 'enterprise' });

function makeAdapter(
  events: CodexNativeEvent[],
  opts: Partial<CodexAgentAdapterOptions> = {}
): { adapter: ReturnType<typeof createCodexAgentAdapter>; calls: CodexSessionLaunchOptions[] } {
  const calls: CodexSessionLaunchOptions[] = [];
  const launch: CodexSessionLaunch = (options) => {
    calls.push(options);
    async function* gen(): AsyncIterable<CodexNativeEvent> {
      for (const ev of events) yield ev;
    }
    return gen();
  };
  const adapter = createCodexAgentAdapter({
    launchCodexSession: opts.launchCodexSession ?? launch,
    probeCodexAuth: opts.probeCodexAuth ?? AUTHED,
    ...opts
  });
  return { adapter, calls };
}

async function collect(stream: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

async function* asyncIter(events: CodexNativeEvent[]): AsyncIterable<CodexNativeEvent> {
  for (const ev of events) yield ev;
}

function makeCapture(
  schemaId: string,
  resultFile: string,
  step = 'implementation.build'
): StructuredAgentResultCapture {
  return { step, schemaId, schema: z.object({}).passthrough(), resultFile, required: true };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — identity', () => {
  it('uses codex / codex-app-server / process_environment', () => {
    const { adapter } = makeAdapter([]);
    expect(adapter.providerKind).toBe('codex');
    expect(adapter.adapterId).toBe('codex-app-server');
    expect(adapter.supportedConnectionMechanism).toBe('process_environment');
  });
});

// ---------------------------------------------------------------------------
// Connection mechanism
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — connection mechanism', () => {
  it('calls createProcessLaunchConfig once and never createFetchTransport', async () => {
    const { input, recorder } = makeSessionInput();
    const { adapter } = makeAdapter([{ type: 'result', result: { directive: 'advance', output: '{}' } }]);
    const session = adapter.startSession(input);
    await collect(session.events);
    expect(recorder.createProcessLaunchConfigCalls).toHaveLength(1);
    expect(recorder.fetchTransportCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Launch input mapping (T-003, T-006)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — launch input mapping', () => {
  it('forwards prompt, model, cwd, connection env, and workspace-write sandbox for implementer', async () => {
    const scratchRoot = '/tmp/codex-adapter-scratch';
    const { input } = makeSessionInput({ prompt: 'Implement parser', scratchRoot, role: 'implementer' });
    const { adapter, calls } = makeAdapter([{ type: 'result', result: { directive: 'advance' } }]);
    await collect(adapter.startSession(input).events);
    expect(calls).toHaveLength(1);
    const opts = calls[0]!;
    expect(opts.prompt).toBe('Implement parser');
    expect(opts.model).toBe('gpt-5-codex');
    expect(opts.cwd).toBe(scratchRoot);
    expect(opts.sandbox).toBe('workspace-write');
    expect(opts.auth.mode).toBe('enterprise_sign_in');
    expect(opts.env?.CODEX_WORKSPACE_DIR).toBe('/workspace');
  });

  it('does not add OPENAI_API_KEY to the forwarded environment', async () => {
    const { input } = makeSessionInput();
    const { adapter, calls } = makeAdapter([{ type: 'result', result: { directive: 'advance' } }]);
    await collect(adapter.startSession(input).events);
    expect(calls[0]!.env).toBeDefined();
    expect(Object.keys(calls[0]!.env ?? {})).not.toContain('OPENAI_API_KEY');
    // No apiKey field in launch options either.
    expect((calls[0]! as unknown as Record<string, unknown>)['apiKey']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inference settings (T-003)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — inference settings', () => {
  it('maps supported reasoningEffort into the Codex config', async () => {
    const profile = makeProfile({ inferenceSettings: { reasoningEffort: 'high' } });
    const { input } = makeSessionInput({ profile });
    const { adapter, calls } = makeAdapter([{ type: 'result', result: { directive: 'advance' } }]);
    await collect(adapter.startSession(input).events);
    expect(calls[0]!.config?.['model_reasoning_effort']).toBe('high');
  });

  it('records degradation for unsupported optional inference setting (temperature)', async () => {
    const profile = makeProfile({ inferenceSettings: { temperature: 0.5 } });
    const { input } = makeSessionInput({ profile });
    const { adapter } = makeAdapter([{ type: 'result', result: { directive: 'advance' } }]);
    const session = adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    const deg = metadata.degradedCapabilities.find((d) => d.capability === 'inference_setting:temperature');
    expect(deg).toBeDefined();
    expect(deg!.required).toBe(false);
  });

  it('throws UnsupportedProviderCapabilityError before session start when temperature is required', () => {
    const profile = makeProfile({
      inferenceSettings: { temperature: 0.5 },
      endpoint: { requiredAlterations: { inferenceSettings: ['temperature'] } }
    });
    const { input } = makeSessionInput({ profile });
    const { adapter } = makeAdapter([]);
    expect(() => adapter.startSession(input)).toThrowError(UnsupportedProviderCapabilityError);
  });
});

// ---------------------------------------------------------------------------
// Event mapping (T-005)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — event mapping', () => {
  it('maps agent_message to runner_assistant_turn', async () => {
    const { input } = makeSessionInput();
    const { adapter } = makeAdapter([
      { type: 'agent_message', content: 'hello world' },
      { type: 'result', result: { directive: 'advance' } }
    ]);
    const events = await collect(adapter.startSession(input).events);
    const turn = events.find((e) => e.type === 'runner_assistant_turn');
    expect(turn).toBeDefined();
    if (turn?.type !== 'runner_assistant_turn') throw new Error('wrong event');
    expect(turn.message.content).toBe('hello world');
    expect(turn.runId).toBe('run_1');
  });

  it('maps unknown tool calls to runner_tool_activity', async () => {
    const { input } = makeSessionInput();
    const { adapter } = makeAdapter([
      { type: 'tool_call', tool: { name: 'shell', input: { cmd: 'ls' } } },
      { type: 'result', result: { directive: 'advance' } }
    ]);
    const events = await collect(adapter.startSession(input).events);
    const activity = events.find((e) => e.type === 'runner_tool_activity');
    expect(activity).toBeDefined();
    if (activity?.type !== 'runner_tool_activity') throw new Error('wrong event');
    expect(activity.tool.name).toBe('shell');
    expect(activity.tool.status).toBe('started');
  });

  it('maps update_plan / report_progress / notify progress tools', async () => {
    const { input } = makeSessionInput();
    const { adapter } = makeAdapter([
      { type: 'tool_call', tool: { name: 'update_plan', input: { title: 'Plan A', steps: ['s1', 's2'] } } },
      { type: 'tool_call', tool: { name: 'report_progress', input: { label: 'tests', completed: 1, total: 3 } } },
      { type: 'tool_call', tool: { name: 'notify', input: { message: 'heads up', severity: 'warn', importance: 'high' } } },
      { type: 'result', result: { directive: 'advance' } }
    ]);
    const events = await collect(adapter.startSession(input).events);
    const plan = events.find((e) => e.type === 'runner_progress' && e.progress.kind === 'plan');
    const task = events.find((e) => e.type === 'runner_progress' && e.progress.kind === 'task_progress');
    const note = events.find((e) => e.type === 'runner_notification');
    expect(plan).toBeDefined();
    expect(task).toBeDefined();
    expect(note).toBeDefined();
    if (note?.type !== 'runner_notification') throw new Error('wrong event');
    expect(note.notification.severity).toBe('warn');
    expect(note.importance).toBe('high');
  });

  it('marks tokenUsage.available true when usage present', async () => {
    const { input } = makeSessionInput();
    const { adapter } = makeAdapter([
      { type: 'result', result: { directive: 'advance', input_tokens: 30, output_tokens: 12, total_tokens: 42 } }
    ]);
    const session = adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    expect(metadata.tokenUsage.available).toBe(true);
    expect(metadata.tokenUsage.tokens?.input).toBe(30);
    expect(metadata.tokenUsage.tokens?.output).toBe(12);
  });

  it('marks usage unavailable (degraded, not zero) when Codex does not report it', async () => {
    const { input } = makeSessionInput();
    const { adapter } = makeAdapter([{ type: 'result', result: { directive: 'advance' } }]);
    const session = adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    expect(metadata.tokenUsage.available).toBe(false);
    expect(metadata.tokenUsage.tokens).toBeUndefined();
  });

  it('maps needs_input and fail terminal directives', async () => {
    const { input: ni } = makeSessionInput();
    const { adapter: niAdapter } = makeAdapter([
      { type: 'result', result: { directive: 'needs_input', question: 'Which database?' } }
    ]);
    const niEvents = await collect(niAdapter.startSession(ni).events);
    const niTerminal = niEvents.find((e) => e.type === 'runner_terminal_result');
    if (niTerminal?.type !== 'runner_terminal_result') throw new Error('wrong event');
    expect(niTerminal.result.directive).toBe('needs_input');

    const { input: fi } = makeSessionInput();
    const { adapter: fiAdapter } = makeAdapter([
      { type: 'result', result: { directive: 'fail', reason: 'compilation failed' } }
    ]);
    const fiSession = fiAdapter.startSession(fi);
    const fiEvents = await collect(fiSession.events);
    const fiTerminal = fiEvents.find((e) => e.type === 'runner_terminal_result');
    if (fiTerminal?.type !== 'runner_terminal_result') throw new Error('wrong event');
    expect(fiTerminal.result.directive).toBe('fail');
    const metadata = await fiSession.metadata;
    expect(metadata.outcome).toBe('failed');
  });

  it('rejects a second terminal result with impossible_session_sequence', async () => {
    const { input } = makeSessionInput();
    const { adapter } = makeAdapter([
      { type: 'result', result: { directive: 'advance' } },
      { type: 'result', result: { directive: 'advance' } }
    ]);
    const session = adapter.startSession(input);
    session.metadata.catch(() => undefined);
    let err: ProviderProtocolError | undefined;
    try {
      await collect(session.events);
    } catch (e) {
      err = e as ProviderProtocolError;
    }
    expect(err?.code).toBe('impossible_session_sequence');
  });
});

// ---------------------------------------------------------------------------
// Terminal result + legacy result file (T-005, T-008)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — terminal result file', () => {
  it('writes step-result.json to scratchRoot on advance', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'codex-scratch-'));
    try {
      const { input } = makeSessionInput({ scratchRoot });
      const { adapter } = makeAdapter([{ type: 'result', result: { directive: 'advance', output: '{"directive":"advance"}' } }]);
      const events = await collect(adapter.startSession(input).events);
      const terminal = events.find((e) => e.type === 'runner_terminal_result');
      if (terminal?.type !== 'runner_terminal_result') throw new Error('wrong event');
      expect(terminal.result.directive).toBe('advance');
      expect(await readFile(path.join(scratchRoot, 'step-result.json'), 'utf8')).toBe('{"directive":"advance"}');
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('honors the per-round output contract result file and does not create step-result.json', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'codex-scratch-'));
    try {
      const resultFile = 'implementation-build-round-1-reviewer-result.json';
      const { input } = makeSessionInput({
        scratchRoot,
        taskInputs: { role: 'reviewer', round: 1, outputContract: { resultFile } }
      });
      const { adapter } = makeAdapter([
        { type: 'result', result: { directive: 'advance', output: '{"status":"satisfied","findings":[]}' } }
      ]);
      await collect(adapter.startSession(input).events);
      expect(await readFile(path.join(scratchRoot, resultFile), 'utf8')).toBe('{"status":"satisfied","findings":[]}');
      await expect(readFile(path.join(scratchRoot, 'step-result.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing result file', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'codex-scratch-'));
    try {
      const target = path.join(scratchRoot, 'step-result.json');
      await writeFile(target, '{"kept":true}', 'utf8');
      const { input } = makeSessionInput({ scratchRoot });
      const { adapter } = makeAdapter([{ type: 'result', result: { directive: 'advance', output: 'prose only' } }]);
      await collect(adapter.startSession(input).events);
      expect(await readFile(target, 'utf8')).toBe('{"kept":true}');
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Permissions (T-006)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — permissions', () => {
  it('maps reviewer role to a read-only sandbox and strips write tools', async () => {
    const { input } = makeSessionInput({ role: 'reviewer', allowedTools: ['bash', 'filesystem'] });
    const { adapter, calls } = makeAdapter([{ type: 'result', result: { directive: 'advance' } }]);
    await collect(adapter.startSession(input).events);
    expect(calls[0]!.sandbox).toBe('read-only');
    expect(calls[0]!.allowedTools).toContain('read_file');
    expect(calls[0]!.allowedTools).not.toContain('write_file');
    expect(calls[0]!.allowedTools).not.toContain('apply_patch');
  });

  it('fails with a safe unsupported-capability error when the runtime cannot enforce reviewer read-only', () => {
    const { input } = makeSessionInput({ role: 'reviewer' });
    const { adapter } = makeAdapter([], { acceptedSandboxValues: new Set(['workspace-write']) });
    let err: unknown;
    try {
      adapter.startSession(input);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedProviderCapabilityError);
    expect((err as UnsupportedProviderCapabilityError).code).toBe('tool_policy_unsupported');
  });
});

// ---------------------------------------------------------------------------
// Skills (T-007)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — skills', () => {
  it('delivers resolved skills to Codex and reports delivered identifiers', async () => {
    const resolvedSkills: ResolvedSkill[] = [
      { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] },
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: ['mm:writing-guidelines'] }
    ];
    const logs: Array<{ event: string; fields: unknown }> = [];
    const { input } = makeSessionInput({ resolvedSkills, requestedSkills: ['mm:planning', 'mm:writing-guidelines'] });
    const { adapter, calls } = makeAdapter([{ type: 'result', result: { directive: 'advance' } }], {
      logger: {
        info: (event, fields) => logs.push({ event, fields }),
        warn: (event, fields) => logs.push({ event, fields }),
        error: (event, fields) => logs.push({ event, fields })
      }
    });
    await collect(adapter.startSession(input).events);
    expect(calls[0]!.skills).toHaveLength(2);
    expect(calls[0]!.skills?.map((s) => s.ref)).toEqual(['mm:writing-guidelines', 'mm:planning']);
    const start = logs.find((l) => l.event === 'codex.adapter.session_start');
    const serialized = JSON.stringify(start?.fields);
    expect(serialized).toContain('mm:planning');
    expect(serialized).toContain('"deliveredSkillCount":2');
    expect(serialized).toContain('"requestedSkillCount":2');
  });

  it('fails before launch when a resolved skill asset path escapes the catalog', async () => {
    const resolvedSkills: ResolvedSkill[] = [{ ref: 'mm:planning', assetPath: '../../etc/passwd', dependencies: [] }];
    const { input } = makeSessionInput({ resolvedSkills });
    const { adapter, calls } = makeAdapter([]);
    let threw = false;
    try {
      adapter.startSession(input);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Authentication (T-004)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — enterprise sign-in', () => {
  const FAILURE_CODES = ['missing_sign_in', 'expired_sign_in', 'disallowed_plan', 'account_mismatch'] as const;

  for (const code of FAILURE_CODES) {
    it(`classifies ${code} as a safe provider_auth_failed without secrets`, async () => {
      const logs: unknown[] = [];
      const { input } = makeSessionInput();
      const adapter = createCodexAgentAdapter({
        probeCodexAuth: () => ({ status: 'unauthenticated', code }),
        launchCodexSession: () => asyncIter([]),
        logger: {
          info: (_e, f) => logs.push(f),
          warn: (_e, f) => logs.push(f),
          error: (_e, f) => logs.push(f)
        }
      });
      const session = adapter.startSession(input);
      session.metadata.catch(() => undefined);
      let err: unknown;
      try {
        await collect(session.events);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CodexAuthenticationError);
      const authErr = err as CodexAuthenticationError;
      expect(authErr.failureReason).toBe('provider_auth_failed');
      expect(authErr.authFailureCode).toBe(code);
      const serialized = JSON.stringify(logs) + JSON.stringify(authErr);
      expect(serialized).toContain('provider_auth_failed');
      expect(serialized).not.toContain(SECRET_TOKEN);
    });
  }

  it('does not launch a session when authentication fails (no paid retry)', async () => {
    const { input } = makeSessionInput();
    const calls: CodexSessionLaunchOptions[] = [];
    const adapter = createCodexAgentAdapter({
      probeCodexAuth: () => ({ status: 'unauthenticated', code: 'expired_sign_in' }),
      launchCodexSession: (opts) => {
        calls.push(opts);
        return asyncIter([]);
      }
    });
    const session = adapter.startSession(input);
    session.metadata.catch(() => undefined);
    await collect(session.events).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Structured results (T-008 / T-009)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — structured results', () => {
  async function runWithCapture(
    events: CodexNativeEvent[],
    capture: StructuredAgentResultCapture,
    opts: { scratchRoot?: string; role?: string; allowedTools?: string[] } = {}
  ): Promise<{ events: RunnerEvent[]; calls: CodexSessionLaunchOptions[] }> {
    const { input } = makeSessionInput({
      ...(opts.scratchRoot !== undefined ? { scratchRoot: opts.scratchRoot } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {})
    });
    const inputWithCapture: AgentProviderSessionInput = { ...input, structuredResultCapture: capture };
    const { adapter, calls } = makeAdapter(events);
    const out = await collect(adapter.startSession(inputWithCapture).events);
    return { events: out, calls };
  }

  it('captures the reviewer structured result under read-only permissions without repo write', async () => {
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-reviewer-'));
    try {
      const structuredOutput = { status: 'satisfied', findings: [] };
      const { calls } = await runWithCapture(
        [{ type: 'result', structuredOutput, result: { directive: 'advance', output: 'prose summary' } }],
        makeCapture('autocatalyst.reviewer_result.v1', 'reviewer-result.json'),
        { scratchRoot, role: 'reviewer', allowedTools: ['filesystem'] }
      );
      expect(calls[0]!.sandbox).toBe('read-only');
      expect(calls[0]!.allowedTools).not.toContain('write_file');
      const text = await readFile(path.join(scratchRoot, 'reviewer-result.json'), 'utf8');
      expect(JSON.parse(text)).toEqual(structuredOutput);
    } finally {
      await rm(scratchRoot, { recursive: true });
    }
  });

  it('writes spec authoring output to step-result.json', async () => {
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-spec-'));
    try {
      const out = { kind: 'feature_spec', slug: 'demo' };
      await runWithCapture(
        [{ type: 'result', structuredOutput: out, result: { directive: 'advance' } }],
        makeCapture('autocatalyst.spec_author.v1', 'step-result.json', 'specification.author'),
        { scratchRoot }
      );
      expect(JSON.parse(await readFile(path.join(scratchRoot, 'step-result.json'), 'utf8'))).toEqual(out);
    } finally {
      await rm(scratchRoot, { recursive: true });
    }
  });

  it('writes distinct implementer and reviewer per-round files', async () => {
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-rounds-'));
    try {
      const reviewer = { status: 'satisfied', findings: [] };
      await runWithCapture(
        [{ type: 'result', structuredOutput: reviewer, result: { directive: 'advance' } }],
        makeCapture('autocatalyst.reviewer_result.v1', 'implementation-build-round-1-reviewer-result.json'),
        { scratchRoot, role: 'reviewer' }
      );
      const impl = { dispositions: [] };
      await runWithCapture(
        [{ type: 'result', structuredOutput: impl, result: { directive: 'advance' } }],
        makeCapture('autocatalyst.implementer_dispositions.v1', 'implementation-build-round-1-implementer-result.json'),
        { scratchRoot, role: 'implementer' }
      );
      expect(JSON.parse(await readFile(path.join(scratchRoot, 'implementation-build-round-1-reviewer-result.json'), 'utf8'))).toEqual(reviewer);
      expect(JSON.parse(await readFile(path.join(scratchRoot, 'implementation-build-round-1-implementer-result.json'), 'utf8'))).toEqual(impl);
    } finally {
      await rm(scratchRoot, { recursive: true });
    }
  });

  it('isolates PR finalization: writes pr-finalize-result.json and ignores a stale step-result.json', async () => {
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-prfinal-'));
    try {
      const stale = '{"stale":"spec authoring output"}';
      await writeFile(path.join(scratchRoot, 'step-result.json'), stale, 'utf8');
      const finalize = { directive: 'advance', findings: [] };
      await runWithCapture(
        [{ type: 'result', structuredOutput: finalize, result: { directive: 'advance' } }],
        makeCapture('autocatalyst.pr_finalize.v1', 'pr-finalize-result.json', 'pr.finalize'),
        { scratchRoot }
      );
      expect(JSON.parse(await readFile(path.join(scratchRoot, 'pr-finalize-result.json'), 'utf8'))).toEqual(finalize);
      // The stale step-result.json is untouched.
      expect(await readFile(path.join(scratchRoot, 'step-result.json'), 'utf8')).toBe(stale);
    } finally {
      await rm(scratchRoot, { recursive: true });
    }
  });

  it('throws missing_structured_result when the session ends without structured output', async () => {
    const { input } = makeSessionInput();
    const inputWithCapture: AgentProviderSessionInput = {
      ...input,
      structuredResultCapture: makeCapture('autocatalyst.reviewer_result.v1', 'reviewer-result.json')
    };
    const { adapter } = makeAdapter([{ type: 'result', result: { directive: 'advance', output: 'done' } }]);
    let err: ProviderProtocolError | undefined;
    try {
      await collect(adapter.startSession(inputWithCapture).events);
    } catch (e) {
      err = e as ProviderProtocolError;
    }
    expect(err?.code).toBe('missing_structured_result');
  });

  it('throws duplicate_structured_result on a second structured output', async () => {
    const { input } = makeSessionInput();
    const result = { status: 'satisfied', findings: [] };
    const inputWithCapture: AgentProviderSessionInput = {
      ...input,
      structuredResultCapture: makeCapture('autocatalyst.reviewer_result.v1', 'reviewer-result.json')
    };
    const { adapter } = makeAdapter([
      { type: 'result', structuredOutput: result, result: { directive: 'advance' } },
      { type: 'result', structuredOutput: result, result: { directive: 'advance' } }
    ]);
    const session = adapter.startSession(inputWithCapture);
    session.metadata.catch(() => undefined);
    let err: ProviderProtocolError | undefined;
    try {
      await collect(session.events);
    } catch (e) {
      err = e as ProviderProtocolError;
    }
    expect(err?.code).toBe('duplicate_structured_result');
  });
});

// ---------------------------------------------------------------------------
// Failure handling (T-005)
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — failure handling', () => {
  it('classifies a transient app-server failure and rejects cleanly', async () => {
    const { input } = makeSessionInput();
    const failing: CodexSessionLaunch = async function* () {
      yield { type: 'agent_message', content: 'working' } as CodexNativeEvent;
      throw Object.assign(new Error('raw upstream body'), { status: 503 });
    };
    const adapter = createCodexAgentAdapter({ probeCodexAuth: AUTHED, launchCodexSession: failing });
    const session = adapter.startSession(input);
    session.metadata.catch(() => undefined);
    let err: unknown;
    try {
      await collect(session.events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClassifiedProviderFailureError);
    expect((err as ClassifiedProviderFailureError).failureReason).toBe('transient_provider_failure');
    await expect(session.metadata).rejects.toBeInstanceOf(ClassifiedProviderFailureError);
  });

  it('terminates cleanly on an abnormal app-server exit', async () => {
    const { input } = makeSessionInput();
    const failing: CodexSessionLaunch = async function* () {
      yield { type: 'agent_message', content: 'working' } as CodexNativeEvent;
      throw new ProviderConnectionError('process_launch_failed', 'The Codex app-server exited abnormally.');
    };
    const adapter = createCodexAgentAdapter({ probeCodexAuth: AUTHED, launchCodexSession: failing });
    const session = adapter.startSession(input);
    session.metadata.catch(() => undefined);
    let err: unknown;
    try {
      await collect(session.events);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderConnectionError);
    expect((err as ProviderConnectionError).code).toBe('process_launch_failed');
  });
});

// ---------------------------------------------------------------------------
// Credential redaction
// ---------------------------------------------------------------------------

describe('createCodexAgentAdapter — credential redaction', () => {
  it('redacts secrets echoed in assistant content and never logs them', async () => {
    const logs: unknown[] = [];
    const { input } = makeSessionInput();
    const adapter = createCodexAgentAdapter({
      probeCodexAuth: AUTHED,
      launchCodexSession: () =>
        asyncIter([
          { type: 'agent_message', content: `token is ${SECRET_TOKEN}` },
          { type: 'result', result: { directive: 'advance' } }
        ]),
      logger: {
        info: (_e, f) => logs.push(f),
        warn: (_e, f) => logs.push(f),
        error: (_e, f) => logs.push(f)
      }
    });
    const events = await collect(adapter.startSession(input).events);
    const turn = events.find((e) => e.type === 'runner_assistant_turn');
    if (turn?.type !== 'runner_assistant_turn') throw new Error('wrong event');
    expect(turn.message.content).not.toContain(SECRET_TOKEN);
    expect(turn.message.content).toContain('[REDACTED]');
    expect(JSON.stringify(logs)).not.toContain(SECRET_TOKEN);
  });
});
