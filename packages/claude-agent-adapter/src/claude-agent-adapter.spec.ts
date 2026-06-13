import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ResolvedSkill, RunnerEvent } from '@autocatalyst/api-contract';
import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentProviderSessionInput,
  ProcessLaunchConfig,
  ProcessLaunchConfigInput,
  ProviderFetchTransport,
  ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import { ClassifiedProviderFailureError, UnsupportedProviderCapabilityError } from '@autocatalyst/execution';

import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter,
  type ClaudeNativeEvent,
  type ClaudeSessionLaunch,
  type ClaudeSessionLaunchOptions
} from './claude-agent-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET_TOKEN = 'sk-ant-secret-12345';

function makeProfile(overrides?: Partial<ResolvedAgentRunnerProfile>): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: claudeProviderKind,
    adapterId: claudeAgentAdapterId,
    profileName: 'default',
    model: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
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
      ANTHROPIC_AUTH_TOKEN: SECRET_TOKEN,
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
    },
    secretVariableNames: ['ANTHROPIC_AUTH_TOKEN'],
    degradedCapabilities: [],
    redacted: {
      mechanism: 'process_environment',
      // intentionally not including the secret value
      hasAuthToken: true
    }
  };
  recorder.connection = {
    profile,
    credentialResolved: true,
    createFetchTransport(): ProviderFetchTransport {
      recorder.fetchTransportCalls += 1;
      throw new Error('createFetchTransport should not be called for the Claude adapter');
    },
    createProcessLaunchConfig(input: ProcessLaunchConfigInput): ProcessLaunchConfig {
      createProcessLaunchConfigCalls.push(input);
      return launchConfig;
    }
  };
  return recorder;
}

function makeTelemetry(): AgentConnectionTelemetryContext {
  return { runId: 'run_1', step: 'implement' };
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
          task: { prompt: args.prompt ?? 'Build the feature', inputs: {} },
          workspaceIntent: { shape: 'none' },
          secretBindings: [],
          toolPolicy: { allowedTools: args.allowedTools ?? ['bash'], workspaceScope: 'declared_workspace' },
          skills: { requested: args.requestedSkills ?? ['stub_runner'], resolved: args.resolvedSkills ?? [] },
          capabilityRequirements: {
            shell: { kind: 'bash', required: false },
            paths: { canonicalWorkspacePaths: true },
            lsp: { requested: false }
          }
        },
        workspace,
        environment: { variables, secretVariableNames },
        toolPolicy: { allowedTools: args.allowedTools ?? ['bash'], workspaceRoots: workspace.workspaceRoots },
        skills: { requested: args.requestedSkills ?? ['stub_runner'], resolved: args.resolvedSkills ?? [] },
        capabilities: {
          shell: { kind: 'bash', available: true },
          paths: workspace.shape === 'two_roots'
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
    telemetryContext: makeTelemetry()
  };
  return { input, recorder };
}

function fakeLaunch(events: ClaudeNativeEvent[]): {
  launch: ClaudeSessionLaunch;
  calls: ClaudeSessionLaunchOptions[];
} {
  const calls: ClaudeSessionLaunchOptions[] = [];
  const launch: ClaudeSessionLaunch = (options) => {
    calls.push(options);
    async function* gen(): AsyncIterable<ClaudeNativeEvent> {
      for (const ev of events) yield ev;
    }
    return gen();
  };
  return { launch, calls };
}

async function collect(stream: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Sentinel no-leak helper
// ---------------------------------------------------------------------------

function expectNoSentinels(serialized: string): void {
  expect(serialized).not.toContain('sk-test-secret');
  expect(serialized).not.toContain('authorization: Bearer');
  expect(serialized).not.toContain('/Users/mark/private');
  expect(serialized).not.toContain('sec_secret_handle_value');
  expect(serialized).not.toContain('raw SDK diagnostic');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createClaudeAgentAdapter — identity', () => {
  it('uses anthropic / claude-agent-sdk / process_environment', () => {
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: fakeLaunch([]).launch });
    expect(adapter.providerKind).toBe('anthropic');
    expect(adapter.adapterId).toBe('claude-agent-sdk');
    expect(adapter.supportedConnectionMechanism).toBe('process_environment');
  });
});

describe('createClaudeAgentAdapter — connection mechanism', () => {
  it('calls createProcessLaunchConfig once and never createFetchTransport', async () => {
    const { input, recorder } = makeSessionInput();
    const { launch } = fakeLaunch([{ type: 'result', result: { output: '{}' } }]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    await collect(session.events);
    expect(recorder.createProcessLaunchConfigCalls).toHaveLength(1);
    expect(recorder.fetchTransportCalls).toBe(0);
    // Verify the materialized environment passed through.
    expect(recorder.createProcessLaunchConfigCalls[0]!.materializedEnvironment).toBeDefined();
  });
});

describe('createClaudeAgentAdapter — launch input mapping', () => {
  it('forwards prompt, cwd, allowedTools, and connection env', async () => {
    const scratchRoot = '/tmp/claude-adapter-test-scratch';
    const { input } = makeSessionInput({
      prompt: 'Implement parser',
      allowedTools: ['bash', 'edit'],
      scratchRoot
    });
    const { launch, calls } = fakeLaunch([{ type: 'result', result: { output: '' } }]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    await collect(session.events);
    expect(calls).toHaveLength(1);
    const opts = calls[0]!;
    expect(opts.prompt).toBe('Implement parser');
    expect(opts.cwd).toBe(scratchRoot);
    expect(opts.allowedTools).toEqual(['bash', 'edit']);
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe(SECRET_TOKEN);
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('does not include options.skills when resolved skills list is empty', async () => {
    const { input } = makeSessionInput({ resolvedSkills: [] });
    const { launch, calls } = fakeLaunch([{ type: 'result', result: { output: '' } }]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    await collect(session.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toBeUndefined();
  });

  it('passes materialized plugin entries in options.skills when resolved skills are present', async () => {
    const resolvedSkills: ResolvedSkill[] = [
      { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] },
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: ['mm:writing-guidelines'] }
    ];
    const { input } = makeSessionInput({ resolvedSkills });
    const { launch, calls } = fakeLaunch([{ type: 'result', result: { output: '' } }]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    await collect(session.events);
    expect(calls).toHaveLength(1);
    const skillOptions = calls[0]!.options?.skills;
    expect(Array.isArray(skillOptions)).toBe(true);
    expect((skillOptions as unknown[]).length).toBe(2);
    const [first, second] = skillOptions as Array<{ type: string; path: string }>;
    expect(first!.type).toBe('claudecode');
    expect(first!.path).toMatch(/assets\/mm\/writing-guidelines$/);
    expect(second!.type).toBe('claudecode');
    expect(second!.path).toMatch(/assets\/mm\/planning$/);
  });
});

describe('createClaudeAgentAdapter — assistant turn mapping', () => {
  it('maps native assistant content to runner_assistant_turn', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'assistant', content: 'hello world' },
      { type: 'result', result: { output: '' } }
    ]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    const events = await collect(session.events);
    const turn = events.find((e) => e.type === 'runner_assistant_turn');
    expect(turn).toBeDefined();
    if (turn?.type !== 'runner_assistant_turn') throw new Error('wrong event');
    expect(turn.message.role).toBe('assistant');
    expect(turn.message.content).toBe('hello world');
    expect(turn.runId).toBe('run_1');
    expect(turn.step).toBe('implement');
  });
});

describe('createClaudeAgentAdapter — generic tool call mapping', () => {
  it('maps unknown tool calls to runner_tool_activity', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      { type: 'tool_use', tool: { name: 'grep', input: { pattern: 'foo' } } },
      { type: 'result', result: { output: '' } }
    ]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    const events = await collect(session.events);
    const activity = events.find((e) => e.type === 'runner_tool_activity');
    expect(activity).toBeDefined();
    if (activity?.type !== 'runner_tool_activity') throw new Error('wrong event');
    expect(activity.tool.name).toBe('grep');
    expect(activity.tool.action).toBe('invoke');
    expect(activity.tool.status).toBe('started');
  });
});

describe('createClaudeAgentAdapter — progress tool mapping', () => {
  it('maps update_plan to a plan runner_progress event', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      {
        type: 'tool_use',
        tool: { name: 'update_plan', input: { title: 'Plan A', steps: ['s1', 's2'] } }
      },
      { type: 'result', result: { output: '' } }
    ]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    const events = await collect(session.events);
    const progress = events.find((e) => e.type === 'runner_progress');
    expect(progress).toBeDefined();
    if (progress?.type !== 'runner_progress') throw new Error('wrong event');
    expect(progress.progress.kind).toBe('plan');
    if (progress.progress.kind !== 'plan') throw new Error('wrong kind');
    expect(progress.progress.title).toBe('Plan A');
    expect(progress.progress.steps).toEqual(['s1', 's2']);
  });

  it('maps report_progress task_progress to runner_progress', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      {
        type: 'tool_use',
        tool: { name: 'report_progress', input: { label: 'tests', completed: 1, total: 3 } }
      },
      { type: 'result', result: { output: '' } }
    ]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    const events = await collect(session.events);
    const progress = events.find((e) => e.type === 'runner_progress');
    expect(progress).toBeDefined();
    if (progress?.type !== 'runner_progress') throw new Error('wrong event');
    expect(progress.progress.kind).toBe('task_progress');
    if (progress.progress.kind !== 'task_progress') throw new Error('wrong kind');
    expect(progress.progress.label).toBe('tests');
    expect(progress.progress.completed).toBe(1);
    expect(progress.progress.total).toBe(3);
  });
});

describe('createClaudeAgentAdapter — notify mapping', () => {
  it('maps notify tool to runner_notification', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      {
        type: 'tool_use',
        tool: {
          name: 'notify',
          input: { message: 'heads up', severity: 'warn', importance: 'high' }
        }
      },
      { type: 'result', result: { output: '' } }
    ]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    const events = await collect(session.events);
    const notification = events.find((e) => e.type === 'runner_notification');
    expect(notification).toBeDefined();
    if (notification?.type !== 'runner_notification') throw new Error('wrong event');
    expect(notification.notification.severity).toBe('warn');
    expect(notification.notification.message).toBe('heads up');
    expect(notification.importance).toBe('high');
  });
});

describe('createClaudeAgentAdapter — token usage metadata', () => {
  it('marks tokenUsage.available true when usage present', async () => {
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      {
        type: 'result',
        result: { output: '{}', total_tokens: 42, input_tokens: 30, output_tokens: 12 }
      }
    ]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    expect(metadata.outcome).toBe('succeeded');
    expect(metadata.tokenUsage.available).toBe(true);
    expect(metadata.tokenUsage.tokens?.total).toBe(42);
    expect(metadata.tokenUsage.tokens?.input).toBe(30);
    expect(metadata.tokenUsage.tokens?.output).toBe(12);
  });
});

describe('createClaudeAgentAdapter — terminal result', () => {
  it('writes step-result.json to scratchRoot and emits runner_terminal_result advance', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'claude-adapter-scratch-'));
    try {
      const { input } = makeSessionInput({ scratchRoot });
      const { launch } = fakeLaunch([
        { type: 'result', result: { output: '{"directive":"advance"}' } }
      ]);
      const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
      const session = await adapter.startSession(input);
      const events = await collect(session.events);
      const terminal = events.find((e) => e.type === 'runner_terminal_result');
      expect(terminal).toBeDefined();
      if (terminal?.type !== 'runner_terminal_result') throw new Error('wrong event');
      expect(terminal.result.directive).toBe('advance');
      const written = await readFile(path.join(scratchRoot, 'step-result.json'), 'utf8');
      expect(written).toBe('{"directive":"advance"}');
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

describe('createClaudeAgentAdapter — inference setting capability', () => {
  it('records degradation for unsupported optional inference setting (temperature)', async () => {
    const profile = makeProfile({ inferenceSettings: { temperature: 0.5 } });
    const { input } = makeSessionInput({ profile });
    const { launch } = fakeLaunch([{ type: 'result', result: { output: '' } }]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    await collect(session.events);
    const metadata = await session.metadata;
    const tempDeg = metadata.degradedCapabilities.find(
      (d) => d.capability === 'inference_setting:temperature'
    );
    expect(tempDeg).toBeDefined();
    expect(tempDeg!.required).toBe(false);
  });

  it('throws UnsupportedProviderCapabilityError when temperature is in requiredAlterations', () => {
    const profile = makeProfile({
      inferenceSettings: { temperature: 0.5 },
      endpoint: { requiredAlterations: { inferenceSettings: ['temperature'] } }
    });
    const { input } = makeSessionInput({ profile });
    const { launch } = fakeLaunch([]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    expect(() => adapter.startSession(input)).toThrowError(UnsupportedProviderCapabilityError);
  });
});

describe('createClaudeAgentAdapter — skill containment', () => {
  it('throws before calling launch when a resolved skill assetPath escapes the catalog via traversal', async () => {
    const resolvedSkills = [
      { ref: 'mm:planning', assetPath: '../../etc/passwd', dependencies: [] }
    ];
    const { input } = makeSessionInput({ resolvedSkills });
    const { launch, calls } = fakeLaunch([]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    // startSession itself may throw synchronously, or the returned session may
    // throw on iteration — both are valid containment responses.
    let threw = false;
    try {
      const session = await adapter.startSession(input);
      // If startSession didn't throw, drain the stream to trigger any lazy throw.
      await collect(session.events);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('createClaudeAgentAdapter — provider failure classification', () => {
  it('classifies SDK authentication failures without logging raw messages', async () => {
    const logs: unknown[] = [];
    const authError = Object.assign(new Error('raw anthropic body sk-test-secret /Users/mark/private authorization: Bearer sec_secret_handle_value raw SDK diagnostic'), {
      name: 'AuthenticationError',
      status: 401,
      code: 'authentication_error'
    });
    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: async function* () { yield await Promise.reject<ClaudeNativeEvent>(authError); },
      logger: {
        info: (event, fields) => logs.push({ level: 'info', event, fields }),
        warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
        error: (event, fields) => logs.push({ level: 'error', event, fields })
      }
    });

    const { input } = makeSessionInput();
    const session = adapter.startSession(input);
    // Suppress unhandled rejection on metadata — we only care about the events stream here.
    session.metadata.catch(() => undefined);
    await expect(async () => {
      for await (const _event of session.events) {
        // drain generator
      }
    }).rejects.toSatisfy((err: unknown) => err instanceof ClassifiedProviderFailureError && err.failureReason === 'provider_auth_failed');

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).toContain('provider_auth_failed');
    expect(serializedLogs).not.toContain('raw anthropic body');
    expectNoSentinels(serializedLogs);
  });
});

describe('createClaudeAgentAdapter — credential redaction', () => {
  it('does not leak the credential into adapter logs', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const { input } = makeSessionInput();
    const { launch } = fakeLaunch([
      // Even if the SDK accidentally echoed the credential in assistant text,
      // the adapter should scrub it before emitting.
      { type: 'assistant', content: `oops the token is ${SECRET_TOKEN}` },
      { type: 'result', result: { output: '' } }
    ]);
    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: launch,
      logger: { info, warn, error }
    });
    const session = await adapter.startSession(input);
    const events = await collect(session.events);

    // Walk all logged calls and all emitted events; assert no raw secret.
    const allLogged = JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls]);
    expect(allLogged.includes(SECRET_TOKEN)).toBe(false);
    const turn = events.find((e) => e.type === 'runner_assistant_turn');
    expect(turn).toBeDefined();
    if (turn?.type !== 'runner_assistant_turn') throw new Error('wrong event');
    expect(turn.message.content.includes(SECRET_TOKEN)).toBe(false);
    expect(turn.message.content.includes('[REDACTED]')).toBe(true);
  });
});
