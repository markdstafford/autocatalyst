import { describe, expect, it } from 'vitest';

import {
  runEventsMediaType,
  runEventsPath,
  runEventsSuccessStatusCode,
  runStateTransitionEventName,
  runStateTransitionEventSchema,
  runStateTransitionKindSchema
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
        occurrence: { index: 0, attempt: 1 }
      },
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
        occurrence: { index: 1, attempt: 1 }
      },
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
        occurrence: { index: 0, attempt: 1 }
      },
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
        startedAt: now, endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 }
      },
      tenant: 'tenant_abc',
      createdAt: now,
      extra: 'field'
    };
    expect(() => runStateTransitionEventSchema.parse(validEvent)).toThrow();
  });
});
