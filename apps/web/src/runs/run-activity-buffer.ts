import type { ClientRunEvent, RunStep } from '@autocatalyst/api-contract';
import { formatActivityEvent } from './run-activity-event-text.js';

export const RUN_ACTIVITY_EVENTS_PER_RUN = 500;

interface Placement {
  readonly step: string;
  readonly time: number;
  readonly order: number;
  attemptId?: string;
}
interface EventKey { readonly id: string; readonly time: number }
export interface ActivityEventLine extends Placement, EventKey {
  readonly createdAt: string;
  readonly text: string;
}

interface Hint {
  readonly id: string;
  readonly step: string;
  readonly index: number;
  readonly started: number;
  readonly order: number;
}

function compare(a: EventKey, b: EventKey): number {
  return a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Per-run, page-memory display buffer. Only formatted text is retained. */
export class RunActivityBuffer {
  private readonly lines: ActivityEventLine[] = [];
  private readonly ids = new Set<string>();
  private readonly hints = new Map<string, Hint>();
  private readonly lost = new Set<string>();
  private unresolvedLoss: Placement[] = [];
  private cutoff: EventKey | undefined;
  private order = 0;

  add(event: ClientRunEvent, steps: readonly RunStep[]): boolean {
    const order = ++this.order;
    if (event.type === 'run_recovery' || event.type === 'run_state_transition') {
      const { id, step, occurrence, startedAt } = event.runStep;
      if (!this.hints.has(id)) {
        this.hints.set(id, { id, step, index: occurrence.index, started: Date.parse(startedAt), order });
      }
      this.reconcile(steps);
    }

    const text = formatActivityEvent(event);
    const time = Date.parse(event.createdAt);
    const key = { id: event.id, time };
    if (text === null || this.ids.has(event.id) || (this.cutoff && compare(key, this.cutoff) <= 0)) {
      return false;
    }
    const line: ActivityEventLine = {
      ...key, text, createdAt: event.createdAt, order,
      step: 'runStep' in event ? event.runStep.step : event.step,
      ...(event.type === 'run_recovery' ? { attemptId: event.runStep.id } : {})
    };
    this.place(line, steps);
    this.ids.add(line.id);
    this.lines.push(line);
    this.lines.sort(compare);

    if (this.lines.length > RUN_ACTIVITY_EVENTS_PER_RUN) {
      const dropped = this.lines.shift()!;
      this.ids.delete(dropped.id);
      this.cutoff = { id: dropped.id, time: dropped.time };
      if (dropped.attemptId !== undefined) this.lost.add(dropped.attemptId);
      else this.unresolvedLoss.push({ step: dropped.step, time: dropped.time, order: dropped.order });
    }
    return true;
  }

  reconcile(steps: readonly RunStep[]): void {
    for (const line of this.lines) this.place(line, steps);
    this.unresolvedLoss = this.unresolvedLoss.filter(item => {
      this.place(item, steps);
      if (item.attemptId === undefined) return true;
      this.lost.add(item.attemptId);
      return false;
    });
  }

  forAttempt(id: string): ActivityEventLine[] {
    return this.lines.filter(line => line.attemptId === id);
  }

  lostEarlierEvents(id: string): boolean {
    return this.lost.has(id);
  }

  private place(item: Placement, steps: readonly RunStep[]): void {
    if (item.attemptId !== undefined) return;
    // Hints introduce a newly opened occurrence before the durable read sees it.
    // They also put a ceiling on eligible indices at a shared start/end millisecond.
    const hints = [...this.hints.values()];
    const equalHints = hints.filter(hint => hint.started === item.time);
    const next = equalHints.filter(hint => hint.order > item.order)
      .reduce((index, hint) => Math.min(index, hint.index), Infinity);
    const prior = equalHints.filter(hint => hint.order < item.order)
      .reduce((index, hint) => Math.max(index, hint.index), -Infinity);

    const candidates = new Map(hints.filter(hint => hint.step === item.step)
      .map(hint => [hint.id, { ...hint, ended: Infinity, durable: false }]));
    for (const step of steps) {
      if (step.step === item.step) candidates.set(step.id, {
        id: step.id, step: step.step, started: Date.parse(step.startedAt), index: step.occurrence.index,
        ended: step.endedAt === null ? Infinity : Date.parse(step.endedAt), order: 0, durable: true
      });
    }
    const matching = [...candidates.values()].filter(step => step.started <= item.time &&
      (step.started < item.time || step.index < next)).sort((a, b) => b.index - a.index);
    const open = matching.find(step => item.time <= step.ended && (item.time < step.ended || step.index >= prior));
    const best = open ?? matching[0];
    if (best?.durable) item.attemptId = best.id;
  }
}
