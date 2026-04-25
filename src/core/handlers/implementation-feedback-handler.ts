import type pino from 'pino';
import type { ImplementationAgent } from '../../types/ai.js';
import type { ThreadMessage } from '../../types/events.js';
import type { FeedbackItem, ImplementationReviewPublisher } from '../../types/impl-feedback-page.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { ConversationRef } from '../../types/channel.js';
import { artifactPath } from '../run-refs.js';

export interface ImplementationFeedbackDeps {
  implementer: Pick<ImplementationAgent, 'implement'>;
  implFeedbackPage?: Pick<ImplementationReviewPublisher, 'readFeedback' | 'update'>;
  postMessage: (conversation: ConversationRef, text: string) => Promise<void>;
  transition: (run: Run, stage: RunStage) => void;
  failRun: (run: Run, conversation: ConversationRef, error: unknown) => Promise<void>;
  persist: () => void;
  logger: Pick<pino.Logger, 'info' | 'error'>;
}

export type ImplementationFeedbackResult =
  | { status: 'updated' }
  | { status: 'needs_input' }
  | { status: 'failed' };

export class ImplementationFeedbackHandler {
  constructor(private readonly deps: ImplementationFeedbackDeps) {}

  async handle(run: Run, feedback: ThreadMessage, routingStage: RunStage = run.stage): Promise<ImplementationFeedbackResult> {
    const localPath = artifactPath(run);
    if (!localPath) {
      await this.deps.failRun(run, feedback.conversation, new Error('Run missing artifact local path for implementation feedback'));
      return { status: 'failed' };
    }

    const additionalContext = await this.additionalContext(run, feedback, routingStage);
    if (additionalContext.status === 'failed') return { status: 'failed' };

    this.deps.transition(run, 'implementing');
    run.attempt += 1;
    this.deps.persist();

    let result;
    try {
      result = additionalContext.value
        ? await this.deps.implementer.implement(localPath, run.workspace_path, additionalContext.value)
        : await this.deps.implementer.implement(localPath, run.workspace_path);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    if (result.status === 'needs_input') {
      this.deps.logger.info(
        { event: 'implementation.needs_input', run_id: run.id, request_id: run.request_id },
        'Implementation needs more input',
      );
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

    this.deps.logger.info(
      { event: 'implementation.complete', run_id: run.id, request_id: run.request_id, attempt: run.attempt },
      'Implementation complete',
    );

    run.last_impl_result = {
      summary: result.summary ?? '',
      testing_instructions: result.testing_instructions ?? '',
    };
    this.deps.persist();

    if (run.impl_feedback_ref) {
      try {
        await this.deps.implFeedbackPage!.update(run.impl_feedback_ref, { summary: result.summary });
      } catch (err) {
        this.deps.logger.error(
          { event: 'run.feedback_page_update_failed', run_id: run.id, error: String(err) },
          'Failed to update implementation feedback page; continuing in degraded state',
        );
      }
    }

    try {
      await this.deps.postMessage(feedback.conversation, 'Implementation updated \u2014 check the feedback page for the latest summary and testing instructions.');
    } catch (err) {
      this.deps.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
    }

    this.deps.transition(run, 'reviewing_implementation');
    return { status: 'updated' };
  }

  private async additionalContext(
    run: Run,
    feedback: ThreadMessage,
    routingStage: RunStage,
  ): Promise<{ status: 'ok'; value: string } | { status: 'failed' }> {
    const wasAwaiting = routingStage === 'awaiting_impl_input';

    if (wasAwaiting || !run.impl_feedback_ref) {
      return { status: 'ok', value: feedback.content };
    }

    let feedbackItems: FeedbackItem[];
    try {
      feedbackItems = await this.deps.implFeedbackPage!.readFeedback(run.impl_feedback_ref);
    } catch (err) {
      await this.deps.failRun(run, feedback.conversation, err);
      return { status: 'failed' };
    }

    const unresolved = feedbackItems.filter(item => !item.resolved);
    return {
      status: 'ok',
      value: unresolved
        .map(item =>
          `- ${item.text}${item.conversation.length > 0 ? '\n  ' + item.conversation.join('\n  ') : ''}`,
        )
        .join('\n'),
    };
  }
}
