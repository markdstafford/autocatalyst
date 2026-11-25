import type { Run, RunStep, RunWorkflowResponse } from '@autocatalyst/api-contract';
import { currentTerminal, orderAttempts } from './run-activity-path.js';
import { terminalRunStatus } from './run-state.js';

export function projectProgress(run: Run, workflow: RunWorkflowResponse, attempts: readonly RunStep[] = []) {
  const terminal = terminalRunStatus(run);
  const metadata = new Map(workflow.steps.map(step => [step.id, step]));
  const phaseOf = (step: string) => metadata.get(step)?.phase ?? null;
  const currentPhase = phaseOf(run.currentStep);
  const ordered = orderAttempts(attempts);
  const last = currentTerminal(run, ordered);
  const history = ordered.filter(attempt => attempt !== last && metadata.get(attempt.step)?.kind !== 'terminal');
  const stopped = terminal === 'failed' || terminal === 'canceled';
  const position = stopped ? history.at(-1)?.step : run.currentStep;
  const indexOf = (phase: string | null) => workflow.phases.findIndex(item => item.id === phase);
  const current = position === undefined ? -1 : indexOf(phaseOf(position));
  const lastPhased = [...history].reverse().find(attempt => indexOf(phaseOf(attempt.step)) !== -1);
  const doneThrough = lastPhased ? indexOf(phaseOf(lastPhased.step)) : -1;
  const waitingOn = run.waitingOn ?? metadata.get(run.currentStep)?.waitingOn;

  const segments = workflow.phases.map((phase, index) => {
    const members = phase.steps.flatMap(id => {
      const step = metadata.get(id);
      return step?.onPath && step.kind !== 'terminal' ? [step] : [];
    });
    return {
      id: phase.id,
      label: phase.label,
      state: terminal === 'done' ? 'done' : index === current ? 'current' :
        (current === -1 ? index <= doneThrough : index < current) ? 'done' : 'upcoming',
      gates: members.flatMap((step, i) => step.kind === 'gate' ? [{
        step: step.id, position: (i + 0.5) / members.length,
        waiting: !run.terminal && terminal === undefined && waitingOn === 'human' && run.currentStep === step.id
      }] : [])
    } as const;
  });
  const phase = segments[current];
  const description = terminal === 'done' ? 'All phases done.' : phase !== undefined
    ? `${stopped ? 'Stopped in phase' : 'Phase'} ${current + 1} of ${segments.length}, ${phase.label}, ${stopped ? 'at' : 'step'} ${position}${stopped ? `; current step ${run.currentStep}` : ''}.`
    : stopped ? `Work stopped${position === undefined ? '' : ` at ${position}`}; current step ${run.currentStep}.`
      : `Current step ${run.currentStep}; no current phase.`;
  return { segments, description, currentLabel: workflow.phases.find(phase => phase.id === currentPhase)?.label };
}
