import type { Run, RunStep, RunWorkflowResponse } from '@autocatalyst/api-contract';
import { useId } from 'react';
import { Tooltip } from '../ui/tooltip.js';
import { projectProgress } from './run-progress-projection.js';

const fill = { done: 'bg-subtext', current: 'bg-text', upcoming: 'bg-surface-1' } as const;

export function RunProgress({ run, workflow, attempts }: {
  run: Run; workflow: RunWorkflowResponse | undefined; attempts: readonly RunStep[] | undefined;
}) {
  const descriptionId = useId();
  const progress = workflow && projectProgress(run, workflow, attempts);
  const compact = (progress?.segments.length ?? 0) >= 6;
  return (
    <div className="mb-4 min-w-0 space-y-2">
      {progress && progress.segments.length > 0 ? (
        <div role="group" aria-label="Run progress" aria-describedby={descriptionId} data-testid="run-progress">
          <span className="sr-only" id={descriptionId}>{progress.description}</span>
          <ol className="flex min-w-0 gap-1" aria-label="Workflow phases">
            {progress.segments.map((segment, index) => {
              const numbered = compact && segment.state !== 'current';
              return (
                <li key={segment.id} className="flex min-w-0 flex-1 flex-col" data-phase-state={segment.state}
                  aria-current={segment.state === 'current' ? 'step' : undefined}>
                  <span className="sr-only">{`Phase ${index + 1} of ${progress.segments.length}, ${segment.label}: ${segment.state}.`}</span>
                  {numbered ? (
                    <Tooltip label={segment.label} delay={0}>
                      <span tabIndex={0} aria-label={segment.label} className="mb-1 block text-xs text-subtext">{index + 1}</span>
                    </Tooltip>
                  ) : <span className="mb-1 block break-words text-xs" aria-hidden="true">{segment.label}</span>}
                  <div className={`relative mt-auto h-[6px] shrink-0 rounded-xs ${fill[segment.state]}`}>
                    {segment.gates.map(gate => (
                      <Tooltip key={gate.step} label={gate.step} delay={0}>
                        <span tabIndex={0} role="img" aria-label={`${gate.step}: ${gate.waiting ? 'Waiting on you' : 'Not waiting'}`}
                          data-gate-step={gate.step} data-waiting={gate.waiting}
                          style={{ left: `${gate.position * 100}%` }}
                          className={`absolute inset-y-0 size-[6px] -translate-x-1/2 rounded-full border border-overlay ${gate.waiting ? 'bg-text' : 'bg-background'}`} />
                      </Tooltip>
                    ))}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
      <p data-testid="run-progress-step" className="break-words text-sm">
        {progress?.currentLabel === undefined ? null : <span>{progress.currentLabel} · </span>}
        <span className="font-mono">{run.currentStep}</span>
      </p>
    </div>
  );
}
