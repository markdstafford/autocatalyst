import { describe, expect, it } from 'vitest';

import { isKnownRunStepId } from './run-step-catalog.js';
import {
  getRunWorkflowById,
  getRunWorkflowForWorkKind,
  isKnownRunWorkflowId,
  runWorkflows
} from './run-workflows.js';

const expectedPaths = {
  feature: ['intake', 'spec.author', 'spec.human_review', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'docs.human_review', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'],
  enhancement: ['intake', 'spec.author', 'spec.human_review', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'docs.human_review', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'],
  bug: ['intake', 'spec.author', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'],
  chore: ['intake', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'],
  file_issue: ['intake', 'spec.author', 'issues.file', 'done'],
  question: ['intake', 'question.answer', 'done']
} as const;

describe('run workflows', () => {
  it('stores each approved workflow path as separate data', () => {
    expect(Object.keys(runWorkflows)).toEqual(['feature', 'enhancement', 'bug', 'chore', 'file_issue', 'question']);
    for (const [workflowId, steps] of Object.entries(expectedPaths)) {
      expect(runWorkflows[workflowId as keyof typeof runWorkflows].steps).toEqual(steps);
    }
    expect(runWorkflows.feature).not.toBe(runWorkflows.enhancement);
  });

  it('declares artifact kinds only where approved', () => {
    expect(runWorkflows.feature.artifactKind).toBe('feature_spec');
    expect(runWorkflows.enhancement.artifactKind).toBe('enhancement_spec');
    expect(runWorkflows.bug.artifactKind).toBe('bug_triage');
    expect(runWorkflows.chore.artifactKind).toBeUndefined();
    expect(runWorkflows.file_issue.artifactKind).toBeUndefined();
    expect(runWorkflows.question.artifactKind).toBeUndefined();
  });

  it('exposes lookup helpers for workflow ids and work kinds', () => {
    expect(isKnownRunWorkflowId('feature')).toBe(true);
    expect(isKnownRunWorkflowId('unknown')).toBe(false);
    expect(getRunWorkflowById('bug')?.id).toBe('bug');
    expect(getRunWorkflowById('unknown')).toBeNull();
    expect(getRunWorkflowForWorkKind('file_issue')?.id).toBe('file_issue');
    expect(getRunWorkflowForWorkKind('custom')).toBeNull();
  });

  it('keeps revise and needs_input behavior in workflow transition tables', () => {
    expect(runWorkflows.feature.transitions['spec.human_review']?.revise).toBe('spec.author');
    expect(runWorkflows.feature.transitions['implementation.human_review']?.revise).toBe('implementation.build');
    expect(runWorkflows.feature.transitions['docs.human_review']?.revise).toBe('docs.update');
    expect(runWorkflows.feature.transitions['pr.finalize']?.revise).toBe('implementation.human_review');
    expect(runWorkflows.feature.transitions['pr.human_review']?.revise).toBe('pr.finalize');
    expect(runWorkflows.feature.transitions['spec.author']?.needs_input).toBe('spec.awaiting_input');
    expect(runWorkflows.feature.transitions['spec.awaiting_input']?.advance).toBe('spec.author');
    expect(runWorkflows.feature.transitions['implementation.build']?.needs_input).toBe('implementation.awaiting_input');
    expect(runWorkflows.feature.transitions['implementation.awaiting_input']?.advance).toBe('implementation.build');
    expect(runWorkflows.question.transitions['question.answer']?.needs_input).toBeUndefined();
  });

  it('references only catalog steps in paths and transition tables', () => {
    for (const workflow of Object.values(runWorkflows)) {
      for (const step of workflow.steps) {
        expect(isKnownRunStepId(step)).toBe(true);
      }
      for (const [source, directives] of Object.entries(workflow.transitions)) {
        expect(isKnownRunStepId(source)).toBe(true);
        for (const destination of Object.values(directives)) {
          expect(isKnownRunStepId(destination)).toBe(true);
        }
      }
    }
  });
});
