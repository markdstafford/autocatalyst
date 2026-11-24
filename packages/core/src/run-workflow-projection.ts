import type { RunWorkflowResponse } from '@autocatalyst/api-contract';

import { runStepCatalog, runStepDefinitions, type RunStepId } from './run-step-catalog.js';
import { runWorkflowStopSteps, type CheckedRunWorkflow } from './run-workflow-resolver.js';

export function projectRunWorkflow(workKind: string, { definition, edges }: CheckedRunWorkflow): RunWorkflowResponse {
  const onPath = new Set(definition.steps);
  const endpoints = new Set<RunStepId>();
  for (const { from, to } of edges) {
    endpoints.add(from);
    endpoints.add(to);
  }
  const stepIds = [
    ...definition.steps,
    ...runStepDefinitions.map(({ id }) => id).filter((id) => endpoints.has(id) && !onPath.has(id)),
    ...runWorkflowStopSteps
  ];
  const steps = stepIds.map((id) => {
    const { phase, kind, waitingOn, roles } = runStepCatalog[id];
    return { id, phase, kind, waitingOn, roles: [...roles], onPath: onPath.has(id) };
  });
  return {
    workflowId: definition.id,
    workKind,
    phases: definition.phases.map(({ id, label }) => ({
      id,
      label,
      steps: steps.filter((step) => step.phase === id).map((step) => step.id)
    })),
    steps,
    transitions: [...edges]
  };
}
