import { isAbsolute, posix, relative } from 'node:path';
import { convergenceCheckpointSchema, type ArtifactKind, type Project, type RunStep } from '@autocatalyst/api-contract';
import {
  buildTestingGuidePrompt,
  isCumulativeImplementationSummary,
  type DomainRepositories,
  type RunWorkInput,
  type TestingGuidePromptInput
} from '@autocatalyst/core';
import { loadLinkedIssueContext, type IssueContextReader } from './spec-authoring-context-loader.js';
import type { createRunWorkspaceGitPort } from './run-workspace-git-port.js';

type GitEvidence = Pick<ReturnType<typeof createRunWorkspaceGitPort>, 'readHead' | 'getChangedFiles' | 'getDiffText'>;

export async function loadTestingGuidePrompt(input: {
  readonly work: RunWorkInput;
  readonly repositories: Pick<DomainRepositories, 'artifacts' | 'feedback' | 'runSteps' | 'runWorkspaceMetadata'>;
  readonly git?: GitEvidence;
  readonly project?: Project;
  readonly issues?: IssueContextReader;
}): Promise<string> {
  const { work, repositories, git } = input;
  const { run, runId, tenant, previousTestingGuide } = work;
  if (run.id !== runId || run.tenant !== tenant || (input.project && input.project.tenant !== tenant)) {
    throw new Error('Invalid testing guide context scope.');
  }
  const linkedIssue = input.project
    ? await loadLinkedIssueContext(run, input.project, tenant, input.issues)
    : run.trackedIssue;
  const history = (await repositories.runSteps.listByRun(runId)).filter(step => step.runId === runId)
    .sort((left, right) => left.occurrence.index - right.occurrence.index);
  const builds = history.filter((step, index) =>
    step.step === 'implementation.build' && step.endedAt !== null &&
    !['failed', 'canceled', 'implementation.awaiting_input'].includes(history[index + 1]?.step ?? ''));
  const checkpoint = builds.at(-1)?.checkpointResult as { cumulativeSummary?: unknown } | null | undefined;
  const summary = isCumulativeImplementationSummary(checkpoint?.cumulativeSummary) ? checkpoint.cumulativeSummary : undefined;
  const workspace = await repositories.runWorkspaceMetadata.findByRunId(runId);
  let changedFiles: TestingGuidePromptInput['changedFiles'] = summary?.changedFiles ?? [];
  let diff: string | null = null;
  if (workspace?.provisionedBaseRef) {
    if (!git) throw new Error('Testing guide Git comparison is unavailable.');
    const headRef = await git.readHead(workspace.workspaceRepoRoot);
    const comparison = { workspaceRepoRoot: workspace.workspaceRepoRoot, baseRef: workspace.provisionedBaseRef, headRef };
    [changedFiles, diff] = await Promise.all([git.getChangedFiles(comparison), git.getDiffText(comparison)]);
  }

  const kind: ArtifactKind | undefined = run.workKind === 'feature' ? 'feature_spec'
    : run.workKind === 'enhancement' ? 'enhancement_spec'
    : run.workKind === 'bug' ? 'bug_triage' : undefined;
  let artifact: TestingGuidePromptInput['artifact'];
  if (kind) {
    const record = await repositories.artifacts.findByRunAndKind({ runId, kind });
    if (record?.runId === runId && record.tenant === tenant) {
      if (record.canonicalRecord === 'issue') {
        artifact = { kind: 'issue', reference: record.location };
      } else if (record.canonicalRecord === 'file') {
        const path = isAbsolute(record.location) && workspace
          ? relative(workspace.workspaceRepoRoot, record.location) : record.location;
        const normalizedPath = posix.normalize(path.replaceAll('\\', '/'));
        if (normalizedPath !== '.' && !isAbsolute(normalizedPath) && !/^[A-Za-z]:/u.test(normalizedPath) &&
            normalizedPath !== '..' && !normalizedPath.startsWith('../')) {
          artifact = { kind: 'file', reference: normalizedPath };
        }
      }
    }
  }

  let previous: TestingGuidePromptInput['previous'];
  if (previousTestingGuide) {
    const lowerBound = history.find(step => step.runId === runId && step.id === previousTestingGuide.runStepId &&
      step.step === 'implementation.testing_guide')?.occurrence.index;
    const ids = lowerBound === undefined ? new Set<string>() : fixedFeedbackIds(
      builds.filter(step => step.occurrence.index > lowerBound)
    );
    const feedback = await Promise.all([...ids].map(id => repositories.feedback.findById(id)));
    previous = { items: previousTestingGuide.items, feedback: feedback.flatMap(item =>
      item && item.tenant === tenant && item.runId === runId && item.target === 'implementation'
        ? [{ id: item.id, title: item.title, body: item.body }] : [])
    };
  }

  return buildTestingGuidePrompt({
    ...(linkedIssue ? { linkedIssue } : {}),
    ...(artifact ? { artifact } : {}),
    ...(summary ? { summary } : {}),
    changedFiles, diff,
    ...(previous ? { previous } : {})
  });
}

function fixedFeedbackIds(builds: readonly RunStep[]): Set<string> {
  const ids = new Set<string>();
  for (const step of builds) {
    const checkpoint = convergenceCheckpointSchema.safeParse(step.checkpointResult);
    if (!checkpoint.success || checkpoint.data.outcome !== 'converged') continue;
    for (const round of checkpoint.data.rounds) {
      for (const disposition of round.dispositions) {
        if (disposition.disposition === 'fixed') ids.add(disposition.feedbackId);
      }
    }
  }
  return ids;
}
