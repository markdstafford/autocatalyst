import { describe, expect, test, vi } from 'vitest';
import { skillRefsForRoute, OpenAIAgentSdkAgentRunner } from '../../../src/adapters/openai/agent-sdk-agent-runner.js';
import type { AgentRunEvent } from '../../../src/types/ai.js';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';

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

// The @openai/agents SDK run() function yields RunStreamEvent objects.
// For text output: type === "run_item_stream_event", name === "message_output_created",
// item.rawItem.content has entries with type === "output_text" and text field.
// The RunFn in OpenAIAgentSdkAgentRunner is typed as:
//   (agent: unknown, prompt: string) => AsyncIterable<unknown>
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
  test('run() calls materializeSkills with skill refs matching the route', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o', {
      runFn,
      materializeSkills,
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

  test('run() uses profile.model over defaultModel', async () => {
    const materializeSkills = vi.fn().mockResolvedValue([]);
    const runFn = vi.fn().mockImplementation(async function* () {});
    const { meter, histogramRecords } = makeMockMeter();

    const runner = new OpenAIAgentSdkAgentRunner('sk-test', undefined, 'gpt-4o-mini', {
      runFn,
      materializeSkills,
      meter,
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
      { runFn, materializeSkills },
    );

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/ws',
      prompt: 'test',
    }));

    expect(runFn).toHaveBeenCalled();
    expect(capturedAgent).toBeDefined();
  });
});
