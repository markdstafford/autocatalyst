import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { run as sdkRun, setTracingDisabled } from '@openai/agents';
import { skillRefsForRoute, OpenAIAgentSdkAgentRunner } from '../../../src/adapters/openai/agent-sdk-agent-runner.js';
import type { AgentRunEvent } from '../../../src/types/ai.js';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';

const nullDest = { write: () => {} } as import('pino').DestinationStream;

vi.mock('@openai/agents', async importOriginal => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    run: vi.fn(),
    setTracingDisabled: vi.fn(),
  };
});

vi.mock('@openai/agents/sandbox/local', () => ({
  UnixLocalSandboxClient: class {
    resume = vi.fn().mockResolvedValue({});
  },
}));

describe('skillRefsForRoute', () => {
  test('artifact.create / intent:idea → mm:planning', () => {
    expect(skillRefsForRoute({ task: 'artifact.create', intent: 'idea' }))
      .toEqual(['mm:planning']);
  });

  test('artifact.create / intent:bug → mm:issue-triage', () => {
    expect(skillRefsForRoute({ task: 'artifact.create', intent: 'bug' }))
      .toEqual(['mm:issue-triage']);
  });

  test('artifact.create / intent:chore → mm:issue-triage', () => {
    expect(skillRefsForRoute({ task: 'artifact.create', intent: 'chore' }))
      .toEqual(['mm:issue-triage']);
  });

  test('issue.triage → mm:issue-triage', () => {
    expect(skillRefsForRoute({ task: 'issue.triage' }))
      .toEqual(['mm:issue-triage']);
  });

  test('implementation.run → writing-plans + subagent-driven-development', () => {
    expect(skillRefsForRoute({ task: 'implementation.run' }))
      .toEqual(['superpowers:writing-plans', 'superpowers:subagent-driven-development']);
  });

  test('question.answer → no skills', () => {
    expect(skillRefsForRoute({ task: 'question.answer' })).toEqual([]);
  });

  test('artifact.revise → no skills', () => {
    expect(skillRefsForRoute({ task: 'artifact.revise' })).toEqual([]);
  });

  test('intent.classify → no skills', () => {
    expect(skillRefsForRoute({ task: 'intent.classify' })).toEqual([]);
  });

  test('pr.title_generate → no skills', () => {
    expect(skillRefsForRoute({ task: 'pr.title_generate' })).toEqual([]);
  });

  test('artifact.create with no intent → no skills', () => {
    expect(skillRefsForRoute({ task: 'artifact.create' })).toEqual([]);
  });
});

async function collect(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const collected: AgentRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function makeMockMeter() {
  const counterAdds: { name: string; value: number; attrs: Record<string, string> }[] = [];
  const histogramRecords: { name: string; value: number; attrs: Record<string, string> }[] = [];

  function makeCounter(name: string): Counter {
    return {
      add(value: number, attrs?: Record<string, string>) {
        counterAdds.push({ name, value, attrs: attrs ?? {} });
      },
    } as unknown as Counter;
  }

  function makeHistogram(name: string): Histogram {
    return {
      record(value: number, attrs?: Record<string, string>) {
        histogramRecords.push({ name, value, attrs: attrs ?? {} });
      },
    } as unknown as Histogram;
  }

  const meter: Meter = {
    createCounter: (name: string) => makeCounter(name),
    createHistogram: (name: string) => makeHistogram(name),
    createObservableCounter: vi.fn(),
    createObservableGauge: vi.fn(),
    createObservableUpDownCounter: vi.fn(),
    createUpDownCounter: vi.fn(),
    createGauge: vi.fn(),
    addBatchObservableCallback: vi.fn(),
    removeBatchObservableCallback: vi.fn(),
  } as unknown as Meter;

  return { meter, counterAdds, histogramRecords };
}

function makeLogCapture(): { dest: import('pino').DestinationStream; getLogs: () => Record<string, unknown>[] } {
  const stream = new PassThrough();
  const logs: Record<string, unknown>[] = [];
  stream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        try { logs.push(JSON.parse(trimmed)); } catch { /* skip non-JSON */ }
      }
    }
  });
  return { dest: stream as unknown as import('pino').DestinationStream, getLogs: () => logs };
}

// The @openai/agents SDK run() function yields RunStreamEvent objects.
// For text output: type === "run_item_stream_event", name === "message_output_created",
// item.rawItem.content has entries with type === "output_text" and text field.
// The RunFn in OpenAIAgentSdkAgentRunner is typed as:
//   (agent: unknown, prompt: string, workingDirectory: string, options: { maxTurns: number }) => AsyncIterable<unknown>
// So our mock just needs to yield events in the right shape.
function makeRunFnYieldingText(text: string) {
  return vi.fn().mockImplementation(async function* () {
    yield {
      type: 'run_item_stream_event',
      name: 'message_output_created',
      item: {
        type: 'message_output_item',
        rawItem: {
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      },
    };
  });
}

describe('OpenAIAgentSdkAgentRunner', () => {
  beforeEach(() => {
    vi.mocked(sdkRun).mockReset();
    vi.mocked(setTracingDisabled).mockReset();
  });

  test('run() calls materializeSkills with skill refs matching the route', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/ws',
      prompt: 'implement feature X',
    }));

    expect(materializeSkills).toHaveBeenCalledWith(
      ['superpowers:writing-plans', 'superpowers:subagent-driven-development'],
    );
  });

  test('run() yields { type: assistant, content } for text output events', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = makeRunFnYieldingText('hello from GPT');

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      logDestination: nullDest,
    });

    const events = await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'What is 1+1?',
    }));

    expect(events).toContainEqual({
      type: 'assistant',
      content: [{ type: 'text', text: 'hello from GPT' }],
    });
  });

  test('default run function converts non-streaming result.newItems into assistant events', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    vi.mocked(sdkRun).mockResolvedValue({
      newItems: [
        {
          type: 'message_output_item',
          rawItem: {
            role: 'assistant',
            content: [{ type: 'output_text', text: 'non-streaming result' }],
          },
        },
      ],
      output: [],
    } as never);

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      materializeSkills,
      logDestination: nullDest,
    });

    const events = await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'What changed?',
    }));

    expect(events).toContainEqual({
      type: 'assistant',
      content: [{ type: 'text', text: 'non-streaming result' }],
    });
  });

  test('default run function passes a larger turn budget to the OpenAI SDK', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    vi.mocked(sdkRun).mockResolvedValue({
      newItems: [],
      output: [],
    } as never);

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      materializeSkills,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'artifact.create', intent: 'bug' },
      working_directory: '/tmp/ws',
      prompt: 'triage issue',
    }));

    expect(vi.mocked(sdkRun).mock.calls[0][2]).toMatchObject({
      maxTurns: 50,
    });
  });

  test('run() logs each SDK tool call and tool response with sanitized metadata', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const { dest, getLogs } = makeLogCapture();
    const runFn = vi.fn().mockImplementation(async function* () {
      yield {
        type: 'run_item_stream_event',
        name: 'tool_called',
        item: {
          type: 'tool_call_item',
          rawItem: {
            type: 'shell_call',
            callId: 'call-shell-1',
            status: 'completed',
            action: { commands: ['cat secret.txt'] },
          },
        },
      };
      yield {
        type: 'run_item_stream_event',
        name: 'tool_output',
        item: {
          type: 'tool_call_output_item',
          rawItem: {
            type: 'shell_call_output',
            callId: 'call-shell-1',
            output: [
              {
                stdout: 'sensitive output',
                stderr: '',
                outcome: { type: 'exit', exitCode: 0 },
              },
            ],
          },
        },
      };
    });

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      logDestination: dest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'inspect files',
    }));

    const toolCallLog = getLogs().find(log => log['event'] === 'agent.sdk_item' && log['sdk_event_name'] === 'tool_called');
    expect(toolCallLog).toMatchObject({
      component: 'openai-agent-sdk',
      model: 'gpt-4o',
      route_task: 'question.answer',
      sdk_event_type: 'run_item_stream_event',
      sdk_event_name: 'tool_called',
      item_type: 'tool_call_item',
      raw_item_type: 'shell_call',
      tool_name: 'shell',
      call_id: 'call-shell-1',
      tool_status: 'completed',
      command_count: 1,
    });
    expect(toolCallLog).not.toHaveProperty('commands');

    const toolOutputLog = getLogs().find(log => log['event'] === 'agent.sdk_item' && log['sdk_event_name'] === 'tool_output');
    expect(toolOutputLog).toMatchObject({
      sdk_event_name: 'tool_output',
      item_type: 'tool_call_output_item',
      raw_item_type: 'shell_call_output',
      tool_name: 'shell',
      call_id: 'call-shell-1',
      output_count: 1,
      exit_codes: [0],
    });
    expect(toolOutputLog).not.toHaveProperty('stdout');
    expect(toolOutputLog).not.toHaveProperty('stderr');
  });

  test('run() creates a sandbox agent with filesystem and shell capabilities even when the route has no skills', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    let capturedAgent: unknown;
    const runFn = vi.fn().mockImplementation(async function* (agent: unknown) {
      capturedAgent = agent;
    });

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'answer from repo',
    }));

    const capabilities = (capturedAgent as { capabilities?: Array<{ type?: string }> }).capabilities;
    expect(capabilities?.map(c => c.type)).toEqual(expect.arrayContaining(['filesystem', 'shell', 'compaction']));
  });

  test('run() uses profile.model over defaultModel', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});
    const { meter, histogramRecords } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o-mini', {
      runFn,
      materializeSkills,
      meter,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
      profile: { id: 'prof', provider: 'openai', model: 'gpt-4-turbo' },
    }));

    const latencyRecord = histogramRecords.find(r => r.name === 'autocatalyst.adapter.latency');
    expect(latencyRecord?.attrs.model).toBe('gpt-4-turbo');
  });

  test('run() uses defaultModel when profile.model is absent', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});
    const { meter, histogramRecords } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o-mini', {
      runFn,
      materializeSkills,
      meter,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }));

    const latencyRecord = histogramRecords.find(r => r.name === 'autocatalyst.adapter.latency');
    expect(latencyRecord?.attrs.model).toBe('gpt-4o-mini');
  });

  test('run() falls back to gpt-4o when no model is provided anywhere', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});
    const { meter, histogramRecords } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, undefined, {
      runFn,
      materializeSkills,
      meter,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }));

    const latencyRecord = histogramRecords.find(r => r.name === 'autocatalyst.adapter.latency');
    expect(latencyRecord?.attrs.model).toBe('gpt-4o');
  });

  test('turns counter increments once per assistant event', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {
      yield {
        type: 'run_item_stream_event',
        name: 'message_output_created',
        item: { type: 'message_output_item', rawItem: { role: 'assistant', content: [{ type: 'output_text', text: 'turn 1' }] } },
      };
      yield {
        type: 'run_item_stream_event',
        name: 'message_output_created',
        item: { type: 'message_output_item', rawItem: { role: 'assistant', content: [{ type: 'output_text', text: 'turn 2' }] } },
      };
    });
    const { meter, counterAdds } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      meter,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }));

    const turnAdds = counterAdds.filter(c => c.name === 'autocatalyst.agent.turns');
    expect(turnAdds).toHaveLength(2);
  });

  test('runs counter records outcome:success on clean exit', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});
    const { meter, counterAdds } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      meter,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }));

    const outcomeAdds = counterAdds.filter(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdds).toHaveLength(1);
    expect(outcomeAdds[0].attrs.outcome).toBe('success');
  });

  test('runs counter records outcome:error when runFn throws', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {
      throw new Error('API error');
    });
    const { meter, counterAdds } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      meter,
      logDestination: nullDest,
    });

    await expect(collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }))).rejects.toThrow('API error');

    const outcomeAdds = counterAdds.filter(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdds).toHaveLength(1);
    expect(outcomeAdds[0].attrs.outcome).toBe('error');
  });

  test('latency histogram records a value on clean exit', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});
    const { meter, histogramRecords } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
      meter,
      logDestination: nullDest,
    });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }));

    const latencyRecords = histogramRecords.filter(r => r.name === 'autocatalyst.adapter.latency');
    expect(latencyRecords).toHaveLength(1);
    expect(latencyRecords[0].value).toBeGreaterThanOrEqual(0);
  });

  test('api-key header is set when baseUrl is provided (runFn called with defined agent)', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    let capturedAgent: unknown;
    const runFn = vi.fn().mockImplementation(async function* (agent: unknown) {
      capturedAgent = agent;
    });

    const runner = new OpenAIAgentSdkAgentRunner(
      'grove-key-123',
      'https://grove.internal/openai',
      'gpt-4o',
      { runFn, materializeSkills, logDestination: nullDest },
    );

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }));

    expect(runFn).toHaveBeenCalled();
    expect(capturedAgent).toBeDefined();
  });

  test('constructor calls setTracingDisabled(true) to suppress SDK tracing log noise', () => {
    new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      logDestination: nullDest,
    });

    expect(vi.mocked(setTracingDisabled)).toHaveBeenCalledOnce();
    expect(vi.mocked(setTracingDisabled)).toHaveBeenCalledWith(true);
  });
});
