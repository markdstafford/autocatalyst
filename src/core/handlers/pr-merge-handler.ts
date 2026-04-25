import type pino from 'pino';
import type { PRManager } from '../../types/issue-tracker.js';
import type { ThreadMessage } from '../../types/events.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';

export interface PrMergeDeps {
  prManager: Pick<PRManager, 'mergePR'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  reactToRunMessage?: (run: Run, reaction: string) => Promise<void>;
  reacjiComplete?: string | null;
  logger: Pick<pino.Logger, 'warn' | 'error'>;
}

export type PrMergeResult =
  | { status: 'done' }
  | { status: 'missing_pr_url' }
  | { status: 'failed' };

export class PrMergeHandler {
  constructor(private readonly deps: PrMergeDeps) {}

  async handle(run: Run, feedback: ThreadMessage): Promise<PrMergeResult> {
    if (!run.pr_url) {
      this.deps.logger.warn(
        { event: 'pr.merge_missing_url', run_id: run.id, request_id: run.request_id },
        'pr_url is undefined on run; cannot merge',
      );
      try {
        await this.deps.postMessage(
          feedback.conversation,
          'Cannot merge: no PR URL is associated with this run.',
        );
      } catch (notifyErr) {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(notifyErr) }, 'Failed to post PR URL missing error');
      }
      return { status: 'missing_pr_url' };
    }

    try {
      await this.deps.prManager.mergePR(run.workspace_path, run.pr_url);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    try {
      await this.deps.postMessage(feedback.conversation, 'PR merged.');
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post PR merged notification');
    }

    this.deps.transition(run, 'done');
    if (this.deps.reacjiComplete) {
      this.deps.reactToRunMessage?.(run, this.deps.reacjiComplete).catch(err => {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion reaction');
      });
    }
    return { status: 'done' };
  }
}
