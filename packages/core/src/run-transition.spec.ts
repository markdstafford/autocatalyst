import { describe, expect, it } from 'vitest';

import { nextWorkflowStep } from './run-transition.js';
import { runWorkflows } from './run-workflows.js';

describe('nextWorkflowStep', () => {
  it('advances through the feature ordinary path', () => {
    const workflow = runWorkflows.feature;
    const expected = ['intake', 'spec.author', 'spec.human_review', 'implementation.plan', 'implementation.build', 'implementation.human_review', 'docs.update', 'docs.human_review', 'pr.finalize', 'pr.open', 'pr.human_review', 'done'];
    for (let index = 0; index < expected.length - 1; index += 1) {
      expect(nextWorkflowStep(workflow, expected[index], 'advance')).toMatchObject({
        ok: true,
        workflowId: 'feature',
        from: expected[index],
        directive: 'advance',
        to: expected[index + 1]
      });
    }
  });

  it('uses workflow data for revise edges', () => {
    expect(nextWorkflowStep(runWorkflows.feature, 'spec.human_review', 'revise')).toMatchObject({ ok: true, to: 'spec.author' });
    expect(nextWorkflowStep(runWorkflows.feature, 'implementation.human_review', 'revise')).toMatchObject({ ok: true, to: 'implementation.build' });
    expect(nextWorkflowStep(runWorkflows.feature, 'docs.human_review', 'revise')).toMatchObject({ ok: true, to: 'docs.update' });
    expect(nextWorkflowStep(runWorkflows.feature, 'pr.finalize', 'revise')).toMatchObject({ ok: true, to: 'implementation.human_review' });
    expect(nextWorkflowStep(runWorkflows.bug, 'pr.human_review', 'revise')).toMatchObject({ ok: true, to: 'pr.finalize' });
  });

  it('routes needs_input and pause resumes for supported workflows', () => {
    for (const workflow of [runWorkflows.feature, runWorkflows.enhancement, runWorkflows.bug, runWorkflows.file_issue]) {
      expect(nextWorkflowStep(workflow, 'spec.author', 'needs_input')).toMatchObject({ ok: true, to: 'spec.awaiting_input' });
      expect(nextWorkflowStep(workflow, 'spec.awaiting_input', 'advance')).toMatchObject({ ok: true, to: 'spec.author' });
    }
    for (const workflow of [runWorkflows.feature, runWorkflows.enhancement, runWorkflows.bug, runWorkflows.chore]) {
      expect(nextWorkflowStep(workflow, 'implementation.build', 'needs_input')).toMatchObject({ ok: true, to: 'implementation.awaiting_input' });
      expect(nextWorkflowStep(workflow, 'implementation.awaiting_input', 'advance')).toMatchObject({ ok: true, to: 'implementation.build' });
    }
  });

  it('supports universal cancel and fail from non-terminal workflow steps', () => {
    expect(nextWorkflowStep(runWorkflows.question, 'question.answer', 'cancel')).toMatchObject({ ok: true, to: 'canceled' });
    expect(nextWorkflowStep(runWorkflows.file_issue, 'issues.file', 'fail')).toMatchObject({ ok: true, to: 'failed' });
  });

  it('returns structured errors for invalid transitions', () => {
    expect(nextWorkflowStep({ ...runWorkflows.feature, id: 'missing' as never }, 'intake', 'advance')).toMatchObject({ ok: false, code: 'unknown_workflow' });
    expect(nextWorkflowStep(runWorkflows.feature, 'missing.step', 'advance')).toMatchObject({ ok: false, code: 'unknown_step' });
    expect(nextWorkflowStep(runWorkflows.question, 'implementation.build', 'advance')).toMatchObject({ ok: false, code: 'step_not_in_workflow' });
    expect(nextWorkflowStep(runWorkflows.feature, 'done', 'advance')).toMatchObject({ ok: false, code: 'terminal_step' });
    expect(nextWorkflowStep(runWorkflows.feature, 'intake', 'unsupported' as never)).toMatchObject({ ok: false, code: 'invalid_directive' });
    expect(nextWorkflowStep(runWorkflows.feature, 'intake', 'revise')).toMatchObject({ ok: false, code: 'missing_edge' });
    expect(nextWorkflowStep(runWorkflows.question, 'question.answer', 'needs_input')).toMatchObject({ ok: false, code: 'missing_pause_target' });
  });

  it('returns missing_edge for needs_input when a phase-local pause target exists but the step has no configured edge', () => {
    // spec.human_review has phase 'spec'; feature workflow owns spec.awaiting_input → missing_edge, not missing_pause_target
    expect(nextWorkflowStep(runWorkflows.feature, 'spec.human_review', 'needs_input')).toMatchObject({ ok: false, code: 'missing_edge' });
    // implementation.plan has phase 'implementation'; feature workflow owns implementation.awaiting_input
    expect(nextWorkflowStep(runWorkflows.feature, 'implementation.plan', 'needs_input')).toMatchObject({ ok: false, code: 'missing_edge' });
    // bug: implementation.plan also has a phase-local pause target via implementation.awaiting_input
    expect(nextWorkflowStep(runWorkflows.bug, 'implementation.plan', 'needs_input')).toMatchObject({ ok: false, code: 'missing_edge' });
    // chore: implementation.plan has a phase-local pause target
    expect(nextWorkflowStep(runWorkflows.chore, 'implementation.plan', 'needs_input')).toMatchObject({ ok: false, code: 'missing_edge' });
  });

  it('returns missing_pause_target for needs_input when no phase-local pause target exists', () => {
    // question.answer has phase null → no phase-local pause target possible
    expect(nextWorkflowStep(runWorkflows.question, 'question.answer', 'needs_input')).toMatchObject({ ok: false, code: 'missing_pause_target' });
    // intake has phase null → no phase-local pause target possible
    expect(nextWorkflowStep(runWorkflows.feature, 'intake', 'needs_input')).toMatchObject({ ok: false, code: 'missing_pause_target' });
  });
});
