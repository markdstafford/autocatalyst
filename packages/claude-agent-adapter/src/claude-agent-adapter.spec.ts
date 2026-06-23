import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
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
  ProviderProtocolError,
  UnsupportedProviderCapabilityError
} from '@autocatalyst/execution';

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
  taskInputs?: Record<string, unknown>;
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
// Structured result helpers
// ---------------------------------------------------------------------------

async function* asyncIter(events: ClaudeNativeEvent[]): AsyncIterable<ClaudeNativeEvent> {
  for (const ev of events) yield ev;
}

function successfulResultStream(): AsyncIterable<ClaudeNativeEvent> {
  return asyncIter([
    { type: 'tool_use', tool: { name: 'submit_result', input: { status: 'satisfied', findings: [] } } },
    { type: 'result', result: { is_error: false, output: 'Done.' } }
  ]);
}

function makeReviewerCapture(resultFile = 'step-result.json'): StructuredAgentResultCapture {
  return {
    step: 'implementation.build',
    schemaId: 'autocatalyst.reviewer_result.v1',
    schema: z.object({ status: z.enum(['satisfied', 'changes_requested', 'rejected']), findings: z.array(z.any()).optional() }),
    resultFile,
    required: true
  };
}

interface RunAdapterCaptureOptions {
  allowedTools?: string[];
  scratchRoot?: string;
}

async function runAdapterWithCapture(
  adapter: ReturnType<typeof createClaudeAgentAdapter>,
  capture: StructuredAgentResultCapture,
  opts: RunAdapterCaptureOptions = {}
): Promise<RunnerEvent[]> {
  const { input } = makeSessionInput({
    allowedTools: opts.allowedTools,
    scratchRoot: opts.scratchRoot
  });
  const inputWithCapture: AgentProviderSessionInput = {
    ...input,
    structuredResultCapture: capture
  };
  const session = await adapter.startSession(inputWithCapture);
  return collect(session.events);
}

async function runAdapterNoCapture(
  adapter: ReturnType<typeof createClaudeAgentAdapter>,
  opts: RunAdapterCaptureOptions = {}
): Promise<RunnerEvent[]> {
  const { input } = makeSessionInput({
    allowedTools: opts.allowedTools,
    scratchRoot: opts.scratchRoot
  });
  const session = await adapter.startSession(input);
  return collect(session.events);
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

  it('awaits async process launch config from the connection layer', async () => {
    const ASYNC_BASE_URL = 'http://127.0.0.1:45678';
    const profile = makeProfile();
    const asyncLaunchConfig: ProcessLaunchConfig = {
      environment: {
        ANTHROPIC_AUTH_TOKEN: SECRET_TOKEN,
        ANTHROPIC_BASE_URL: ASYNC_BASE_URL
      },
      secretVariableNames: ['ANTHROPIC_AUTH_TOKEN'],
      degradedCapabilities: [],
      redacted: {
        mechanism: 'process_environment',
        hasAuthToken: true
      }
    };
    // Build a connection where createProcessLaunchConfig returns a Promise.
    const asyncConnection: AgentConnection = {
      profile,
      credentialResolved: true,
      createFetchTransport(): ProviderFetchTransport {
        throw new Error('createFetchTransport should not be called');
      },
      createProcessLaunchConfig(_input: ProcessLaunchConfigInput): Promise<ProcessLaunchConfig> {
        return Promise.resolve(asyncLaunchConfig);
      }
    };
    const { launch, calls } = fakeLaunch([{ type: 'result', result: { output: '' } }]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const input: AgentProviderSessionInput = {
      runInput: (makeSessionInput({ profile }).input).runInput,
      profile,
      connection: asyncConnection,
      telemetryContext: makeTelemetry()
    };
    const session = await adapter.startSession(input);
    await collect(session.events);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env?.ANTHROPIC_BASE_URL).toBe(ASYNC_BASE_URL);
    expect(calls[0]!.env?.ANTHROPIC_AUTH_TOKEN).toBe(SECRET_TOKEN);
  });
});

describe('createClaudeAgentAdapter — launch input mapping', () => {
  it('forwards prompt, cwd, allowedTools, and connection env', async () => {
    const scratchRoot = '/tmp/claude-adapter-test-scratch';
    const { input } = makeSessionInput({
      prompt: 'Implement parser',
      allowedTools: ['bash', 'filesystem', 'lsp'],
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
    expect(opts.allowedTools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe(SECRET_TOKEN);
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('deduplicates Claude tool names and preserves already concrete Claude tools', async () => {
    const { input } = makeSessionInput({
      allowedTools: ['bash', 'filesystem', 'Bash', 'Read']
    });
    const { launch, calls } = fakeLaunch([{ type: 'result', result: { output: '' } }]);
    const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
    const session = await adapter.startSession(input);
    await collect(session.events);

    expect(calls[0]?.allowedTools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
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

  it('does not overwrite an existing step-result.json when SDK final output is prose', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'claude-adapter-scratch-'));
    try {
      const target = path.join(scratchRoot, 'step-result.json');
      await writeFile(target, '{"kind":"feature_spec","slug":"kept"}', 'utf8');
      const { input } = makeSessionInput({ scratchRoot });
      const { launch } = fakeLaunch([
        { type: 'result', result: { output: 'Done, I wrote the file.' } }
      ]);
      const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
      const session = await adapter.startSession(input);
      await collect(session.events);

      await expect(readFile(target, 'utf8')).resolves.toBe('{"kind":"feature_spec","slug":"kept"}');
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('captures the final output into the per-round result file named by the output contract', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'claude-adapter-scratch-'));
    try {
      const resultFile = 'implementation-build-round-1-reviewer-result.json';
      const { input } = makeSessionInput({
        scratchRoot,
        taskInputs: { role: 'reviewer', round: 1, outputContract: { resultFile } }
      });
      const { launch } = fakeLaunch([
        { type: 'result', result: { output: '{"status":"satisfied","findings":[]}' } }
      ]);
      const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
      const session = await adapter.startSession(input);
      await collect(session.events);

      await expect(readFile(path.join(scratchRoot, resultFile), 'utf8'))
        .resolves.toBe('{"status":"satisfied","findings":[]}');
      // The shared step-result.json is never created.
      await expect(readFile(path.join(scratchRoot, 'step-result.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('writes SDK final output when step-result.json does not already exist', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'claude-adapter-scratch-'));
    try {
      const { input } = makeSessionInput({ scratchRoot });
      const { launch } = fakeLaunch([
        { type: 'result', result: { output: '{"directive":"advance"}' } }
      ]);
      const adapter = createClaudeAgentAdapter({ launchClaudeSession: launch });
      const session = await adapter.startSession(input);
      await collect(session.events);

      await expect(readFile(path.join(scratchRoot, 'step-result.json'), 'utf8'))
        .resolves.toBe('{"directive":"advance"}');
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

  it('does not copy sentinel-bearing code/name into safeDetails when 401 triggers status-based classification', async () => {
    const sentinelCode = 'sk-test-secret /Users/mark/private raw SDK diagnostic';
    const sentinelName = 'authorization: Bearer sec_secret_handle_value';
    const authError = Object.assign(new Error('raw body'), {
      name: sentinelName,
      status: 401,
      code: sentinelCode
    });
    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: async function* () { yield await Promise.reject<ClaudeNativeEvent>(authError); }
    });

    const { input } = makeSessionInput();
    const session = adapter.startSession(input);
    session.metadata.catch(() => undefined);
    let thrownErr: unknown;
    try {
      for await (const _event of session.events) { /* drain */ }
    } catch (e) {
      thrownErr = e;
    }
    expect(thrownErr).toBeInstanceOf(ClassifiedProviderFailureError);
    const classified = thrownErr as ClassifiedProviderFailureError;
    expect(classified.failureReason).toBe('provider_auth_failed');
    const serialized = JSON.stringify(classified);
    expect(serialized).not.toContain('sk-test-secret');
    expect(serialized).not.toContain('/Users/mark/private');
    expect(serialized).not.toContain('authorization: Bearer');
    expect(serialized).not.toContain('sec_secret_handle_value');
    expect(serialized).not.toContain('raw SDK diagnostic');
  });

  it('does not log sentinel-bearing err.name when classification is via status code (logger regression)', async () => {
    // When err.name is untrusted (e.g. contains a token or path) but the error
    // is classified through status: 401, the logger must not emit the raw name.
    const sentinelName = 'authorization: Bearer sec_secret_handle_value sk-test-secret /Users/mark/private raw SDK diagnostic';
    const logs: unknown[] = [];
    const authError = Object.assign(new Error('raw body'), {
      name: sentinelName,
      status: 401
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
    session.metadata.catch(() => undefined);
    await collect(session.events).catch(() => undefined);
    const serializedLogs = JSON.stringify(logs);
    expectNoSentinels(serializedLogs);
    expect(serializedLogs).toContain('provider_auth_failed');
  });
});

describe('createClaudeAgentAdapter — structured result capture', () => {
  it('passes submit_result in allowedTools for structured sessions', async () => {
    const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'test-claude-toolreg-'));
    try {
      const launchCalls: ClaudeSessionLaunchOptions[] = [];

      const adapter = createClaudeAgentAdapter({
        launchClaudeSession: (opts) => {
          launchCalls.push(opts);
          return successfulResultStream();
        },
        supportsStructuredResultTools: true
      });

      const capture = makeReviewerCapture();
      await runAdapterWithCapture(adapter, capture, { scratchRoot: scratchDir });

      expect(launchCalls[0]!.allowedTools).toContain('submit_result');
      expect(launchCalls[0]!.structuredResultTool?.name).toBe('submit_result');
      expect(launchCalls[0]!.structuredResultTool?.projection.mechanism).toBe('claude_submit_result_tool');
    } finally {
      await rm(scratchDir, { recursive: true });
    }
  });

  it('allows submit_result in read-only reviewer sessions without granting write tools', async () => {
    const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'test-claude-reviewer-'));
    try {
      const submittedResult = { status: 'satisfied', findings: [] };

      const events: ClaudeNativeEvent[] = [
        { type: 'tool_use', tool: { name: 'submit_result', input: submittedResult } },
        { type: 'result', result: { is_error: false, output: 'prose summary here' } }
      ];

      const launchCalls: ClaudeSessionLaunchOptions[] = [];
      const adapter = createClaudeAgentAdapter({
        launchClaudeSession: (opts) => {
          launchCalls.push(opts);
          return asyncIter(events);
        },
        supportsStructuredResultTools: true
      });

      await runAdapterWithCapture(adapter, makeReviewerCapture('reviewer-result.json'), {
        allowedTools: ['Read', 'Glob', 'Grep'],
        scratchRoot: scratchDir
      });

      expect(launchCalls[0]!.allowedTools).toContain('submit_result');
      expect(launchCalls[0]!.allowedTools).toContain('Read');
      expect(launchCalls[0]!.allowedTools).not.toContain('Write');
      expect(launchCalls[0]!.allowedTools).not.toContain('Edit');

      const resultText = await readFile(path.join(scratchDir, 'reviewer-result.json'), 'utf8');
      expect(JSON.parse(resultText)).toEqual(submittedResult);
    } finally {
      await rm(scratchDir, { recursive: true });
    }
  });

  it('ignores result-event prose when submit_result provides a valid object', async () => {
    const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'test-claude-prose-'));
    try {
      const structuredResult = { status: 'satisfied', findings: [] };
      const events: ClaudeNativeEvent[] = [
        { type: 'tool_use', tool: { name: 'submit_result', input: structuredResult } },
        { type: 'result', result: { is_error: false, output: 'Here is my prose summary of the review...' } }
      ];

      await runAdapterWithCapture(
        createClaudeAgentAdapter({ launchClaudeSession: () => asyncIter(events), supportsStructuredResultTools: true }),
        makeReviewerCapture(),
        { scratchRoot: scratchDir }
      );

      const resultText = await readFile(path.join(scratchDir, 'step-result.json'), 'utf8');
      expect(JSON.parse(resultText)).toEqual(structuredResult);
      expect(resultText).not.toContain('prose summary');
    } finally {
      await rm(scratchDir, { recursive: true });
    }
  });

  it('throws structured_result_unsupported when supportsStructuredResultTools is not set', async () => {
    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: () => asyncIter([])
      // supportsStructuredResultTools NOT set
    });

    await expect(runAdapterWithCapture(adapter, makeReviewerCapture())).rejects.toThrow(UnsupportedProviderCapabilityError);
  });

  it('throws missing_structured_result when session ends without submit_result call', async () => {
    const events: ClaudeNativeEvent[] = [
      { type: 'result', result: { is_error: false, output: 'Done.' } }
    ];

    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: () => asyncIter(events),
      supportsStructuredResultTools: true
    });

    await expect(runAdapterWithCapture(adapter, makeReviewerCapture())).rejects.toThrow(ProviderProtocolError);

    let err: ProviderProtocolError | undefined;
    try {
      await runAdapterWithCapture(adapter, makeReviewerCapture());
    } catch (e) {
      err = e as ProviderProtocolError;
    }
    expect(err?.code).toBe('missing_structured_result');
  });

  it('throws duplicate_structured_result on second submit_result call', async () => {
    const result = { status: 'satisfied', findings: [] };
    const events: ClaudeNativeEvent[] = [
      { type: 'tool_use', tool: { name: 'submit_result', input: result } },
      { type: 'tool_use', tool: { name: 'submit_result', input: result } },
      { type: 'result', result: { is_error: false } }
    ];

    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: () => asyncIter(events),
      supportsStructuredResultTools: true
    });

    let err: ProviderProtocolError | undefined;
    try {
      await runAdapterWithCapture(adapter, makeReviewerCapture());
    } catch (e) {
      err = e as ProviderProtocolError;
    }
    expect(err?.code).toBe('duplicate_structured_result');
  });

  it('no-contract sessions keep existing final-output behavior', async () => {
    const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'test-claude-legacy-'));
    try {
      const events: ClaudeNativeEvent[] = [
        { type: 'result', result: { is_error: false, output: '{"status":"ok"}' } }
      ];

      const adapter = createClaudeAgentAdapter({
        launchClaudeSession: () => asyncIter(events)
      });

      await runAdapterNoCapture(adapter, { scratchRoot: scratchDir });

      const resultText = await readFile(path.join(scratchDir, 'step-result.json'), 'utf8');
      expect(resultText).toContain('status');
    } finally {
      await rm(scratchDir, { recursive: true });
    }
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

// ---------------------------------------------------------------------------
// Read-only reviewer satisfied verdict regression (T-019)
//
// NOTE: The test 'allows submit_result in read-only reviewer sessions without
// granting write tools' above already proves this contract end-to-end. This
// explicit test documents the exact satisfied verdict path as a named regression
// anchor for the implementation.build reviewer contract.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured result error-path no-leak tests (T-020)
// ---------------------------------------------------------------------------

describe('createClaudeAgentAdapter — structured result error paths no-leak', () => {
  const SENTINEL_SECRET = 'sk-ant-sentinel-leak-secret';
  const SENTINEL_PROMPT = 'raw result text sentinel prompt content';
  const SENTINEL_PATH = '/Users/sentinel/private/path';
  const SENTINEL_AUTH = 'authorization: Bearer sentinel-token';
  const SENTINEL_JSON = '{"raw":"json body sentinel"}';

  function expectNoStructuredSentinels(captured: string): void {
    expect(captured).not.toContain(SENTINEL_SECRET);
    expect(captured).not.toContain(SENTINEL_PROMPT);
    expect(captured).not.toContain(SENTINEL_PATH);
    expect(captured).not.toContain(SENTINEL_AUTH);
    expect(captured).not.toContain(SENTINEL_JSON);
  }

  it('does not leak sentinels in logger output when missing_structured_result fires', async () => {
    const logs: unknown[] = [];
    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: () => asyncIter([
        { type: 'result', result: { is_error: false, output: SENTINEL_PROMPT } }
      ]),
      supportsStructuredResultTools: true,
      logger: {
        info: (_e, f) => logs.push(f),
        warn: (_e, f) => logs.push(f),
        error: (_e, f) => logs.push(f)
      }
    });

    await runAdapterWithCapture(adapter, makeReviewerCapture()).catch(() => undefined);

    const captured = JSON.stringify(logs);
    expectNoStructuredSentinels(captured);
    // Safe structured-result diagnostics must be present
    expect(captured).toContain('autocatalyst.reviewer_result.v1');
    expect(captured).toContain('claude_submit_result_tool');
  });

  it('does not leak sentinels in logger output when duplicate_structured_result fires', async () => {
    const logs: unknown[] = [];
    const result = { status: 'satisfied', findings: [] };
    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: () => asyncIter([
        { type: 'tool_use', tool: { name: 'submit_result', input: result } },
        { type: 'tool_use', tool: { name: 'submit_result', input: result } },
        { type: 'result', result: { is_error: false } }
      ]),
      supportsStructuredResultTools: true,
      logger: {
        info: (_e, f) => logs.push(f),
        warn: (_e, f) => logs.push(f),
        error: (_e, f) => logs.push(f)
      }
    });

    await runAdapterWithCapture(adapter, makeReviewerCapture()).catch(() => undefined);

    const captured = JSON.stringify(logs);
    expectNoStructuredSentinels(captured);
    // Safe structured-result diagnostics must be present
    expect(captured).toContain('autocatalyst.reviewer_result.v1');
    expect(captured).toContain('claude_submit_result_tool');
  });

  it('does not leak sentinels in logger output when SDK auth error fires during structured capture', async () => {
    const logs: unknown[] = [];
    const leakyError = Object.assign(
      new Error(`${SENTINEL_SECRET} ${SENTINEL_PATH} ${SENTINEL_AUTH} ${SENTINEL_JSON}`),
      // code uses 'authentication_error' (allowlisted) — the secret is in the error message only
      { code: 'authentication_error', status: 401, name: 'AuthenticationError' }
    );

    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: async function* () { yield await Promise.reject<ClaudeNativeEvent>(leakyError); },
      supportsStructuredResultTools: true,
      logger: {
        info: (_e, f) => logs.push(f),
        warn: (_e, f) => logs.push(f),
        error: (_e, f) => logs.push(f)
      }
    });

    await runAdapterWithCapture(adapter, makeReviewerCapture()).catch(() => undefined);

    const captured = JSON.stringify(logs);
    expectNoStructuredSentinels(captured);
  });

  it('does not log raw result-event prose in info/warn/error calls', async () => {
    const logs: unknown[] = [];
    const proseOutput = SENTINEL_PROMPT;
    const adapter = createClaudeAgentAdapter({
      launchClaudeSession: () => asyncIter([
        { type: 'result', result: { is_error: false, output: proseOutput } }
      ]),
      supportsStructuredResultTools: true,
      logger: {
        info: (_e, f) => logs.push(f),
        warn: (_e, f) => logs.push(f),
        error: (_e, f) => logs.push(f)
      }
    });

    await runAdapterWithCapture(adapter, makeReviewerCapture()).catch(() => undefined);

    const captured = JSON.stringify(logs);
    expect(captured).not.toContain(proseOutput);
  });
});

describe('createClaudeAgentAdapter — read-only reviewer satisfied verdict regression', () => {
  it('read-only reviewer can submit satisfied verdict via submit_result', async () => {
    const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'test-reviewer-verdict-'));
    try {
      const verdict = { status: 'satisfied' as const, findings: [] };
      const events: ClaudeNativeEvent[] = [
        { type: 'tool_use', tool: { name: 'submit_result', input: verdict } },
        { type: 'result', result: { is_error: false } }
      ];

      const adapter = createClaudeAgentAdapter({
        launchClaudeSession: () => asyncIter(events),
        supportsStructuredResultTools: true
      });

      // Read-only tools (no Write, no Edit) — submit_result is still available
      await runAdapterWithCapture(adapter, makeReviewerCapture('step-result.json'), {
        scratchRoot: scratchDir,
        allowedTools: ['Read', 'Glob', 'Grep']
      });

      const result = JSON.parse(await readFile(path.join(scratchDir, 'step-result.json'), 'utf8'));
      expect(result.status).toBe('satisfied');
      expect(result.findings).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true });
    }
  });
});
