import { describe, expect, it } from 'vitest';
import { runnerEventSchema, runnerTerminalDirectiveSchema } from './runner-events.js';

const base = {
  id: 'evt_1',
  runId: 'run_1',
  step: 'implement',
  importance: 'normal' as const,
  createdAt: '2026-06-09T00:00:00.000Z'
};

describe('runner event contract', () => {
  it('validates all runner event kinds', () => {
    const events = [
      { ...base, type: 'runner_assistant_turn', message: { role: 'assistant', content: 'Stub response.' } },
      { ...base, type: 'runner_tool_activity', tool: { name: 'bash', action: 'skipped', status: 'completed' } },
      { ...base, type: 'runner_progress', progress: { kind: 'plan', title: 'Stub plan', steps: ['Receive task'] } },
      { ...base, type: 'runner_progress', progress: { kind: 'task_progress', label: 'Receive task', completed: 1, total: 1 } },
      { ...base, type: 'runner_progress', progress: { kind: 'intent', summary: 'Preparing stub work', data: { safe: true } } },
      { ...base, type: 'runner_notification', notification: { severity: 'info', message: 'Stub notification.' } },
      { ...base, type: 'runner_step_checkpoint', checkpoint: { durable: true, name: 'stub_checkpoint', data: { step: 'implement' } } },
      { ...base, type: 'runner_terminal_result', result: { directive: 'advance' } }
    ];

    for (const event of events) {
      expect(runnerEventSchema.parse(event)).toEqual(event);
    }
  });

  it('rejects unsupported terminal directives and malformed event payloads', () => {
    expect(() => runnerTerminalDirectiveSchema.parse('revise')).toThrow();
    expect(() => runnerEventSchema.parse({ ...base, type: 'runner_progress', progress: { kind: 'task_progress', label: 'bad', completed: 2, total: 1 } })).toThrow();
    expect(() => runnerEventSchema.parse({ ...base, type: 'runner_step_checkpoint', checkpoint: { durable: false, name: 'bad', data: {} } })).toThrow();
    expect(() => runnerEventSchema.parse({ ...base, type: 'runner_terminal_result', result: { directive: 'fail', question: 'wrong field' } })).toThrow();
    expect(() => runnerEventSchema.parse({ ...base, type: 'unknown_event' })).toThrow();
  });
});
