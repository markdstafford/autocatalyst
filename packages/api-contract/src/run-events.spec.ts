import { describe, expect, it } from 'vitest';

import {
  clientRunEventSchema,
  formatRunEventFrameName,
  runEventFrameNameSchema,
  runEventReplayResultSchema,
  runEventsMediaType,
  runEventsPath,
  runEventsSuccessStatusCode,
  runStateTransitionEventName,
  runStateTransitionEventSchema,
  runStateTransitionKindSchema,
  runnerTerminalResultClientEventSchema
} from './run-events.js';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_abc' };

describe('run-events contract', () => {
  it('exports the run events path constant', () => {
    expect(runEventsPath).toBe('/v1/runs/:id/events');
  });

  it('exports the success status code constant', () => {
    expect(runEventsSuccessStatusCode).toBe(200);
  });

  it('exports the media type constant', () => {
    expect(runEventsMediaType).toBe('text/event-stream');
  });

  it('exports the event name constant', () => {
    expect(runStateTransitionEventName).toBe('run_state_transition');
  });

  it('validates known transition kinds', () => {
    const kinds = ['start', 'advance', 'revise', 'needs_input', 'cancel', 'fail'];
    for (const kind of kinds) {
      expect(runStateTransitionKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('rejects unknown transition kinds', () => {
    expect(() => runStateTransitionKindSchema.parse('unknown')).toThrow();
  });

  it('parses a valid run state transition event', () => {
    const now = new Date().toISOString();
    const validEvent = {
      id: 'evt_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: {
        directive: 'start',
        toStep: 'analyze'
      },
      run: {
        id: 'run_1',
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_abc',
        workKind: 'feature',
        currentStep: 'analyze',
        terminal: false,
        createdAt: now,
        updatedAt: now
      },
      runStep: {
        id: 'step_1',
        runId: 'run_1',
        phase: null,
        step: 'analyze',
        role: 'orchestrator',
        startedAt: now,
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }, checkpointResult: null },
      tenant: 'tenant_abc',
      createdAt: now
    };
    expect(runStateTransitionEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('allows fromStep to be omitted from transition', () => {
    const now = new Date().toISOString();
    const validEvent = {
      id: 'evt_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: {
        directive: 'advance',
        fromStep: 'analyze',
        toStep: 'implement'
      },
      run: {
        id: 'run_1',
        topicId: 'topic_1',
        owner,
        tenant: 'tenant_abc',
        workKind: 'feature',
        currentStep: 'implement',
        terminal: false,
        createdAt: now,
        updatedAt: now
      },
      runStep: {
        id: 'step_2',
        runId: 'run_1',
        phase: null,
        step: 'implement',
        role: 'orchestrator',
        startedAt: now,
        endedAt: null,
        durationMs: null,
        occurrence: { index: 1, attempt: 1 }, checkpointResult: null },
      tenant: 'tenant_abc',
      createdAt: now
    };
    expect(runStateTransitionEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('requires tenant to match run owner.tenantId', () => {
    const now = new Date().toISOString();
    const mismatchedEvent = {
      id: 'evt_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: {
        directive: 'start',
        toStep: 'analyze'
      },
      run: {
        id: 'run_1',
        topicId: 'topic_1',
        owner,
        tenant: 'wrong_tenant',  // mismatches owner.tenantId
        workKind: 'feature',
        currentStep: 'analyze',
        terminal: false,
        createdAt: now,
        updatedAt: now
      },
      runStep: {
        id: 'step_1',
        runId: 'run_1',
        phase: null,
        step: 'analyze',
        role: 'orchestrator',
        startedAt: now,
        endedAt: null,
        durationMs: null,
        occurrence: { index: 0, attempt: 1 }, checkpointResult: null },
      tenant: 'wrong_tenant',
      createdAt: now
    };
    expect(() => runStateTransitionEventSchema.parse(mismatchedEvent)).toThrow();
  });

  it('rejects extra fields (strict)', () => {
    const now = new Date().toISOString();
    const validEvent = {
      id: 'evt_1',
      type: 'run_state_transition' as const,
      runId: 'run_1',
      transition: { directive: 'start', toStep: 'analyze' },
      run: {
        id: 'run_1', topicId: 'topic_1', owner, tenant: 'tenant_abc',
        workKind: 'feature', currentStep: 'analyze', terminal: false, createdAt: now, updatedAt: now
      },
      runStep: {
        id: 'step_1', runId: 'run_1', phase: null, step: 'analyze', role: 'orchestrator',
        startedAt: now, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null },
      tenant: 'tenant_abc',
      createdAt: now,
      extra: 'field'
    };
    expect(() => runStateTransitionEventSchema.parse(validEvent)).toThrow();
  });
});

describe('clientRunEventSchema', () => {
  const now = new Date().toISOString();
  const baseRun = {
    id: 'run_1', topicId: 'topic_1', owner, tenant: 'tenant_abc',
    workKind: 'feature', currentStep: 'analyze', terminal: false, createdAt: now, updatedAt: now
  };
  const baseRunStep = {
    id: 'step_1', runId: 'run_1', phase: null, step: 'analyze', role: 'orchestrator',
    startedAt: now, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }, checkpointResult: null
  };

  it('accepts a run state transition variant', () => {
    const event = {
      id: 'evt_1', type: 'run_state_transition' as const, runId: 'run_1',
      transition: { directive: 'start', toStep: 'analyze' },
      run: baseRun, runStep: baseRunStep, tenant: 'tenant_abc', createdAt: now
    };
    expect(clientRunEventSchema.parse(event)).toEqual(event);
  });

  it('accepts a runner_progress variant', () => {
    const event = {
      id: 'evt_2', type: 'runner_progress' as const, runId: 'run_1', step: 'analyze',
      importance: 'normal' as const, createdAt: now,
      progress: { kind: 'task_progress', label: 'Tests', completed: 1, total: 3 }
    };
    expect(clientRunEventSchema.parse(event)).toEqual(event);
  });

  it('accepts a runner_terminal_result client variant carrying validated structured result', () => {
    const event = {
      id: 'evt_3', type: 'runner_terminal_result' as const, runId: 'run_1', step: 'analyze',
      importance: 'high' as const, createdAt: now,
      result: { directive: 'advance' as const, result: { value: 1 } }
    };
    expect(clientRunEventSchema.parse(event)).toEqual(event);
  });

  it('rejects unknown event types', () => {
    expect(() => clientRunEventSchema.parse({ type: 'unknown' })).toThrow();
  });
});

describe('formatRunEventFrameName', () => {
  it('returns the type as a frame name for valid event types', () => {
    expect(formatRunEventFrameName({ type: 'run_state_transition' })).toBe('run_state_transition');
    expect(formatRunEventFrameName({ type: 'runner_progress' })).toBe('runner_progress');
    expect(formatRunEventFrameName({ type: 'runner_terminal_result' })).toBe('runner_terminal_result');
  });

  it('enumerates all known frame names', () => {
    expect(runEventFrameNameSchema.options).toEqual([
      'run_state_transition', 'runner_assistant_turn', 'runner_tool_activity',
      'runner_progress', 'runner_notification', 'runner_step_checkpoint', 'runner_terminal_result'
    ]);
  });
});

describe('runEventReplayResultSchema', () => {
  it('accepts ok with events', () => {
    const result = { status: 'ok' as const, events: [] };
    expect(runEventReplayResultSchema.parse(result)).toEqual(result);
  });

  it('accepts unknown_event_id with lastEventId', () => {
    const result = { status: 'unknown_event_id' as const, lastEventId: 'evt_x' };
    expect(runEventReplayResultSchema.parse(result)).toEqual(result);
  });

  it('accepts expired_event_id with lastEventId', () => {
    const result = { status: 'expired_event_id' as const, lastEventId: 'evt_y' };
    expect(runEventReplayResultSchema.parse(result)).toEqual(result);
  });

  it('rejects unknown status', () => {
    expect(() => runEventReplayResultSchema.parse({ status: 'other', lastEventId: 'x' })).toThrow();
  });
});

describe('runnerTerminalResultClientEventSchema', () => {
  const now = new Date().toISOString();

  it('accepts a terminal client event with optional resultContract', () => {
    const event = {
      id: 'evt_1', type: 'runner_terminal_result' as const, runId: 'run_1', step: 'analyze',
      importance: 'normal' as const, createdAt: now,
      result: { directive: 'advance' as const, result: { ok: true } },
      resultContract: { step: 'analyze', schemaId: 'analyze.v1' }
    };
    expect(runnerTerminalResultClientEventSchema.parse(event)).toEqual(event);
  });

  it('rejects extra fields (strict)', () => {
    expect(() => runnerTerminalResultClientEventSchema.parse({
      id: 'evt_1', type: 'runner_terminal_result', runId: 'run_1', step: 'analyze',
      importance: 'normal', createdAt: now,
      result: { directive: 'advance' },
      rawOutput: 'leak'
    })).toThrow();
  });
});
