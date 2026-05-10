import { describe, expect, test, vi } from 'vitest';
import { ClaudeAgentSdkAgentRunner } from '../../../src/adapters/anthropic/claude-agent-sdk-agent-runner.js';
import type { AgentRunEvent } from '../../../src/types/ai.js';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';

async function collect(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const collected: AgentRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** Build a stub Meter that records all metric calls for assertion. */
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

describe('ClaudeAgentSdkAgentRunner', () => {
  test('passes route profile values to Claude Agent SDK options with adaptive thinking', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    const events = await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        thinking: 'adaptive',
        setting_sources: ['project'],
      },
    }));

    expect(events).toEqual([{ type: 'assistant', content: [{ type: 'text', text: 'done' }] }]);
    expect(queryFn).toHaveBeenCalledWith({
      prompt: 'implement',
      options: expect.objectContaining({
        cwd: '/tmp/workspace',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        thinking: { type: 'adaptive' },
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: expect.arrayContaining(['Bash', 'Write', 'Read', 'Edit']),
        settings: expect.objectContaining({
          permissions: expect.objectContaining({
            defaultMode: 'bypassPermissions',
            allow: expect.arrayContaining(['Bash(*)', 'Write(*)', 'Read(*)', 'Edit(*)']),
            additionalDirectories: ['/tmp/workspace'],
          }),
        }),
      }),
    });
  });

  test('materializes required skills as explicit plugins without user settings', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const materializeRuntimeSkills = vi.fn().mockResolvedValue([{ type: 'local' as const, path: '/plugins/mm-runtime' }]);
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, materializeRuntimeSkills });

    await collect(runner.run({
      route: { task: 'artifact.create', stage: 'new_thread', intent: 'idea', artifact_kind: 'feature_spec' },
      working_directory: '/tmp/workspace',
      prompt: '/mm:planning',
      profile: {
        id: 'artifact',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        required_skills: ['mm:planning'],
      },
    }));

    expect(materializeRuntimeSkills).toHaveBeenCalledWith(['mm:planning']);
    expect(queryFn).toHaveBeenCalledWith({
      prompt: '/mm:planning',
      options: expect.objectContaining({
        settingSources: ['project'],
        plugins: [{ type: 'local', path: '/plugins/mm-runtime' }],
        thinking: { type: 'adaptive' },
        effort: 'high',
        settings: expect.objectContaining({
          permissions: expect.objectContaining({
            allow: expect.arrayContaining(['Bash(*)', 'Write(*)']),
          }),
        }),
      }),
    });
  });

  test('does not pass plugins or load user settings when no skills are required', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const materializeRuntimeSkills = vi.fn();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, materializeRuntimeSkills });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/workspace',
      prompt: 'answer',
      profile: {
        id: 'question',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'low',
        required_skills: [],
      },
    }));

    expect(materializeRuntimeSkills).not.toHaveBeenCalled();
    const call = queryFn.mock.calls[0][0];
    expect(call.options.settingSources).toEqual(['project']);
    expect(call.options).not.toHaveProperty('plugins');
  });

  test('includes model attribute in agent turn counter', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-3-5-sonnet-20241022',
        effort: 'high',
      },
    }));

    const turnAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.turns');
    expect(turnAdd).toBeDefined();
    expect(turnAdd!.attrs).toMatchObject({ component: 'claude-agent-sdk', model: 'claude-3-5-sonnet-20241022' });
  });

  test('records outcome:success counter when result message has is_error:false', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-3-5-sonnet-20241022', effort: 'high' },
    }));

    const outcomeAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdd).toBeDefined();
    expect(outcomeAdd!.value).toBe(1);
    expect(outcomeAdd!.attrs).toMatchObject({ component: 'claude-agent-sdk', model: 'claude-3-5-sonnet-20241022', outcome: 'success' });
  });

  test('records outcome:error counter when result message has is_error:true', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 7, output_tokens: 2 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-3-5-sonnet-20241022', effort: 'high' },
    }));

    const outcomeAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdd).toBeDefined();
    expect(outcomeAdd!.attrs).toMatchObject({ outcome: 'error' });
  });

  test('records token usage histogram twice (input and output) from result message', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 42, output_tokens: 17 } };
    });
    const { meter, histogramRecords } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', model: 'claude-3-5-sonnet-20241022', effort: 'high' },
    }));

    const tokenRecords = histogramRecords.filter(h => h.name === 'autocatalyst.agent.token_usage');
    expect(tokenRecords).toHaveLength(2);
    const inputRecord = tokenRecords.find(r => r.attrs['token_type'] === 'input');
    const outputRecord = tokenRecords.find(r => r.attrs['token_type'] === 'output');
    expect(inputRecord!.value).toBe(42);
    expect(outputRecord!.value).toBe(17);
  });

  test('uses model:"unknown" in metric attributes when profile has no model', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const { meter, counterAdds } = makeMockMeter();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, meter });

    await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: { id: 'impl', provider: 'claude_agent_sdk', effort: 'high' },
    }));

    const outcomeAdd = counterAdds.find(c => c.name === 'autocatalyst.agent.runs');
    expect(outcomeAdd).toBeDefined();
    expect(outcomeAdd!.attrs).toMatchObject({ model: 'unknown' });
  });
});
