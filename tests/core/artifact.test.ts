import { describe, expect, it } from 'vitest';
import {
  getArtifactLifecyclePolicy,
  artifactKindForIntent,
} from '../../src/types/artifact.js';

describe('artifact model', () => {
  it('maps feature, bug, and chore intents onto one artifact concept', () => {
    expect(artifactKindForIntent('idea')).toBe('feature_spec');
    expect(artifactKindForIntent('bug')).toBe('bug_triage');
    expect(artifactKindForIntent('chore')).toBe('chore_plan');
  });

  it('does not create artifacts for non-review intents', () => {
    expect(artifactKindForIntent('question')).toBeUndefined();
    expect(artifactKindForIntent('file_issues')).toBeUndefined();
  });

  it('commits feature specs on approval but not bug or chore artifacts', () => {
    expect(getArtifactLifecyclePolicy('feature_spec')).toMatchObject({
      commit_on_approval: true,
      sync_issue_on_approval: false,
      implementation_required: true,
    });
    expect(getArtifactLifecyclePolicy('bug_triage')).toMatchObject({
      commit_on_approval: false,
      sync_issue_on_approval: true,
      implementation_required: true,
    });
    expect(getArtifactLifecyclePolicy('chore_plan')).toMatchObject({
      commit_on_approval: false,
      sync_issue_on_approval: true,
      implementation_required: true,
    });
  });
});
