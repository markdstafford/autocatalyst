import type { Run, RunStep, RunWorkflowResponse, Session } from '@autocatalyst/api-contract';
import { terminalRunStatus } from './run-state.js';

export function orderAttempts(steps: readonly RunStep[]): RunStep[] {
  return [...steps].sort((a, b) => a.occurrence.index - b.occurrence.index);
}

export function currentTerminal(run: Run, ordered: readonly RunStep[]): RunStep | undefined {
  const latest = ordered.at(-1);
  return terminalRunStatus(run) !== undefined && latest?.step === run.currentStep ? latest : undefined;
}

export type ActivityState =
  | 'done' | 'failed' | 'canceled' | 'waiting' | 'running'
  | 'skipped' | 'unreached' | 'ended' | 'historical-stop' | 'refreshing';

export interface ActivityRow {
  readonly key: string;
  readonly step: string;
  readonly phase: string | null;
  readonly state: ActivityState;
  readonly attempt?: RunStep;
  readonly disclose?: boolean;
}

export function projectActivity(run: Run, steps: readonly RunStep[] | undefined, workflow?: RunWorkflowResponse): {
  rows: ActivityRow[];
  current: RunStep | undefined;
  mismatch: boolean;
} {
  if (steps === undefined) return { rows: [], current: undefined, mismatch: false };
  const history = orderAttempts(steps);
  const metadata = new Map(workflow?.steps.map(step => [step.id, step]));
  const path = workflow?.steps.filter(step => step.onPath && step.kind !== 'terminal') ?? [];
  const positions = new Map(path.map((step, index) => [step.id, index]));
  const end = workflow?.steps.find(step => step.onPath && step.kind === 'terminal');
  const visited = new Set(history.map(attempt => attempt.step));
  const finishedPath = end !== undefined && visited.has(end.id);
  const terminalStatus = terminalRunStatus(run);
  const terminal = currentTerminal(run, history);
  const active = !run.terminal && terminalStatus === undefined;
  const latest = history.at(-1);
  const current = active && latest?.step === run.currentStep &&
    latest.endedAt === null && metadata.get(latest.step)?.kind !== 'terminal' ? latest : undefined;
  const waitingOn = run.waitingOn ?? (current && metadata.get(current.step)?.waitingOn);

  const rows: ActivityRow[] = [];
  let cursor = 0;
  const appendUntil = (limit: number, state: 'skipped' | 'unreached'): void => {
    for (; cursor < limit; cursor += 1) {
      const step = path[cursor];
      if (step && !visited.has(step.id)) {
        rows.push({ key: 'path:' + step.id, step: step.id, phase: step.phase, state });
      }
    }
  };
  const addAttempt = (attempt: RunStep, state: ActivityState, disclose: boolean): void => {
    rows.push({
      key: 'attempt:' + attempt.id, step: attempt.step,
      phase: metadata.get(attempt.step)?.phase ?? null, state, attempt, disclose
    });
  };

  for (const [index, attempt] of history.entries()) {
    const projected = metadata.get(attempt.step);
    if (attempt === terminal) continue;
    if (projected?.kind === 'terminal') {
      addAttempt(attempt, 'historical-stop', false);
      continue;
    }
    const position = positions.get(attempt.step);
    if (position !== undefined && position >= cursor) {
      appendUntil(position, 'skipped');
      cursor = position + 1;
    }

    const next = history[index + 1];
    let state: ActivityState;
    if (attempt === current && waitingOn === 'human') state = 'waiting';
    else if (attempt === current && (waitingOn === 'ai' || waitingOn === 'system')) state = 'running';
    else if (next !== undefined && next === terminal && (terminalStatus === 'failed' || terminalStatus === 'canceled')) {
      state = terminalStatus;
    } else if (next !== undefined && next !== terminal && metadata.get(next.step)?.kind === 'terminal' &&
      metadata.get(next.step)?.onPath === false) {
      state = 'ended';
    } else state = attempt.endedAt === null ? 'refreshing' : 'done';
    addAttempt(attempt, state, true);
  }

  appendUntil(path.length, finishedPath ? 'skipped' : 'unreached');
  if (terminal && terminalStatus) addAttempt(terminal, terminalStatus, false);
  else if (active && end !== undefined) {
    rows.push({ key: 'path:' + end.id, step: end.id, phase: end.phase, state: 'unreached' });
  }
  return { rows, current, mismatch: active ? current === undefined : terminal === undefined };
}

export function groupActivity(rows: readonly ActivityRow[], workflow?: RunWorkflowResponse): {
  phase: string | null; label?: string; rows: ActivityRow[];
}[] {
  const labels = new Map(workflow?.phases.map(phase => [phase.id, phase.label]));
  const groups: ReturnType<typeof groupActivity> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.phase === row.phase) last.rows.push(row);
    else {
      const label = row.phase === null ? undefined : labels.get(row.phase);
      groups.push({ phase: row.phase, rows: [row], ...(label === undefined ? {} : { label }) });
    }
  }
  return groups;
}

export function placeSessions(steps: readonly RunStep[], sessions: readonly Session[], now: number): Map<string, Session[]> {
  const ordered = orderAttempts(steps).reverse();
  const placed = new Map<string, Session[]>();
  for (const session of [...sessions].sort((a, b) => a.sequence - b.sequence)) {
    const started = Date.parse(session.startedAt);
    const attempt = ordered.find(step => step.step === session.step && Date.parse(step.startedAt) <= started &&
      started <= (step.endedAt === null ? now : Date.parse(step.endedAt)));
    if (!attempt) continue;
    const group = placed.get(attempt.id);
    if (group) group.push(session);
    else placed.set(attempt.id, [session]);
  }
  return placed;
}
