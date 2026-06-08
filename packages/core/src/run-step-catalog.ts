export type RunPhase = 'spec' | 'implementation' | 'docs' | 'pr' | null;
export type WaitingOn = 'system' | 'ai' | 'human' | 'none';
export type RunStepRole = 'implementer' | 'reviewer';

export const runStepIds = [
  'intake',
  'spec.author',
  'spec.awaiting_input',
  'spec.human_review',
  'implementation.plan',
  'implementation.build',
  'implementation.awaiting_input',
  'implementation.human_review',
  'docs.update',
  'docs.human_review',
  'pr.finalize',
  'pr.open',
  'pr.human_review',
  'issues.file',
  'question.answer',
  'done',
  'canceled',
  'failed'
] as const;

export type RunStepId = typeof runStepIds[number];

export interface RunStepDefinition {
  readonly id: RunStepId;
  readonly phase: RunPhase;
  readonly waitingOn: WaitingOn;
  readonly roles: readonly RunStepRole[];
}

export const runStepDefinitions = [
  { id: 'intake', phase: null, waitingOn: 'system', roles: [] },
  { id: 'spec.author', phase: 'spec', waitingOn: 'ai', roles: ['implementer', 'reviewer'] },
  { id: 'spec.awaiting_input', phase: 'spec', waitingOn: 'human', roles: [] },
  { id: 'spec.human_review', phase: 'spec', waitingOn: 'human', roles: [] },
  { id: 'implementation.plan', phase: 'implementation', waitingOn: 'ai', roles: ['implementer'] },
  { id: 'implementation.build', phase: 'implementation', waitingOn: 'ai', roles: ['implementer', 'reviewer'] },
  { id: 'implementation.awaiting_input', phase: 'implementation', waitingOn: 'human', roles: [] },
  { id: 'implementation.human_review', phase: 'implementation', waitingOn: 'human', roles: [] },
  { id: 'docs.update', phase: 'docs', waitingOn: 'ai', roles: ['implementer'] },
  { id: 'docs.human_review', phase: 'docs', waitingOn: 'human', roles: [] },
  { id: 'pr.finalize', phase: 'pr', waitingOn: 'ai', roles: ['reviewer'] },
  { id: 'pr.open', phase: 'pr', waitingOn: 'system', roles: [] },
  { id: 'pr.human_review', phase: 'pr', waitingOn: 'human', roles: [] },
  { id: 'issues.file', phase: null, waitingOn: 'system', roles: [] },
  { id: 'question.answer', phase: null, waitingOn: 'ai', roles: ['implementer'] },
  { id: 'done', phase: null, waitingOn: 'none', roles: [] },
  { id: 'canceled', phase: null, waitingOn: 'none', roles: [] },
  { id: 'failed', phase: null, waitingOn: 'none', roles: [] }
] as const satisfies readonly RunStepDefinition[];

export const runStepCatalog = Object.fromEntries(
  runStepDefinitions.map((definition) => [definition.id, definition])
) as Readonly<Record<RunStepId, RunStepDefinition>>;

const knownRunStepIds = new Set<string>(runStepIds);

export const terminalSteps = runStepDefinitions.filter((step) => step.waitingOn === 'none').map((step) => step.id);
export const modelActiveSteps = runStepDefinitions.filter((step) => step.waitingOn === 'ai').map((step) => step.id);
export const messageAcceptingSteps = runStepDefinitions.filter((step) => step.waitingOn === 'human').map((step) => step.id);

export function isKnownRunStepId(stepId: string): stepId is RunStepId {
  return knownRunStepIds.has(stepId);
}

export function getRunStepDefinition(stepId: string): RunStepDefinition | null {
  if (!isKnownRunStepId(stepId)) {
    return null;
  }
  return runStepCatalog[stepId];
}

export function deriveRunTerminal(stepId: RunStepId): boolean {
  return runStepCatalog[stepId].waitingOn === 'none';
}
