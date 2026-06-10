import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import type { AgentProviderAdapter } from '@autocatalyst/execution';
import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentProviderSessionInput,
  ProviderFetchTransport,
  ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import { UnsupportedProviderCapabilityError } from '@autocatalyst/execution';

import {
  createOpenAIAgentAdapter,
  openaiAgentAdapterId,
  openaiProviderKind,
  type OpenAIAgentsSdkFacade,
  type OpenAISandboxClientFactoryInput,
  type OpenAINativeEvent
} from './openai-agent-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) result.push(item);
  return result;
}

function assertAdapter(adapter: AgentProviderAdapter): AgentProviderAdapter {
  return adapter;
}

// ---------------------------------------------------------------------------
// Session startup helpers
// ---------------------------------------------------------------------------

const FAKE_SECRET = 'sk-openai-fake-secret';
const FAKE_PROMPT = 'sensitive prompt text';

function makeProfile(overrides: Partial<ResolvedAgentRunnerProfile> = {}): ResolvedAgentRunnerProfile {
  return {
    mode: 'agent',
    providerKind: 'openai',
    adapterId: 'openai-agents-sdk',
    profileName: 'openai-reviewer',
    model: { provider: 'openai', model: 'gpt-4.1' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'fetch_transport',
    ...overrides
  };
}

function makeTransport(): ProviderFetchTransport {
  return { fetch: vi.fn(async () => new Response('{}', { status: 200 })) };
}

function makeConnection(transport: ProviderFetchTransport): AgentConnection {
  return {
    profile: makeProfile(),
    credentialResolved: true,
    createFetchTransport: vi.fn(() => transport),
    createProcessLaunchConfig: vi.fn(() => { throw new Error('process launch not supported'); })
  };
}

function makeTelemetry(): AgentConnectionTelemetryContext {
  return { runId: 'run_1', phase: 'implementation', step: 'implementation.work', role: 'reviewer' };
}

function makeSessionInput(workspaceShape: 'none' | 'scratch_only' | 'two_roots' = 'none'): AgentProviderSessionInput {
  const workspace = workspaceShape === 'two_roots'
    ? { shape: 'two_roots' as const, repoRoot: '/tmp/ac/repo', scratchRoot: '/tmp/ac/scratch', branchName: 'feature/run', workspaceRoots: ['/tmp/ac/repo', '/tmp/ac/scratch'] }
    : workspaceShape === 'scratch_only'
      ? { shape: 'scratch_only' as const, scratchRoot: '/tmp/ac/scratch', workspaceRoots: ['/tmp/ac/scratch'] }
      : { shape: 'none' as const, workspaceRoots: [] };
  const transport = makeTransport();
  return {
    runInput: {
      environment: {
        context: {
          run: { id: 'run_1', workKind: 'feature', currentStep: 'implementation.work', tenant: 'tenant_1' },
          task: { prompt: FAKE_PROMPT, inputs: {} },
          workspaceIntent: { shape: 'none' },
          secretBindings: [],
          toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
          skills: { requested: ['progress'] },
          capabilityRequirements: { shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: true }, lsp: { requested: false } }
        },
        workspace,
        environment: { variables: { SAFE_ENV: 'value', OPENAI_API_KEY: FAKE_SECRET }, secretVariableNames: ['OPENAI_API_KEY'] },
        toolPolicy: { allowedTools: ['bash'], workspaceRoots: workspace.workspaceRoots },
        skills: { requested: ['progress'] },
        capabilities: { shell: { kind: 'bash', available: false }, paths: {}, lsp: { requested: false, available: false } }
      }
    },
    profile: makeProfile(),
    connection: makeConnection(transport),
    telemetryContext: makeTelemetry()
  };
}

function makeSdk(events: OpenAINativeEvent[] = []): { sdk: OpenAIAgentsSdkFacade; calls: Array<{ kind: string; options?: unknown; input?: unknown }> } {
  const calls: Array<{ kind: string; options?: unknown; input?: unknown }> = [];
  class NoopSnapshotSpec { readonly type = 'noop'; }
  class SandboxAgent {
    constructor(opts: Record<string, unknown>) { calls.push({ kind: 'constructor', options: opts }); }
    async *run(input: unknown, opts?: Record<string, unknown>): AsyncIterable<OpenAINativeEvent> {
      calls.push({ kind: 'run', input, options: opts });
      for (const event of events) yield event;
    }
  }
  return {
    calls,
    sdk: {
      SandboxAgent,
      NoopSnapshotSpec,
      isNoopSnapshotSpec: (value: unknown) => (value as { type?: unknown }).type === 'noop',
      createClientBinding: ({ transport }) => ({ kind: 'transport', value: transport })
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpenAIAgentAdapter — identity', () => {
  it('constructs an OpenAI fetch-transport agent adapter', () => {
    const adapter = assertAdapter(createOpenAIAgentAdapter({ sdk: {} }));
    expect(openaiProviderKind).toBe('openai');
    expect(openaiAgentAdapterId).toBe('openai-agents-sdk');
    expect(adapter.providerKind).toBe('openai');
    expect(adapter.adapterId).toBe('openai-agents-sdk');
    expect(adapter.supportedConnectionMechanism).toBe('fetch_transport');
  });
});

describe('package boundary', () => {
  it('does not import execution internals or the OpenAI direct adapter', async () => {
    const source = await readFile(new URL('./openai-agent-adapter.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@autocatalyst/execution/src/');
    expect(source).not.toContain('packages/execution/src/');
    expect(source).not.toContain('@autocatalyst/openai-direct-adapter');
    expect(source).not.toContain('openai-direct-adapter');
  });
});

describe('createOpenAIAgentAdapter — session startup safety', () => {
  it('fails safely when SandboxAgent is missing from the SDK facade', async () => {
    const adapter = createOpenAIAgentAdapter({ sdk: { NoopSnapshotSpec: class { readonly type = 'noop'; } } });
    await expect(adapter.startSession(makeSessionInput())).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });

  it('fails safely when NoopSnapshotSpec is missing from the SDK facade', async () => {
    const adapter = createOpenAIAgentAdapter({
      sdk: {
        SandboxAgent: class {
          run() { return (async function*(){})(); }
        } as never
      }
    });
    await expect(adapter.startSession(makeSessionInput())).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });

  it('fails when sandbox client factory returns non-local client', async () => {
    const { sdk } = makeSdk([]);
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async () => ({ kind: 'hosted' as never })
    });
    await expect(adapter.startSession(makeSessionInput())).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });

  it('passes per-session transport and noop snapshot to sandbox factory', async () => {
    const { sdk } = makeSdk([{ type: 'result' }]);
    const sandboxInputs: OpenAISandboxClientFactoryInput[] = [];
    const input = makeSessionInput('two_roots');
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async (factoryInput) => {
        sandboxInputs.push(factoryInput);
        return { kind: 'local' };
      }
    });
    const session = await adapter.startSession(input);
    await collectEvents(session.events);

    expect(input.connection.createFetchTransport).toHaveBeenCalledTimes(1);
    expect(sandboxInputs).toHaveLength(1);
    expect((sandboxInputs[0]!.snapshot as { type?: string }).type).toBe('noop');
    expect(sandboxInputs[0]!.workspace).toEqual({
      shape: 'two_roots',
      workspaceRoots: ['/tmp/ac/repo', '/tmp/ac/scratch'],
      repoRoot: '/tmp/ac/repo',
      scratchRoot: '/tmp/ac/scratch',
      resultRoot: '/tmp/ac/scratch'
    });
    expect(JSON.stringify(sandboxInputs)).not.toContain(FAKE_SECRET);
  });

  it('constructs SandboxAgent during session start', async () => {
    const { sdk, calls } = makeSdk([{ type: 'result' }]);
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async () => ({ kind: 'local' })
    });
    await collectEvents((await adapter.startSession(makeSessionInput('scratch_only'))).events);
    expect(calls.some((c) => c.kind === 'constructor')).toBe(true);
  });

  it('maps workspace correctly for scratch_only shape', async () => {
    const { sdk } = makeSdk([{ type: 'result' }]);
    const sandboxInputs: OpenAISandboxClientFactoryInput[] = [];
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async (fi) => { sandboxInputs.push(fi); return { kind: 'local' }; }
    });
    await collectEvents((await adapter.startSession(makeSessionInput('scratch_only'))).events);
    expect(sandboxInputs[0]!.workspace).toEqual({
      shape: 'scratch_only',
      workspaceRoots: ['/tmp/ac/scratch'],
      scratchRoot: '/tmp/ac/scratch',
      resultRoot: '/tmp/ac/scratch'
    });
  });

  it('maps workspace correctly for none shape', async () => {
    const { sdk } = makeSdk([{ type: 'result' }]);
    const sandboxInputs: OpenAISandboxClientFactoryInput[] = [];
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async (fi) => { sandboxInputs.push(fi); return { kind: 'local' }; }
    });
    await collectEvents((await adapter.startSession(makeSessionInput('none'))).events);
    expect(sandboxInputs[0]!.workspace).toEqual({ shape: 'none', workspaceRoots: [] });
  });

  it('passes progress tools to SandboxAgent', async () => {
    const { sdk, calls } = makeSdk([{ type: 'result' }]);
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async () => ({ kind: 'local' })
    });
    await collectEvents((await adapter.startSession(makeSessionInput('scratch_only'))).events);
    const constructorCall = calls.find((c) => c.kind === 'constructor');
    expect(constructorCall).toBeDefined();
    const tools = (constructorCall!.options as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain('update_plan');
    expect(tools.map((t) => t.name)).toContain('report_progress');
    expect(tools.map((t) => t.name)).toContain('notify');
  });

  it('records unsupported optional inference settings as degraded capabilities', async () => {
    const { sdk } = makeSdk([{ type: 'result' }]);
    const inputWithUnsupportedSettings = makeSessionInput('scratch_only');
    // Override the profile to include unsupported inference settings
    const modifiedInput = {
      ...inputWithUnsupportedSettings,
      profile: {
        ...inputWithUnsupportedSettings.profile,
        inferenceSettings: { temperature: 0.7, reasoningEffort: 'high', seed: 42 }
      }
    };
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async () => ({ kind: 'local' })
    });
    const session = await adapter.startSession(modifiedInput);
    await collectEvents(session.events);
    const metadata = await session.metadata;
    expect(metadata.degradedCapabilities.length).toBeGreaterThan(0);
    const capNames = metadata.degradedCapabilities.map((d) => d.capability);
    expect(capNames.some((c) => c.includes('reasoningEffort'))).toBe(true);
    expect(capNames.some((c) => c.includes('seed'))).toBe(true);
    // temperature IS supported, should not be degraded
    expect(capNames.some((c) => c.includes('temperature'))).toBe(false);
  });
});

describe('createOpenAIAgentAdapter — event mapping', () => {
  it('maps assistant, tool, progress, notification, and terminal events', async () => {
    const { sdk } = makeSdk([
      { type: 'assistant', content: 'Inspecting the code.' },
      { type: 'tool_call', name: 'bash' },
      { type: 'tool_result', name: 'bash' },
      { type: 'tool_call', name: 'notify', arguments: JSON.stringify({ message: 'review complete', importance: 'normal' }) },
      { type: 'result' }
    ]);
    const adapter = createOpenAIAgentAdapter({ sdk, sandboxClientFactory: async () => ({ kind: 'local' }) });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    const events = await collectEvents(session.events);
    expect(events.map((e) => e.type)).toEqual([
      'runner_assistant_turn',
      'runner_tool_activity',
      'runner_tool_activity',
      'runner_notification',
      'runner_terminal_result'
    ]);
  });

  it('maps update_plan to runner_progress plan', async () => {
    const { sdk } = makeSdk([
      { type: 'tool_call', name: 'update_plan', arguments: JSON.stringify({ title: 'Phase 1', steps: ['step a', 'step b'] }) },
      { type: 'result' }
    ]);
    const adapter = createOpenAIAgentAdapter({ sdk, sandboxClientFactory: async () => ({ kind: 'local' }) });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    const events = await collectEvents(session.events);
    const progressEvent = events.find((e) => e.type === 'runner_progress');
    expect(progressEvent).toBeDefined();
    if (progressEvent?.type === 'runner_progress') {
      expect(progressEvent.progress.kind).toBe('plan');
    }
  });

  it('maps report_progress with counts to runner_progress task_progress', async () => {
    const { sdk } = makeSdk([
      { type: 'tool_call', name: 'report_progress', arguments: JSON.stringify({ label: 'files', completed: 3, total: 10 }) },
      { type: 'result' }
    ]);
    const adapter = createOpenAIAgentAdapter({ sdk, sandboxClientFactory: async () => ({ kind: 'local' }) });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    const events = await collectEvents(session.events);
    const progressEvent = events.find((e) => e.type === 'runner_progress');
    expect(progressEvent).toBeDefined();
    if (progressEvent?.type === 'runner_progress') {
      expect(progressEvent.progress.kind).toBe('task_progress');
    }
  });

  it('emits exactly one terminal result', async () => {
    const { sdk } = makeSdk([
      { type: 'assistant', content: 'done' },
      { type: 'result' }
    ]);
    const adapter = createOpenAIAgentAdapter({ sdk, sandboxClientFactory: async () => ({ kind: 'local' }) });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    const events = await collectEvents(session.events);
    const terminals = events.filter((e) => e.type === 'runner_terminal_result');
    expect(terminals).toHaveLength(1);
  });

  it('throws when stream ends without terminal result', async () => {
    const { sdk } = makeSdk([
      { type: 'assistant', content: 'incomplete' }
    ]); // No result event
    const adapter = createOpenAIAgentAdapter({ sdk, sandboxClientFactory: async () => ({ kind: 'local' }) });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    // Suppress unhandled rejection on metadata — it will reject with the same error
    session.metadata.catch(() => undefined);
    await expect(collectEvents(session.events)).rejects.toMatchObject({ code: 'impossible_session_sequence' });
  });

  it('throws when events arrive after terminal result', async () => {
    const { sdk } = makeSdk([
      { type: 'result' },
      { type: 'assistant', content: 'after terminal' }
    ]);
    const adapter = createOpenAIAgentAdapter({ sdk, sandboxClientFactory: async () => ({ kind: 'local' }) });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    // Suppress unhandled rejection on metadata — it will reject with the same error
    session.metadata.catch(() => undefined);
    await expect(collectEvents(session.events)).rejects.toMatchObject({ code: 'impossible_session_sequence' });
  });

  it('throws on unknown native event type', async () => {
    const { sdk } = makeSdk([
      { type: 'unknown_exotic_type_xyz' }
    ]);
    const adapter = createOpenAIAgentAdapter({ sdk, sandboxClientFactory: async () => ({ kind: 'local' }) });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    // Suppress unhandled rejection on metadata — it will reject with the same error
    session.metadata.catch(() => undefined);
    await expect(collectEvents(session.events)).rejects.toMatchObject({ code: 'invalid_provider_event' });
  });
});

describe('createOpenAIAgentAdapter — observability', () => {
  it('does not expose secrets, prompts, or raw event content in logger output', async () => {
    const logs: unknown[] = [];
    const logger = {
      info: vi.fn((_event: string, fields: unknown) => { logs.push(fields); }),
      warn: vi.fn((_event: string, fields: unknown) => { logs.push(fields); }),
      error: vi.fn((_event: string, fields: unknown) => { logs.push(fields); })
    };
    const { sdk } = makeSdk([{ type: 'result' }]);
    const adapter = createOpenAIAgentAdapter({
      sdk,
      logger,
      sandboxClientFactory: async () => ({ kind: 'local' as const })
    });
    const session = await adapter.startSession(makeSessionInput('scratch_only'));
    await Array.fromAsync(session.events).catch(() => undefined);
    const captured = JSON.stringify(logs);
    expect(captured).not.toContain(FAKE_SECRET);
    expect(captured).not.toContain(FAKE_PROMPT);
    expect(logger.info).toHaveBeenCalledWith('openai_agent_session_start', expect.any(Object));
  });
});

describe('createOpenAIAgentAdapter — token usage', () => {
  it('extracts token usage from native result event with usage field', async () => {
    const { sdk } = makeSdk([
      { type: 'result', usage: { prompt_tokens: 100, completion_tokens: 50 } }
    ]);
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async () => ({ kind: 'local' as const })
    });
    const session = await adapter.startSession(makeSessionInput());
    await Array.fromAsync(session.events);
    const metadata = await session.metadata;
    expect(metadata.tokenUsage.available).toBe(true);
    if (metadata.tokenUsage.available) {
      expect(metadata.tokenUsage.tokens.input).toBe(100);
      expect(metadata.tokenUsage.tokens.output).toBe(50);
    }
  });
});

describe('createOpenAIAgentAdapter — unsupported behavior', () => {
  it('throws UnsupportedProviderCapabilityError when NoopSnapshotSpec validation fails', async () => {
    const sdk = {
      SandboxAgent: class { constructor(_opts: Record<string, unknown>) {} async *run(): AsyncIterable<OpenAINativeEvent> { yield { type: 'result' }; } } as never,
      NoopSnapshotSpec: class { readonly type = 'not-noop'; } as never,
      isNoopSnapshotSpec: (_v: unknown) => false,
      createClientBinding: ({ transport }: { transport: unknown }) => ({ kind: 'transport' as const, value: transport })
    };
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async () => ({ kind: 'local' as const })
    });
    await expect(adapter.startSession(makeSessionInput())).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });

  it('throws UnsupportedProviderCapabilityError when sandbox factory returns non-local client', async () => {
    const { sdk } = makeSdk([{ type: 'result' }]);
    const adapter = createOpenAIAgentAdapter({
      sdk,
      sandboxClientFactory: async () => ({ kind: 'remote' as unknown as 'local' })
    });
    await expect(adapter.startSession(makeSessionInput())).rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
  });
});
