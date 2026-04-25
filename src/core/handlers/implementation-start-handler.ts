import type pino from 'pino';
import type { ImplementationAgent } from '../../types/ai.js';
import type { ThreadMessage } from '../../types/events.js';
import type { ImplementationReviewPublisher } from '../../types/impl-feedback-page.js';
import { titleFromArtifactPath } from '../../types/publisher.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { requireArtifactRefs, artifactPublishedUrl } from '../run-refs.js';

export interface ImplementationStartDeps {
  implementer: Pick<ImplementationAgent, 'implement'>;
  implFeedbackPage?: Pick<ImplementationReviewPublisher, 'create' | 'updateStatus'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'info' | 'warn' | 'error'>;
}

export type ImplementationStartResult =
  | { status: 'reviewing_implementation' }
  | { status: 'needs_input' }
  | { status: 'failed' };

export class ImplementationStartHandler {
  constructor(private readonly deps: ImplementationStartDeps) {}

  async handle(run: Run, feedback: ThreadMessage, additionalContext?: string): Promise<ImplementationStartResult> {
    const refs = requireArtifactRefs(run);
    if (!refs) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run missing artifact local path or publisher ref for implementation'));
      return { status: 'failed' };
    }

    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(feedback.conversation, message).catch(err => {
        this.deps.logger.warn(
          { event: 'progress_failed', phase: 'implementation', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    if (run.impl_feedback_ref) {
      await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'in_progress').catch(err =>
        this.deps.logger.error(
          { event: 'run.status_update_failed', run_id: run.id, status: 'in_progress', error: String(err) },
          'Failed to update testing guide status',
        ),
      );
    }

    let result;
    try {
      result = await this.deps.implementer.implement(
        refs.local_path,
        run.workspace_path,
        additionalContext,
        onProgress,
      );
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    if (result.status === 'needs_input') {
      this.deps.logger.info({ event: 'implementation.needs_input', run_id: run.id, request_id: run.request_id }, 'Implementation needs input');
      try {
        await this.deps.postMessage(feedback.conversation, `I need input \u2014 ${result.question ?? 'please provide more context'}`);
      } catch (err) {
        this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question');
      }
      this.deps.transition(run, 'awaiting_impl_input');
      return { status: 'needs_input' };
    }

    if (result.status === 'failed') {
      await this.deps.failRun(run, feedback.conversation, new Error(result.error ?? 'Implementation failed'));
      return { status: 'failed' };
    }

    this.deps.logger.info({ event: 'implementation.complete', run_id: run.id, request_id: run.request_id, attempt: run.attempt }, 'Implementation complete');
    run.last_impl_result = {
      summary: result.summary ?? '',
      testing_instructions: result.testing_instructions ?? '',
    };
    this.deps.persist();

    let feedbackPageUrl: string | undefined;
    try {
      const publishedReview = await this.deps.implFeedbackPage!.create({
        artifact_ref: refs.publication_ref,
        artifact_url: artifactPublishedUrl(run),
        title: titleFromArtifactPath(refs.local_path),
        summary: result.summary ?? '',
        testing_instructions: result.testing_instructions ?? '',
      });
      run.impl_feedback_ref = publishedReview.id;
      this.deps.persist();
      feedbackPageUrl = publishedReview.url;
    } catch (err) {
      this.deps.logger.error(
        { event: 'run.feedback_page_failed', run_id: run.id, error: String(err) },
        'Failed to create implementation feedback page; continuing in degraded state',
      );
    }

    const completionMsg = feedbackPageUrl
      ? `Implementation complete. Feedback page: ${feedbackPageUrl}`
      : 'Implementation complete. (Could not create feedback page \u2014 check logs.)';
    try {
      await this.deps.postMessage(feedback.conversation, completionMsg);
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
    }

    if (run.impl_feedback_ref) {
      await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'waiting_on_feedback').catch(err =>
        this.deps.logger.error(
          { event: 'run.status_update_failed', run_id: run.id, status: 'waiting_on_feedback', error: String(err) },
          'Failed to update testing guide status',
        ),
      );
    }

    this.deps.transition(run, 'reviewing_implementation');
    return { status: 'reviewing_implementation' };
  }
}
