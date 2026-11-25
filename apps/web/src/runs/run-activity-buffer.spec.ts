import { clientRunEventSchema, type ClientRunEvent, type RunRecoveryEvent } from '@autocatalyst/api-contract';
import { describe, expect, it } from 'vitest';
import { assistant, at, attempt } from './run-activity.test-helper.js';
import { RUN_ACTIVITY_EVENTS_PER_RUN, RunActivityBuffer } from './run-activity-buffer.js';
import { activityEventText, formatActivityEvent } from './run-activity-event-text.js';
import { makeRun, makeTransitionEvent } from './run-fixtures.js';

describe('retained Activity events', () => {
  it('places frames by event time once attempts load, with a closed-attempt fallback and dedupe', () => {
    const buffer = new RunActivityBuffer();
    const first = attempt('write', 0, 0, 2);
    const second = attempt('write', 1, 5, null, 2);
    buffer.add(assistant('prior visit', 1), []);
    buffer.add(assistant('in between', 4), []);
    expect(buffer.forAttempt(first.id)).toEqual([]);
    buffer.reconcile([first, second]);
    buffer.add(assistant('current visit', 6), [first, second]);
    expect(buffer.add(assistant('prior visit', 1), [first, second])).toBe(false);
    expect(buffer.forAttempt(first.id).map(line => line.text)).toEqual(['prior visit', 'in between']);
    expect(buffer.forAttempt(second.id).map(line => line.text)).toEqual(['current visit']);
  });

  it('uses stream-position hints at equal times, then pins to the durable attempt ID', () => {
    const buffer = new RunActivityBuffer();
    const prior = attempt('write', 0, 0, 2);
    const current = attempt('write', 1, 2, null, 2);
    const currentRun = { ...makeRun(), currentStep: 'write' };
    buffer.add(assistant('before', 2), []);
    buffer.add({ ...makeTransitionEvent({ run: currentRun }), runStep: current }, []);
    buffer.reconcile([prior]);
    buffer.add(assistant('after', 2), [prior]);
    expect(buffer.forAttempt(prior.id)).toEqual([{ id: 'before', time: Date.parse(at(2)), text: 'before',
      createdAt: at(2), order: 1, step: 'write', attemptId: prior.id }]);
    expect(buffer.forAttempt(current.id)).toEqual([]);
    buffer.reconcile([prior, current]);
    buffer.add(assistant('original pinned', 1), [prior, current]);
    buffer.reconcile([prior, current, attempt('write', 2, 2, null, 3)]);
    expect(buffer.forAttempt(current.id).map(line => line.id)).toEqual(['after']);
    expect(buffer.forAttempt(prior.id).map(line => line.id)).toEqual(['original pinned', 'before']);

    const noHints = new RunActivityBuffer();
    noHints.add(assistant('tie', 2), [prior, current]);
    expect(noHints.forAttempt(current.id).map(line => line.id)).toEqual(['tie']);
  });

  it('pins recovery to its exact occurrence rather than matching its timestamp', () => {
    const first = attempt('write', 0, 0, 1);
    const later = attempt('write', 1, 2, null);
    const run = makeRun();
    const recovery: RunRecoveryEvent = { id: 'recover', type: 'run_recovery', runId: run.id, run,
      runStep: first, tenant: run.tenant, createdAt: at(2),
      recovery: { reDispatchStep: 'write', mode: 'resume', baseKind: 'run_branch', provisioningOutcome: 'present' } };
    const buffer = new RunActivityBuffer();
    buffer.add(recovery, []);
    buffer.reconcile([first, later]);
    expect(buffer.forAttempt(first.id).map(line => line.text)).toEqual(['Recovery: Resume']);
    expect(buffer.forAttempt(later.id)).toEqual([]);
  });

  it('keeps the newest 500 in stable time/ID order and tracks only affected attempts', () => {
    const buffer = new RunActivityBuffer();
    const first = attempt('write', 0, 0, 3);
    const second = attempt('write', 1, 5, null);
    buffer.add(assistant('old', 1), []);
    for (let index = RUN_ACTIVITY_EVENTS_PER_RUN - 1; index >= 0; index -= 1) {
      buffer.add(assistant(String(index).padStart(4, '0'), 6), []);
    }
    buffer.reconcile([first, second]);
    expect(buffer.forAttempt(second.id)).toHaveLength(500);
    expect(buffer.forAttempt(second.id).at(0)?.id).toBe('0000');
    expect(buffer.forAttempt(first.id)).toHaveLength(0);
    expect(buffer.lostEarlierEvents(first.id)).toBe(true);
    expect(buffer.lostEarlierEvents(second.id)).toBe(false);
    expect(buffer.add(assistant('old', 1), [first, second])).toBe(false);
    expect(buffer.add(assistant('even older', 0), [first, second])).toBe(false);
  });
});

it('formats all validated event types and only the allowed fields', () => {
  expect(Object.keys(activityEventText).sort()).toEqual([...clientRunEventSchema.optionsMap.keys()].sort());
  const base = { id: 'wire', runId: 'run-1', step: 'write', importance: 'normal', createdAt: at(1) } as const;
  const cases: [ClientRunEvent, string | null][] = [
    [makeTransitionEvent(), null],
    [assistant('assistant', 1, 'write', 'First line\nSecond line'), 'First line'],
    [{ ...base, type: 'runner_tool_activity', tool: { name: 'Read', action: 'invoke', status: 'started' } }, 'Read · invoke · started'],
    [{ ...base, type: 'runner_progress', progress: { kind: 'plan', title: 'A plan', steps: ['private'] } }, 'A plan'],
    [{ ...base, type: 'runner_progress', progress: { kind: 'task_progress', label: 'Work', completed: 2, total: 5 } }, 'Work 2 of 5'],
    [{ ...base, type: 'runner_progress', progress: { kind: 'intent', summary: 'Intent', data: { private: true } } }, 'Intent'],
    [{ ...base, type: 'runner_notification', notification: { severity: 'warn', message: 'Attention' } }, 'warn: Attention'],
    [{ ...base, type: 'runner_step_checkpoint', checkpoint: { durable: true, name: 'Saved', data: { private: true } } }, 'Saved'],
    [{ ...base, type: 'runner_terminal_result', result: { directive: 'needs_input', question: 'Which?', result: { private: true } } }, 'needs_input: Which?'],
    [{ ...base, type: 'runner_terminal_result', result: { directive: 'fail', reason: 'Stopped' } }, 'fail: Stopped'],
    [{ ...base, type: 'runner_terminal_result', result: { directive: 'advance', result: { private: true } } }, 'advance']
  ];
  for (const [event, text] of cases) {
    expect(formatActivityEvent(clientRunEventSchema.parse(event))).toBe(text);
  }
});
