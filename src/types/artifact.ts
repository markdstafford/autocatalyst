import type { RequestIntent } from './runs.js';

export type ArtifactKind = 'feature_spec' | 'bug_triage' | 'chore_plan';

export type ArtifactStatus =
  | 'drafting'
  | 'waiting_on_feedback'
  | 'approved'
  | 'complete'
  | 'superseded';

export interface ArtifactRef {
  provider: string;
  id: string;
  url?: string;
}

export interface IssueRef {
  provider: string;
  number: number;
  url?: string;
}

export interface Artifact {
  kind: ArtifactKind;
  local_path: string;
  published_ref?: ArtifactRef;
  status: ArtifactStatus;
  linked_issue?: IssueRef;
}

export interface ArtifactLifecyclePolicy {
  commit_on_approval: boolean;
  sync_issue_on_approval: boolean;
  implementation_required: boolean;
}

const DEFAULT_POLICIES: Record<ArtifactKind, ArtifactLifecyclePolicy> = {
  feature_spec: {
    commit_on_approval: true,
    sync_issue_on_approval: false,
    implementation_required: true,
  },
  bug_triage: {
    commit_on_approval: false,
    sync_issue_on_approval: true,
    implementation_required: true,
  },
  chore_plan: {
    commit_on_approval: false,
    sync_issue_on_approval: true,
    implementation_required: true,
  },
};

export function artifactKindForIntent(intent: RequestIntent): ArtifactKind | undefined {
  if (intent === 'idea') return 'feature_spec';
  if (intent === 'bug') return 'bug_triage';
  if (intent === 'chore') return 'chore_plan';
  return undefined;
}

export function getArtifactLifecyclePolicy(kind: ArtifactKind): ArtifactLifecyclePolicy {
  return { ...DEFAULT_POLICIES[kind] };
}

export function defaultArtifactLifecyclePolicies(): Record<ArtifactKind, ArtifactLifecyclePolicy> {
  return {
    feature_spec: getArtifactLifecyclePolicy('feature_spec'),
    bug_triage: getArtifactLifecyclePolicy('bug_triage'),
    chore_plan: getArtifactLifecyclePolicy('chore_plan'),
  };
}
