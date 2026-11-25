import type { ClientRunEvent, RunStep, RunWorkflowResponse } from '@autocatalyst/api-contract';

export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1_000).toISOString();
}

export function attempt(step: string, index: number, start: number, end: number | null, visit = 1): RunStep {
  return {
    id: 'attempt-' + index, runId: 'run-1', step, phase: null, role: 'implementer',
    occurrence: { index, attempt: visit }, startedAt: at(start), endedAt: end === null ? null : at(end),
    durationMs: end === null ? null : (end - start) * 1_000, checkpointResult: null
  };
}

export function assistant(id: string, time: number, step = 'write', content = id): ClientRunEvent {
  return {
    id, type: 'runner_assistant_turn', runId: 'run-1', step, message: { role: 'assistant', content },
    importance: 'normal', createdAt: at(time)
  };
}

export function workflow(): RunWorkflowResponse {
  return {
    workflowId: 'made-up', workKind: 'feature', transitions: [],
    phases: [
      { id: 'early', label: 'Prepare', steps: ['draft', 'write', 'look', 'pause'] },
      { id: 'late', label: 'Ship', steps: ['assemble', 'sign'] }
    ],
    steps: [
      { id: 'open', kind: 'work', phase: null, waitingOn: 'system', onPath: true, roles: [] },
      { id: 'draft', kind: 'work', phase: 'early', waitingOn: 'ai', onPath: true, roles: [] },
      { id: 'write', kind: 'work', phase: 'early', waitingOn: 'ai', onPath: true, roles: [] },
      { id: 'look', kind: 'gate', phase: 'early', waitingOn: 'human', onPath: true, roles: [] },
      { id: 'assemble', kind: 'work', phase: 'late', waitingOn: 'ai', onPath: true, roles: [] },
      { id: 'sign', kind: 'gate', phase: 'late', waitingOn: 'human', onPath: true, roles: [] },
      { id: 'finish', kind: 'terminal', phase: null, waitingOn: 'none', onPath: true, roles: [] },
      { id: 'pause', kind: 'pause', phase: 'early', waitingOn: 'human', onPath: false, roles: [] },
      { id: 'error-stop', kind: 'terminal', phase: null, waitingOn: 'none', onPath: false, roles: [] },
      { id: 'abort-stop', kind: 'terminal', phase: null, waitingOn: 'none', onPath: false, roles: [] }
    ]
  };
}
