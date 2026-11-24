import type { Run } from '@autocatalyst/api-contract';

import { isKnownRunStepId, runStepCatalog, type RunPhase, type RunStepId } from './run-step-catalog.js';
import { getRunWorkflowForWorkKind, isKnownRunWorkflowId, type RunWorkflowDefinition } from './run-workflows.js';

export type RunWorkflowResolverInput =
  | { readonly kind: 'new_conversation'; readonly workKind: string; readonly tenant: string; readonly projectId: string }
  | { readonly kind: 'existing_topic'; readonly workKind: string; readonly tenant: string; readonly topicId: string }
  | { readonly kind: 'existing_run'; readonly run: Run };

/**
 * Select the same definition before and after creation, independent of run progress.
 * Project-aware implementations derive the project for existing topics and runs through
 * the tenant-scoped topic and conversation, not through an optional Run API field.
 */
export type RunWorkflowResolver = (
  input: RunWorkflowResolverInput
) => RunWorkflowDefinition | null | Promise<RunWorkflowDefinition | null>;

export function requestedWorkflowWorkKind(input: RunWorkflowResolverInput): string {
  return input.kind === 'existing_run' ? input.run.workKind : input.workKind;
}

export const defaultRunWorkflowResolver: RunWorkflowResolver = (input) =>
  getRunWorkflowForWorkKind(requestedWorkflowWorkKind(input));

export const runWorkflowStopSteps = ['canceled', 'failed'] as const;
const stopSteps: ReadonlySet<string> = new Set(runWorkflowStopSteps);

interface WorkflowEdge {
  readonly from: RunStepId;
  readonly directive: 'advance' | 'revise' | 'needs_input';
  readonly to: RunStepId;
}

export interface CheckedRunWorkflow {
  readonly definition: RunWorkflowDefinition;
  readonly edges: readonly WorkflowEdge[];
}

function invalidWorkflow(): never {
  throw new Error('Invalid resolved run workflow.');
}

function isWorkflowStep(step: string): step is RunStepId {
  return isKnownRunStepId(step) && !stopSteps.has(step);
}

export function validateRunWorkflow(workKind: string, definition: RunWorkflowDefinition): CheckedRunWorkflow {
  if (definition.workKind !== workKind || definition.id !== workKind || !isKnownRunWorkflowId(definition.id)) {
    invalidWorkflow();
  }

  const path = new Set<RunStepId>();
  const phases = new Set<NonNullable<RunPhase>>();
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) invalidWorkflow();
  for (const id of definition.steps) {
    if (!isWorkflowStep(id) || path.has(id)) invalidWorkflow();
    path.add(id);
    const { phase } = runStepCatalog[id];
    if (phase !== null) phases.add(phase);
  }

  const phaseOrder = [...phases];
  if (!Array.isArray(definition.phases) || definition.phases.length !== phaseOrder.length) invalidWorkflow();
  for (const [index, phase] of definition.phases.entries()) {
    if (phase?.id !== phaseOrder[index] || typeof phase.label !== 'string' || phase.label.trim().length === 0) {
      invalidWorkflow();
    }
  }

  if (typeof definition.transitions !== 'object' || definition.transitions === null || Array.isArray(definition.transitions)) {
    invalidWorkflow();
  }
  const edges: WorkflowEdge[] = [];
  for (const [from, slots] of Object.entries(definition.transitions)) {
    if (slots === undefined) continue;
    if (typeof slots !== 'object' || slots === null || Array.isArray(slots)) invalidWorkflow();
    for (const [directive, to] of Object.entries(slots)) {
      if (to === undefined) continue;
      if (
        !isWorkflowStep(from) || runStepCatalog[from].waitingOn === 'none' ||
        (directive !== 'advance' && directive !== 'revise' && directive !== 'needs_input') ||
        !isWorkflowStep(to)
      ) {
        invalidWorkflow();
      }
      for (const { phase } of [runStepCatalog[from], runStepCatalog[to]]) {
        if (phase !== null && !phases.has(phase)) invalidWorkflow();
      }
      edges.push({ from, directive, to });
    }
  }
  return { definition, edges };
}

export async function resolveRunWorkflow(
  input: RunWorkflowResolverInput,
  resolver: RunWorkflowResolver = defaultRunWorkflowResolver
): Promise<CheckedRunWorkflow | null> {
  const definition = await resolver(input);
  return definition === null ? null : validateRunWorkflow(requestedWorkflowWorkKind(input), definition);
}
