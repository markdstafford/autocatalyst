import type { RunStepId } from './run-step-catalog.js';
import type { StepConvergencePolicy } from './convergence-policy.js';

export type { StepConvergencePolicy } from './convergence-policy.js';

export const runWorkflowIds = ['feature', 'enhancement', 'bug', 'chore', 'file_issue', 'question'] as const;
export type RunWorkflowId = typeof runWorkflowIds[number];
export type RunDirective = 'advance' | 'revise' | 'needs_input' | 'cancel' | 'fail';
export type WorkflowTransitionTable = Readonly<Partial<Record<RunStepId, Readonly<Partial<Record<RunDirective, RunStepId>>>>>>;
export type RunArtifactKind = 'feature_spec' | 'enhancement_spec' | 'bug_triage';

export interface RunWorkflowDefinition {
  readonly id: RunWorkflowId;
  readonly workKind: string;
  readonly artifactKind?: RunArtifactKind;
  readonly steps: readonly RunStepId[];
  readonly transitions: WorkflowTransitionTable;
  readonly convergence?: Readonly<Partial<Record<RunStepId, StepConvergencePolicy>>>;
}

function advanceTransitions(steps: readonly RunStepId[]): WorkflowTransitionTable {
  return Object.fromEntries(
    steps.slice(0, -1).map((step, index) => [step, { advance: steps[index + 1] }])
  ) as WorkflowTransitionTable;
}

const featureSteps = ['intake', 'spec.author', 'spec.human_review', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'docs.human_review', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'] as const satisfies readonly RunStepId[];
const bugSteps = ['intake', 'spec.author', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'] as const satisfies readonly RunStepId[];
const choreSteps = ['intake', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'] as const satisfies readonly RunStepId[];
const fileIssueSteps = ['intake', 'spec.author', 'issues.file', 'done'] as const satisfies readonly RunStepId[];
const questionSteps = ['intake', 'question.answer', 'done'] as const satisfies readonly RunStepId[];

const featureAdvanceTransitions = advanceTransitions(featureSteps);
const bugAdvanceTransitions = advanceTransitions(bugSteps);
const choreAdvanceTransitions = advanceTransitions(choreSteps);
const fileIssueAdvanceTransitions = advanceTransitions(fileIssueSteps);

const featureLikeTransitions: WorkflowTransitionTable = {
  ...featureAdvanceTransitions,
  'spec.author': { ...featureAdvanceTransitions['spec.author'], needs_input: 'spec.awaiting_input' },
  'spec.awaiting_input': { advance: 'spec.author' },
  'spec.human_review': { ...featureAdvanceTransitions['spec.human_review'], revise: 'spec.author' },
  'implementation.build': { ...featureAdvanceTransitions['implementation.build'], needs_input: 'implementation.awaiting_input' },
  'implementation.awaiting_input': { advance: 'implementation.build' },
  'implementation.human_review': { ...featureAdvanceTransitions['implementation.human_review'], revise: 'implementation.build' },
  'docs.human_review': { ...featureAdvanceTransitions['docs.human_review'], revise: 'docs.update' },
  'pr.finalize': { ...featureAdvanceTransitions['pr.finalize'], revise: 'implementation.human_review' },
  'pr.human_review': { ...featureAdvanceTransitions['pr.human_review'], revise: 'pr.finalize' }
};

export const runWorkflows: Readonly<Record<RunWorkflowId, RunWorkflowDefinition>> = {
  feature: { id: 'feature', workKind: 'feature', artifactKind: 'feature_spec', steps: featureSteps, transitions: featureLikeTransitions },
  enhancement: { id: 'enhancement', workKind: 'enhancement', artifactKind: 'enhancement_spec', steps: featureSteps, transitions: featureLikeTransitions },
  bug: {
    id: 'bug', workKind: 'bug', artifactKind: 'bug_triage', steps: bugSteps,
    transitions: {
      ...bugAdvanceTransitions,
      'spec.author': { ...bugAdvanceTransitions['spec.author'], needs_input: 'spec.awaiting_input' },
      'spec.awaiting_input': { advance: 'spec.author' },
      'implementation.build': { ...bugAdvanceTransitions['implementation.build'], needs_input: 'implementation.awaiting_input' },
      'implementation.awaiting_input': { advance: 'implementation.build' },
      'implementation.human_review': { ...bugAdvanceTransitions['implementation.human_review'], revise: 'implementation.build' },
      'pr.finalize': { ...bugAdvanceTransitions['pr.finalize'], revise: 'implementation.human_review' },
      'pr.human_review': { ...bugAdvanceTransitions['pr.human_review'], revise: 'pr.finalize' }
    }
  },
  chore: {
    id: 'chore', workKind: 'chore', steps: choreSteps,
    transitions: {
      ...choreAdvanceTransitions,
      'implementation.build': { ...choreAdvanceTransitions['implementation.build'], needs_input: 'implementation.awaiting_input' },
      'implementation.awaiting_input': { advance: 'implementation.build' },
      'implementation.human_review': { ...choreAdvanceTransitions['implementation.human_review'], revise: 'implementation.build' },
      'pr.finalize': { ...choreAdvanceTransitions['pr.finalize'], revise: 'implementation.human_review' },
      'pr.human_review': { ...choreAdvanceTransitions['pr.human_review'], revise: 'pr.finalize' }
    }
  },
  file_issue: {
    id: 'file_issue', workKind: 'file_issue', steps: fileIssueSteps,
    transitions: {
      ...fileIssueAdvanceTransitions,
      'spec.author': { ...fileIssueAdvanceTransitions['spec.author'], needs_input: 'spec.awaiting_input' },
      'spec.awaiting_input': { advance: 'spec.author' }
    }
  },
  question: { id: 'question', workKind: 'question', steps: questionSteps, transitions: advanceTransitions(questionSteps) }
};

const knownRunWorkflowIds = new Set<string>(runWorkflowIds);

export function isKnownRunWorkflowId(workflowId: string): workflowId is RunWorkflowId {
  return knownRunWorkflowIds.has(workflowId);
}

export function getRunWorkflowById(workflowId: string): RunWorkflowDefinition | null {
  if (!isKnownRunWorkflowId(workflowId)) {
    return null;
  }
  return runWorkflows[workflowId];
}

export function getRunWorkflowForWorkKind(workKind: string): RunWorkflowDefinition | null {
  return Object.values(runWorkflows).find((workflow) => workflow.workKind === workKind) ?? null;
}
