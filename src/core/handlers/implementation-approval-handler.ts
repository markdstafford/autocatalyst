import type pino from 'pino';
import type { PRManager, PRManagerOptions } from '../../types/issue-tracker.js';
import type { SpecCommitter } from '../spec-committer.js';
import type { ThreadMessage } from '../../types/events.js';
import type { ImplementationReviewPublisher } from '../../types/impl-feedback-page.js';
import type { ArtifactPublisher } from '../../types/publisher.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { markArtifactStatus, artifactPath, artifactPublisherId } from '../run-refs.js';

export interface ImplementationApprovalDeps {
  specCommitter?: Pick<SpecCommitter, 'updateStatus'>;
  artifactPublisher: Pick<ArtifactPublisher, 'updateStatus'>;
  prManager: Pick<PRManager, 'createPR'>;
  implFeedbackPage?: Pick<ImplementationReviewPublisher, 'setPRLink' | 'updateStatus'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'error'>;
  now?: () => Date;
}

export type ImplementationApprovalResult = { status: 'pr_open' } | { status: 'failed' };

export class ImplementationApprovalHandler {
  constructor(private readonly deps: ImplementationApprovalDeps) {}

  async handle(run: Run, feedback: ThreadMessage): Promise<ImplementationApprovalResult> {
    const today = (this.deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const localPath = artifactPath(run);
    const publisherRef = artifactPublisherId(run);

    if (localPath) {
      try {
        await this.deps.specCommitter!.updateStatus(run.workspace_path, localPath, {
          status: 'complete',
          last_updated: today,
        });
      } catch (err) {
        this.deps.logger.error(
          { event: 'spec.status_update_failed', run_id: run.id, error: String(err) },
          'Failed to update spec status to complete; continuing',
        );
      }
    }

    if (publisherRef) {
      try {
        await this.deps.artifactPublisher.updateStatus?.(publisherRef, 'complete');
      } catch (err) {
        this.deps.logger.error(
          { event: 'spec.publisher_update_failed', run_id: run.id, error: String(err) },
          'Failed to update spec publisher status to complete; continuing',
        );
      }
    }
    this.markArtifactComplete(run);

    const prOptions: PRManagerOptions = {
      impl_result: run.last_impl_result,
      run_intent: run.intent,
    };
    let prUrl: string;
    try {
      prUrl = await this.deps.prManager.createPR(
        run.workspace_path,
        run.branch,
        localPath ?? '',
        prOptions,
      );
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    run.pr_url = prUrl;
    this.deps.persist();

    try {
      await this.deps.postMessage(feedback.conversation, `PR opened: ${prUrl}`);
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post PR link');
    }

    if (run.impl_feedback_ref) {
      await Promise.allSettled([
        this.deps.implFeedbackPage?.setPRLink?.(run.impl_feedback_ref, prUrl),
        this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'approved'),
      ]).then(results => {
        for (const r of results) {
          if (r.status === 'rejected') {
            this.deps.logger.error(
              { event: 'run.status_update_failed', run_id: run.id, error: String(r.reason) },
              'Failed to update impl feedback page on implementation approval',
            );
          }
        }
      });
    }

    this.deps.transition(run, 'pr_open');
    return { status: 'pr_open' };
  }

  private markArtifactComplete(run: Run): void {
    markArtifactStatus(run, 'complete');
    this.deps.persist();
  }
}
