// src/core/orchestrator.ts
import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { createLogger } from './logger.js';
import type { SlackAdapter } from '../adapters/slack/slack-adapter.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { SpecGenerator, ReviseResult } from '../adapters/agent/spec-generator.js';
import type { SpecPublisher } from '../adapters/slack/canvas-publisher.js';
import type { Run, RunStage, RequestIntent } from '../types/runs.js';
import type { Request, ThreadMessage, InboundEvent } from '../types/events.js';
import type { FeedbackSource } from '../adapters/notion/notion-feedback-source.js';
import type { NotionComment } from '../adapters/agent/spec-generator.js';
import type { IntentClassifier, ClassificationContext, Intent } from '../adapters/agent/intent-classifier.js';

export interface Orchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface OrchestratorDeps {
  adapter: SlackAdapter;
  workspaceManager: WorkspaceManager;
  specGenerator: SpecGenerator;
  specPublisher: SpecPublisher;
  feedbackSource?: FeedbackSource;
  intentClassifier?: IntentClassifier;
  postError: (channel_id: string, thread_ts: string, text: string) => Promise<void>;
  postMessage: (channel_id: string, thread_ts: string, text: string) => Promise<void>;
  repo_url: string;
}

interface OrchestratorOptions {
  logDestination?: pino.DestinationStream;
}

export class OrchestratorImpl implements Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly logger: pino.Logger;
  private readonly runs = new Map<string, Run>();
  private _stopping = false;
  private _loopPromise: Promise<void> = Promise.resolve();

  constructor(deps: OrchestratorDeps, options?: OrchestratorOptions) {
    this.deps = deps;
    this.logger = createLogger('orchestrator', { destination: options?.logDestination });
  }

  async start(): Promise<void> {
    await this.deps.adapter.start();
    this._loopPromise = this._runLoop();

    // Wrap adapter.stop so that calling it directly (e.g. in tests) also drains
    // any in-flight event handler before returning.  orch.stop() already awaits
    // _loopPromise; this ensures the same guarantee even when callers bypass it.
    const adapter = this.deps.adapter as unknown as { stop: () => Promise<void> };
    const originalStop = adapter.stop.bind(this.deps.adapter);
    adapter.stop = async () => {
      await originalStop();
      await this._loopPromise;
    };
  }

  async stop(): Promise<void> {
    this._stopping = true;
    await this.deps.adapter.stop();
    await this._loopPromise;
  }

  private async _runLoop(): Promise<void> {
    for await (const event of this.deps.adapter.receive()) {
      if (this._stopping) break;
      await this._handleRequest(event);
    }
  }

  private async _handleRequest(event: InboundEvent): Promise<void> {
    let run: Run;
    let context: ClassificationContext;
    let content: string;
    let channel_id: string;
    let thread_ts: string;

    if (event.type === 'new_request') {
      const request = event.payload;
      run = this.createRun(request);
      context = 'new_thread';
      content = request.content;
      channel_id = request.channel_id;
      thread_ts = request.thread_ts;
    } else {
      // thread_message
      const msg = event.payload;
      const existing = this.runs.get(msg.request_id);
      if (!existing) {
        this.logger.debug({ event: 'thread_message.discarded', request_id: msg.request_id, reason: 'no_run' }, 'No run for request_id; discarding');
        return;
      }
      run = existing;

      // Guard: busy implementing
      if (run.stage === 'implementing') {
        try {
          await this.deps.postMessage(msg.channel_id, msg.thread_ts, "Implementation is in progress — I'll let you know when it's ready for review.");
        } catch (err) {
          this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post busy notification');
        }
        return;
      }

      // Guard: wrong stage (only messageable in these stages)
      const messageableStages: RunStage[] = ['intake', 'reviewing_spec', 'reviewing_implementation', 'awaiting_impl_input'];
      if (!messageableStages.includes(run.stage)) {
        this.logger.debug({ event: 'thread_message.discarded', run_id: run.id, request_id: run.request_id, stage: run.stage, reason: 'wrong_stage' }, 'Run not in a messageable stage; discarding');
        return;
      }

      context = run.stage as ClassificationContext;
      content = msg.content;
      channel_id = msg.channel_id;
      thread_ts = msg.thread_ts;
    }

    // Classify intent
    let intent: Intent = context === 'new_thread' ? 'idea' : 'feedback'; // conservative default
    if (this.deps.intentClassifier) {
      try {
        intent = await this.deps.intentClassifier.classify(content, context);
      } catch (err) {
        this.logger.warn({ event: 'intent_classification.failed', run_id: run.id, error: String(err) }, 'Intent classification failed; using default');
      }
    }

    this.logger.debug({ event: 'intent_classification.result', run_id: run.id, intent, context }, 'Intent classified');

    if (intent === 'ignore') {
      if (event.type === 'new_request') {
        // Remove the placeholder run we created
        this.runs.delete(run.request_id);
      }
      return;
    }

    // New request OR upgrade from question at intake
    const isNewRequest = event.type === 'new_request';
    const isUpgrade = event.type === 'thread_message' && run.intent === 'question' && run.stage === 'intake';

    if (isNewRequest || isUpgrade) {
      if (isUpgrade && run.intent !== intent) {
        this.logger.info({ event: 'run.intent_upgraded', run_id: run.id, request_id: run.request_id, from_intent: run.intent, to_intent: intent }, 'Run intent upgraded');
      }
      const validRequestIntents: RequestIntent[] = ['idea', 'bug', 'question'];
      if (!validRequestIntents.includes(intent as RequestIntent)) {
        this.logger.warn({ event: 'intent_routing.invalid_new_request_intent', run_id: run.id, intent }, 'Classifier returned unexpected intent for new request; defaulting to idea');
        run.intent = 'idea';
      } else {
        run.intent = intent as RequestIntent;
      }

      if (intent === 'idea') {
        if (isNewRequest) {
          await this._startSpecPipeline(run, event.payload as Request);
        } else {
          // Upgrade: construct a Request-like object from the run + current message
          const msg = event.payload as ThreadMessage;
          await this._startSpecPipeline(run, {
            id: run.request_id,
            content,
            channel_id,
            thread_ts,
            source: 'slack',
            author: msg.author,
            received_at: msg.received_at,
          });
        }
        return;
      }
      if (intent === 'bug') {
        try {
          await this.deps.postMessage(channel_id, thread_ts, "Got it — I've noted this as a bug. Bug handling is coming soon.");
        } catch (err) {
          this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post bug ack');
        }
        return;
      }
      if (intent === 'question') {
        await this._handleQuestion(channel_id, thread_ts);
        return;
      }
    }

    // In-thread routing by intent × stage
    // Safety: if we reach here with a new_request event, the intent was not idea/bug/question/ignore
    // (e.g. classifier bug returning feedback/approval for new_thread context). Log and discard.
    if (event.type === 'new_request') {
      this.logger.warn({ event: 'intent_routing.unexpected_new_request_fallthrough', run_id: run.id, intent }, 'new_request event reached in-thread routing; discarding');
      return;
    }
    const msg = event.payload; // TypeScript now knows this is ThreadMessage

    if (intent === 'question') {
      await this._handleQuestion(channel_id, thread_ts);
      return;
    }

    if (intent === 'feedback') {
      if (run.stage === 'reviewing_spec') {
        await this._handleSpecFeedback(msg, run);
      } else if (run.stage === 'reviewing_implementation' || run.stage === 'awaiting_impl_input') {
        // Implementation feedback — stub for now
        this.logger.info({ event: 'implementation_feedback.received', run_id: run.id, stage: run.stage }, 'Implementation feedback received (stub)');
      }
      return;
    }

    if (intent === 'approval') {
      if (run.stage === 'reviewing_spec') {
        // Spec approval — stub for now
        this.logger.info({ event: 'spec_approval.received', run_id: run.id, stage: run.stage }, 'Spec approval received (stub)');
      } else if (run.stage === 'reviewing_implementation') {
        // Implementation approval — stub for now
        this.logger.info({ event: 'implementation_approval.received', run_id: run.id, stage: run.stage }, 'Implementation approval received (stub)');
      }
      return;
    }
  }

  private transition(run: Run, stage: RunStage): void {
    const from = run.stage;
    run.stage = stage;
    run.updated_at = new Date().toISOString();
    this.logger.info({ event: 'run.stage_transition', run_id: run.id, request_id: run.request_id, from_stage: from, to_stage: stage }, 'Stage transition');
  }

  private createRun(request: Request): Run {
    const run: Run = {
      id: randomUUID(),
      request_id: request.id,
      intent: 'idea',
      stage: 'intake',
      workspace_path: '',
      branch: '',
      spec_path: undefined,
      publisher_ref: undefined,
      impl_feedback_ref: undefined,
      attempt: 0,
      channel_id: request.channel_id,
      thread_ts: request.thread_ts,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Keyed by request_id: at most one active run per request is the design invariant.
    // The event loop is sequential, so a second new_request for the same request_id
    // would not arrive until the first is fully processed.
    this.runs.set(request.id, run);
    this.logger.info({ event: 'run.created', run_id: run.id, request_id: request.id }, 'Run created');
    return run;
  }

  private async failRun(run: Run, channel_id: string, thread_ts: string, error: unknown): Promise<void> {
    this.transition(run, 'failed');
    this.logger.error({ event: 'run.failed', run_id: run.id, request_id: run.request_id, error: String(error) }, 'Run failed');
    await this.deps.postError(channel_id, thread_ts, `Sorry, something went wrong: ${String(error)}`);
  }

  private async _startSpecPipeline(run: Run, request: Request): Promise<void> {
    this.transition(run, 'speccing');

    // Step 1: Create workspace
    let workspace_path: string;
    let branch: string;
    try {
      ({ workspace_path, branch } = await this.deps.workspaceManager.create(run.request_id, this.deps.repo_url));
      run.workspace_path = workspace_path;
      run.branch = branch;
    } catch (err) {
      await this.failRun(run, run.channel_id, run.thread_ts, err);
      return;
    }

    // Step 2: Generate spec
    let spec_path: string;
    try {
      spec_path = await this.deps.specGenerator.create(request, workspace_path);
      run.spec_path = spec_path;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, run.channel_id, run.thread_ts, err);
      return;
    }

    // Step 3: Publish canvas
    let publisher_ref: string;
    try {
      publisher_ref = await this.deps.specPublisher.create(run.channel_id, run.thread_ts, spec_path);
      run.publisher_ref = publisher_ref;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, run.channel_id, run.thread_ts, err);
      return;
    }

    this.transition(run, 'reviewing_spec');
  }

  private async _handleSpecFeedback(feedback: ThreadMessage, run: Run): Promise<void> {
    if (!run.spec_path || !run.publisher_ref) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, new Error('Run in reviewing_spec state is missing spec_path or publisher_ref'));
      return;
    }

    this.transition(run, 'speccing');
    run.attempt += 1;

    // Step 1: Fetch Notion comments if a feedback source is configured
    let notionComments: NotionComment[] = [];
    if (this.deps.feedbackSource) {
      try {
        notionComments = await this.deps.feedbackSource.fetch(run.publisher_ref);
      } catch (err) {
        await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
        return;
      }
    }

    // Step 1.5: Get page markdown with comment spans
    let pageMarkdown: string | undefined;
    try {
      pageMarkdown = await this.deps.specPublisher.getPageMarkdown(run.publisher_ref);
      if (!pageMarkdown) pageMarkdown = undefined;
    } catch (err) {
      this.logger.warn({ event: 'page_markdown.failed', run_id: run.id, request_id: run.request_id, error: String(err) }, 'Failed to get page markdown; spans will not be preserved');
    }

    this.logger.debug({
      event: 'spec_revision.enriched',
      run_id: run.id,
      request_id: run.request_id,
      slack_feedback: feedback.content.length > 0,
      notion_comment_count: notionComments.length,
      has_page_markdown: !!pageMarkdown,
    }, 'Revision enriched with feedback sources');

    // Step 2: Revise spec
    let result: ReviseResult;
    try {
      result = await this.deps.specGenerator.revise(feedback, notionComments, run.spec_path, run.workspace_path, pageMarkdown);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    const { comment_responses: commentResponses, page_content } = result;
    this.logger.debug({ event: 'spec_revision.responses', run_id: run.id, request_id: run.request_id, comment_response_count: commentResponses?.length ?? 0, comment_response_ids: commentResponses?.map(r => r.comment_id) ?? [] }, 'Comment responses returned from revise()');

    // Step 3: Update published page
    try {
      await this.deps.specPublisher.update(run.publisher_ref, run.spec_path, page_content);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    // Step 4: Dispatch comment responses (best-effort — failures don't fail the run)
    if (this.deps.feedbackSource && commentResponses && commentResponses.length > 0) {
      for (const cr of commentResponses) {
        try {
          await this.deps.feedbackSource.reply(run.publisher_ref, cr.comment_id, cr.response);
        } catch (err) {
          this.logger.error({ event: 'run.reply_failed', run_id: run.id, comment_id: cr.comment_id, error: String(err) }, 'Failed to reply to Notion comment');
        }
      }
    }

    // Step 5: Notify user that comment processing is complete
    const count = commentResponses?.length ?? 0;
    const noun = count === 1 ? 'comment' : 'comments';
    const summary = count > 0
      ? `Done \u2014 responded to ${count} ${noun}. The spec is ready for another look.`
      : `Done \u2014 the spec has been updated. Ready for another look.`;
    try {
      await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, summary);
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
    }

    this.transition(run, 'reviewing_spec');
  }

  private async _handleQuestion(channel_id: string, thread_ts: string): Promise<void> {
    try {
      await this.deps.postMessage(channel_id, thread_ts, "I've noted your question — question answering is coming soon.");
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', error: String(err) }, 'Failed to post question stub response');
    }
  }
}
