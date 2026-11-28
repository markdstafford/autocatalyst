import { specAuthorResultSchema } from '@autocatalyst/api-contract';
import {
  renderCommittedSpecMarkdown,
  type ConvergenceEngine, type FeedbackLifecycleDependencies,
  type RunUnitOfWork, type WorkspaceGitPort
} from '@autocatalyst/core';

/** Old runner harnesses intentionally use the bare author contract. This test-only
 * strategy substitutes a satisfied review and exercises real host completion and gates. */
export function reviewedSpecCompletionStub(
  unitOfWork: RunUnitOfWork,
  feedback?: FeedbackLifecycleDependencies
): ConvergenceEngine {
  return {
    run: input => unitOfWork.run(input).then(workResult => workResult.directive === 'cancelled' ? { cancelled: true, workResult } : ({
      workResult,
      checkpointResult: { kind: 'convergence_review', step: input.run.currentStep, maxRounds: 1,
        outcome: 'converged', rounds: [], openFeedbackIds: [], lastPositions: {}, routing: { distinct: false } }
    })),
    async runSpec(input) {
      const work = await unitOfWork.run(input);
      if (work.directive === 'fail' || work.directive === 'cancelled') return work;
      if (work.directive !== 'advance') throw new Error('Unexpected pause in a legacy test harness.');
      const parsed = specAuthorResultSchema.safeParse(work.result);
      if (!parsed.success) return { directive: 'fail', reason: 'spec_author_result_invalid' };
      const output = await input.complete(parsed.data, renderCommittedSpecMarkdown(parsed.data));
      if (!output) return { directive: 'fail', reason: 'spec_authoring_failed' };
      if (feedback) {
        for (const item of await feedback.feedback.listByRun(input.run.id)) {
          if (item.target !== 'artifact' || item.status !== 'open' || item.thread[0]?.author.kind !== 'human') continue;
          await feedback.feedback.updateStatusAndAppendThread({
            feedbackId: item.id, expectedStatus: 'open', nextStatus: 'addressed', updatedAt: feedback.clock(),
            threadEntry: { id: feedback.ids(), author: input.run.owner, body: 'Addressed in the scripted revision.', createdAt: feedback.clock() }
          });
        }
      }
      return { directive: 'advance', checkpoint: output.checkpointResult };
    }
  };
}

/** In-memory HEAD for tests whose git port only records commit calls. */
export function stubSpecHead(git: WorkspaceGitPort): WorkspaceGitPort {
  const head = new Map<string, string>();
  const key = (root: string, path: string) => `${root}/${path}`;
  return {
    async readHeadFile({ workspaceRepoRoot, relativePath }) { return head.get(key(workspaceRepoRoot, relativePath)) ?? null; },
    async commitFiles(input) {
      const result = await git.commitFiles(input);
      if (input.expectedContents !== undefined) {
        for (const path of input.relativePaths) head.set(key(input.workspaceRepoRoot, path), input.expectedContents);
      }
      return result;
    }
  };
}
