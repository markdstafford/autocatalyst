import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { runStepCatalog } from './run-step-catalog.js';
import { projectRunWorkflow } from './run-workflow-projection.js';
import { validateRunWorkflow } from './run-workflow-resolver.js';
import { runWorkflowIds, runWorkflows, type RunWorkflowDefinition } from './run-workflows.js';

const spec = { id: 'spec', label: 'Spec' };
const implementation = { id: 'implementation', label: 'Implementation' };
const pr = { id: 'pr', label: 'Pull request' };
const expectedPhases = {
  feature: [spec, implementation, pr],
  enhancement: [spec, implementation, pr],
  bug: [{ id: 'spec', label: 'Triage' }, implementation, pr],
  chore: [implementation, pr],
  file_issue: [spec],
  question: []
};

describe('workflow projection', () => {
  it.each(runWorkflowIds)('%s orders phases by first appearance and declares their labels', (workKind) => {
    const definition = runWorkflows[workKind];
    expect(definition.phases).toEqual(expectedPhases[workKind]);
    const phaseIds = new Set(definition.steps.map(id => runStepCatalog[id].phase).filter(id => id !== null));
    expect(definition.phases.map(({ id }) => id)).toEqual([...phaseIds]);
    const result = projectRunWorkflow(workKind, validateRunWorkflow(workKind, definition));
    expect(result.workflowId).toBe(workKind);
    expect(result.workKind).toBe(workKind);
    expect(result.steps.filter(step => step.onPath).map(step => step.id)).toEqual(definition.steps);
    expect(result.steps.filter(step => step.onPath).at(-1)?.id).toBe('done');
    expect(result.phases.map(({ id, label }) => ({ id, label }))).toEqual(expectedPhases[workKind]);
    expect(result.transitions).toEqual(Object.entries(definition.transitions).flatMap(([from, slots]) =>
      Object.entries(slots ?? {}).filter(([, to]) => to !== undefined).map(([directive, to]) => ({ from, directive, to }))
    ));
    expect(result.transitions.every(edge => ['advance', 'revise', 'needs_input'].includes(edge.directive))).toBe(true);
    expect(result.steps.filter(({ phase }) => phase === null).map(({ id }) => id)).toEqual([
      'intake', ...(workKind === 'question' ? ['question.answer'] : workKind === 'file_issue' ? ['issues.file'] : []),
      'done', 'canceled', 'failed'
    ]);
  });

  it('includes pause edges and revision loops, but no phantom endpoints or implicit moves', () => {
    const definition: RunWorkflowDefinition = {
      ...runWorkflows.feature,
      transitions: {
        ...runWorkflows.feature.transitions,
        'docs.update': { advance: undefined },
        'docs.human_review': undefined
      }
    };
    const result = projectRunWorkflow('feature', validateRunWorkflow('feature', definition));
    const ids = result.steps.map(step => step.id);
    expect(ids).toEqual([
      'intake', 'spec.author', 'spec.human_review', 'implementation.plan', 'implementation.build',
      'implementation.human_review', 'pr.finalize', 'pr.open', 'pr.human_review', 'done',
      'spec.awaiting_input', 'implementation.awaiting_input', 'canceled', 'failed'
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.phases).toEqual([
      { ...spec, steps: ['spec.author', 'spec.human_review', 'spec.awaiting_input'] },
      { ...implementation, steps: ['implementation.plan', 'implementation.build', 'implementation.human_review', 'implementation.awaiting_input'] },
      { ...pr, steps: ['pr.finalize', 'pr.open', 'pr.human_review'] }
    ]);
    expect(result.steps.filter(step => !step.onPath).map(step => step.id)).toEqual(ids.slice(-4));
    expect(result.steps.find(({ id }) => id === 'spec.author')).toEqual({
      id: 'spec.author', phase: 'spec', kind: 'work', waitingOn: 'ai', roles: ['implementer', 'reviewer'], onPath: true
    });
    expect(result.steps.slice(-4)).toEqual([
      { id: 'spec.awaiting_input', phase: 'spec', kind: 'pause', waitingOn: 'human', roles: [], onPath: false },
      { id: 'implementation.awaiting_input', phase: 'implementation', kind: 'pause', waitingOn: 'human', roles: [], onPath: false },
      { id: 'canceled', phase: null, kind: 'terminal', waitingOn: 'none', roles: [], onPath: false },
      { id: 'failed', phase: null, kind: 'terminal', waitingOn: 'none', roles: [], onPath: false }
    ]);
    expect(result.transitions.map(({ from, directive, to }) => [from, directive, to])).toEqual([
      ['intake', 'advance', 'spec.author'],
      ['spec.author', 'advance', 'spec.human_review'],
      ['spec.author', 'needs_input', 'spec.awaiting_input'],
      ['spec.human_review', 'advance', 'implementation.plan'],
      ['spec.human_review', 'revise', 'spec.author'],
      ['implementation.plan', 'advance', 'implementation.build'],
      ['implementation.build', 'advance', 'implementation.human_review'],
      ['implementation.build', 'needs_input', 'implementation.awaiting_input'],
      ['implementation.human_review', 'advance', 'pr.finalize'],
      ['implementation.human_review', 'revise', 'implementation.build'],
      ['pr.finalize', 'advance', 'pr.open'],
      ['pr.finalize', 'revise', 'implementation.human_review'],
      ['pr.open', 'advance', 'pr.human_review'],
      ['pr.human_review', 'advance', 'done'],
      ['pr.human_review', 'revise', 'pr.finalize'],
      ['spec.awaiting_input', 'advance', 'spec.author'],
      ['implementation.awaiting_input', 'advance', 'implementation.build']
    ]);
  });

  it('orders transition-only steps by catalog position, not edge discovery', () => {
    const definition: RunWorkflowDefinition = {
      ...runWorkflows.chore,
      transitions: {
        'issues.file': { advance: 'done' },
        'implementation.awaiting_input': { advance: 'implementation.build' }
      }
    };
    const result = projectRunWorkflow('chore', validateRunWorkflow('chore', definition));
    expect(result.steps.filter(({ onPath }) => !onPath).map(({ id }) => id))
      .toEqual(['implementation.awaiting_input', 'issues.file', 'canceled', 'failed']);
    expect(result.transitions).toEqual([
      { from: 'issues.file', directive: 'advance', to: 'done' },
      { from: 'implementation.awaiting_input', directive: 'advance', to: 'implementation.build' }
    ]);
  });

  it.each([
    ['mismatched work kind', { ...runWorkflows.feature, workKind: 'enhancement' }],
    ['wrong family ID', { ...runWorkflows.feature, id: 'enhancement' }],
    ['empty path', { ...runWorkflows.feature, steps: [] }],
    ['repeated step', { ...runWorkflows.feature, steps: ['intake', ...runWorkflows.feature.steps] }],
    ['unknown path step', { ...runWorkflows.feature, steps: ['unknown', ...runWorkflows.feature.steps] }],
    ['reserved path step', { ...runWorkflows.feature, steps: ['failed', ...runWorkflows.feature.steps] }],
    ['wrong phase order', { ...runWorkflows.feature, phases: [implementation, spec, pr] }],
    ['missing phase', { ...runWorkflows.feature, phases: [spec, implementation] }],
    ['duplicate phase', { ...runWorkflows.feature, phases: [spec, implementation, implementation] }],
    ['extra phase', { ...runWorkflows.feature, phases: [spec, implementation, pr, { id: 'docs', label: 'Docs' }] }],
    ['blank label', { ...runWorkflows.feature, phases: [{ ...spec, label: ' \t' }, implementation, pr] }],
    ['off-path step from an undeclared phase', { ...runWorkflows.feature, transitions: { intake: { advance: 'docs.update' } } }],
    ['off-path source from an undeclared phase', { ...runWorkflows.feature, transitions: { 'docs.update': { advance: 'done' } } }],
    ['terminal source', { ...runWorkflows.feature, transitions: { done: { advance: 'intake' } } }],
    ['unknown source', { ...runWorkflows.feature, transitions: { unknown: { advance: 'done' } } }],
    ['unknown destination', { ...runWorkflows.feature, transitions: { intake: { advance: 'unknown' } } }],
    ['reserved destination', { ...runWorkflows.feature, transitions: { intake: { advance: 'canceled' } } }],
    ['explicit stop directive', { ...runWorkflows.feature, transitions: { intake: { fail: 'done' } } }],
    ['unknown directive', { ...runWorkflows.feature, transitions: { intake: { recover: 'done' } } }]
  ] as const)('rejects %s before producing a response', (_label, definition) => {
    expect(() => projectRunWorkflow('feature', validateRunWorkflow('feature', definition as RunWorkflowDefinition)))
      .toThrow('Invalid resolved run workflow.');
  });
});

it('resolves runs only through the resolver (intake may check work kinds before a run exists)', () => {
  const src = new URL('.', import.meta.url);
  const references = Object.fromEntries(readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts') && !/\.(?:spec|test)(?:-helper)?\.ts$/u.test(name))
    .map(name => [
      name,
      readFileSync(new URL(name, src), 'utf8').match(/\bgetRunWorkflowForWorkKind\b/gu)?.length ?? 0
    ])
    .filter(([, count]) => count !== 0));
  expect(references).toEqual({
    'index.ts': 1, 'issue-reference-intake.ts': 2, 'run-workflows.ts': 1, 'run-workflow-resolver.ts': 2
  });
});
