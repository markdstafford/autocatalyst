import type { Run } from '@autocatalyst/api-contract';

/** Legacy records can omit the read projection fields; explicit non-live values still block a reply. */
export function canDecideGate(run: Run, step: string): boolean {
  return (
    run.currentStep === step &&
    run.terminal === false &&
    (run.status === undefined || run.status === 'in_progress') &&
    (run.waitingOn === undefined || run.waitingOn === 'human')
  );
}
