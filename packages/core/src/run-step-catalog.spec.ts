import { describe, expect, it } from 'vitest';

import {
  deriveRunTerminal,
  getRunStepDefinition,
  isKnownRunStepId,
  messageAcceptingSteps,
  modelActiveSteps,
  runStepCatalog,
  runStepDefinitions,
  terminalSteps
} from './run-step-catalog.js';

const expectedCatalog = {
  intake: { phase: null, kind: 'work', waitingOn: 'system', roles: [] },
  'spec.author': { phase: 'spec', kind: 'work', waitingOn: 'ai', roles: ['implementer', 'reviewer'] },
  'spec.awaiting_input': { phase: 'spec', kind: 'pause', waitingOn: 'human', roles: [] },
  'spec.human_review': { phase: 'spec', kind: 'gate', waitingOn: 'human', roles: [] },
  'implementation.plan': { phase: 'implementation', kind: 'work', waitingOn: 'ai', roles: ['implementer'] },
  'implementation.build': { phase: 'implementation', kind: 'work', waitingOn: 'ai', roles: ['implementer', 'reviewer'] },
  'implementation.awaiting_input': { phase: 'implementation', kind: 'pause', waitingOn: 'human', roles: [] },
  'implementation.human_review': { phase: 'implementation', kind: 'gate', waitingOn: 'human', roles: [] },
  'docs.update': { phase: 'docs', kind: 'work', waitingOn: 'ai', roles: ['implementer'] },
  'docs.human_review': { phase: 'docs', kind: 'gate', waitingOn: 'human', roles: [] },
  'pr.finalize': { phase: 'pr', kind: 'work', waitingOn: 'ai', roles: ['reviewer'] },
  'pr.open': { phase: 'pr', kind: 'work', waitingOn: 'system', roles: [] },
  'pr.human_review': { phase: 'pr', kind: 'gate', waitingOn: 'human', roles: [] },
  'issues.file': { phase: null, kind: 'work', waitingOn: 'system', roles: [] },
  'question.answer': { phase: null, kind: 'work', waitingOn: 'ai', roles: ['implementer'] },
  done: { phase: null, kind: 'terminal', waitingOn: 'none', roles: [] },
  canceled: { phase: null, kind: 'terminal', waitingOn: 'none', roles: [] },
  failed: { phase: null, kind: 'terminal', waitingOn: 'none', roles: [] }
} as const;

describe('run step catalog', () => {
  it('contains exactly the approved step definitions', () => {
    expect(Object.fromEntries(runStepDefinitions.map((definition) => [definition.id, {
      phase: definition.phase,
      kind: definition.kind,
      waitingOn: definition.waitingOn,
      roles: definition.roles
    }]))).toEqual(expectedCatalog);
    expect(Object.keys(runStepCatalog)).toEqual(Object.keys(expectedCatalog));
  });

  it('looks up known step ids and rejects unknown ids', () => {
    expect(isKnownRunStepId('implementation.build')).toBe(true);
    expect(isKnownRunStepId('implementation.define_classes')).toBe(false);
    expect(getRunStepDefinition('docs.update')?.waitingOn).toBe('ai');
    expect(getRunStepDefinition('missing.step')).toBeNull();
  });

  it('derives behavioral sets from waitingOn values', () => {
    const terminalFromCatalog = runStepDefinitions.filter((step) => step.waitingOn === 'none').map((step) => step.id);
    const aiFromCatalog = runStepDefinitions.filter((step) => step.waitingOn === 'ai').map((step) => step.id);
    const humanFromCatalog = runStepDefinitions.filter((step) => step.waitingOn === 'human').map((step) => step.id);

    expect(terminalSteps).toEqual(terminalFromCatalog);
    expect(modelActiveSteps).toEqual(aiFromCatalog);
    expect(messageAcceptingSteps).toEqual(humanFromCatalog);
  });

  it('keeps kind and waiting class consistent for every catalog entry', () => {
    for (const { kind, waitingOn } of runStepDefinitions) {
      expect(kind === 'terminal').toBe(waitingOn === 'none');
      if (kind === 'gate' || kind === 'pause') expect(waitingOn).toBe('human');
    }
  });

  it('derives terminality from the destination step waitingOn value', () => {
    expect(deriveRunTerminal('done')).toBe(true);
    expect(deriveRunTerminal('failed')).toBe(true);
    expect(deriveRunTerminal('spec.human_review')).toBe(false);
    expect(deriveRunTerminal('pr.open')).toBe(false);
  });

  it('reports spec.human_review waitingOn human', () => {
    const definition = getRunStepDefinition('spec.human_review');
    expect(definition).not.toBeNull();
    expect(definition?.waitingOn).toBe('human');
  });
});
