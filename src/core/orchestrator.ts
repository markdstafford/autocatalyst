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
import type { QuestionAnswerer } from '../adapters/agent/question-answerer.js';
import type { SpecCommitter } from '../adapters/notion/spec-committer.js';
import type { Implementer } from '../adapters/agent/implementer.js';
import type { ImplementationFeedbackPage, FeedbackItem } from '../adapters/notion/implementation-feedback-page.js';
import type { PRCreator } from '../adapters/agent/pr-creator.js';
import { RunStore, FileRunStore } from './run-store.js';
import type { ThreadRegistry } from '../adapters/slack/thread-registry.js';

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
  questionAnswerer?: QuestionAnswerer;
  specCommitter?: SpecCommitter;
  implementer?: Implementer;
  implFeedbackPage?: ImplementationFeedbackPage;
  prCreator?: PRCreator;
  runStore?: RunStore;
  threadRegistry?: ThreadRegistry;
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
    if (deps.runStore) {
      const loaded = deps.runStore.load();
      for (const run of loaded) {
        this.runs.set(run.request_id, run);
        deps.threadRegistry?.register(run.thread_ts, run.request_id);
      }
      if (deps.runStore instanceof FileRunStore && deps.runStore.demotedIds.size > 0) {
        const demotedRuns = [...deps.runStore.demotedIds]
          .map(id => this.runs.get(id))
          .filter((r): r is Run => r !== undefined);
        if (demotedRuns.length > 0) {
          setImmediate(() => this._notifyRestartFailures(demotedRuns));
        }
      }
    }
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
      await this._handleRequest(event as InboundEvent);
    }
  }

  private async _handleRequest(event: InboundEvent): Promise<void> {
    if (event.type === 'new_request') {
      const request = event.payload;
      const run = this.createRun(request);

      // Classify intent for new request
      let intent: Intent = 'idea';
      if (this.deps.intentClassifier) {
        try {
          intent = await this.deps.intentClassifier.classify(request.content, 'new_thread');
        } catch (err) {
          this.logger.warn({ event: 'intent_classification.failed', run_id: run.id, error: String(err) }, 'Intent classification failed for new request; defaulting to idea');
          intent = 'idea';
        }
        this.logger.debug({ event: 'intent_classification.result', run_id: run.id, intent }, 'Intent classified for new request');
      }

      // Route by intent
      if (intent === 'idea') {
        run.intent = 'idea';
        this._persistRuns();
        await this._startSpecPipeline(run, request);
      } else if (intent === 'bug') {
        run.intent = 'bug';
        this._persistRuns();
        try {
          await this.deps.postMessage(request.channel_id, request.thread_ts, 'Got it \u2014 bug report noted. Bug triage is not yet implemented.');
        } catch (err) {
          this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post bug ack');
        }
      } else if (intent === 'question') {
        run.intent = 'question';
        this._persistRuns();
        await this._handleQuestion(request.content, request.channel_id, request.thread_ts, run);
      } else {
        // ignore
        this.runs.delete(request.id);
        this._persistRuns();
        this.logger.debug({ event: 'new_request.ignored', request_id: request.id }, 'New request classified as ignore; discarding');
      }
      return;
    }

    if (event.type === 'thread_message') {
      const feedback = event.payload;
      const run = this.runs.get(feedback.request_id);
      if (!run) {
        this.logger.debug({ event: 'thread_message.discarded', request_id: feedback.request_id, reason: 'no_run' }, 'No run for request_id; discarding');
        return;
      }

      // Guard: implementation in progress -- tell the user to wait
      if (run.stage === 'implementing') {
        this.logger.info({ event: 'thread_message.busy', run_id: run.id, request_id: run.request_id }, 'Implementation in progress; notifying user');
        try {
          await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, "Implementation is in progress \u2014 I'll let you know when it's ready for review.");
        } catch (err) {
          this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post busy notification');
        }
        return;
      }

      // Only classify for stages that accept thread messages
      if (run.stage !== 'reviewing_spec' && run.stage !== 'reviewing_implementation' && run.stage !== 'awaiting_impl_input' && run.stage !== 'intake') {
        this.logger.debug({ event: 'thread_message.discarded', run_id: run.id, request_id: run.request_id, stage: run.stage, reason: 'wrong_stage' }, 'Run not in a reviewable stage; discarding');
        return;
      }

      // Classify intent
      let intent: Intent = 'feedback';
      if (this.deps.intentClassifier) {
        const context: ClassificationContext = run.stage;
        try {
          intent = await this.deps.intentClassifier.classify(feedback.content, context);
        } catch (err) {
          this.logger.warn({ event: 'intent_classification.failed', run_id: run.id, error: String(err) }, 'Intent classification failed; defaulting to feedback');
          intent = 'feedback';
        }
        this.logger.debug({ event: 'intent_classification.result', run_id: run.id, intent, stage: run.stage }, 'Intent classified');
      }

      // Intent upgrade: run.intent='question' + stage='intake' + classifier returns 'idea'/'bug'
      if (run.stage === 'intake' && (intent === 'idea' || intent === 'bug')) {
        run.intent = intent as RequestIntent;
        this._persistRuns();
        if (intent === 'idea') {
          // Build a Request from the thread message for spec pipeline
          const request: Request = {
            id: run.request_id,
            source: 'slack',
            content: feedback.content,
            author: feedback.author,
            received_at: feedback.received_at,
            thread_ts: feedback.thread_ts,
            channel_id: feedback.channel_id,
          };
          await this._startSpecPipeline(run, request);
        } else {
          try {
            await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, 'Got it \u2014 bug report noted. Bug triage is not yet implemented.');
          } catch (err) {
            this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post bug ack');
          }
        }
        return;
      }

      // Route by intent x stage
      if (intent === 'feedback') {
        if (run.stage === 'reviewing_spec') {
          await this._handleSpecFeedback(feedback);
        } else if (run.stage === 'reviewing_implementation' || run.stage === 'awaiting_impl_input') {
          await this._handleImplementationFeedback(feedback, run);
        }
      } else if (intent === 'approval') {
        if (run.stage === 'reviewing_spec') {
          await this._handleSpecApproval(feedback, run);
        } else if (run.stage === 'reviewing_implementation') {
          await this._handleImplementationApproval(feedback, run);
        }
      } else if (intent === 'question') {
        await this._handleQuestion(feedback.content, feedback.channel_id, feedback.thread_ts, run);
      }
      // 'ignore' and other intents: silently discard
    }
  }

  private async _handleQuestion(content: string, channel_id: string, thread_ts: string, run: Run): Promise<void> {
    this.logger.info({ event: 'question.received', run_id: run.id, request_id: run.request_id }, 'Question received');

    let response: string;
    if (this.deps.questionAnswerer) {
      try {
        response = await this.deps.questionAnswerer.answer(content);
      } catch (err) {
        this.logger.error({ event: 'question.answer_failed', run_id: run.id, error: String(err) }, 'Failed to answer question; posting fallback');
        response = "I wasn't able to answer that right now \u2014 try asking the team directly.";
      }
    } else {
      response = "I've noted your question \u2014 question answering is coming soon.";
    }

    try {
      await this.deps.postMessage(channel_id, thread_ts, response);
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question response');
    }
  }

  private async _handleSpecApproval(feedback: ThreadMessage, run: Run): Promise<void> {
    if (!run.spec_path || !run.publisher_ref) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, new Error('Run missing spec_path or publisher_ref for approval'));
      return;
    }

    this.transition(run, 'implementing');
    this.logger.info({ event: 'implementation.started', run_id: run.id, request_id: run.request_id }, 'Implementation started');
    run.attempt += 1;
    this._persistRuns();

    // Step 1: Acknowledge approval (best-effort -- failure doesn't abort)
    try {
      await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, 'Approved \u2014 committing spec and starting implementation.');
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post approval acknowledgement');
    }

    // Step 2: Commit spec to workspace
    try {
      await this.deps.specCommitter!.commit(run.workspace_path, run.publisher_ref, run.spec_path);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    // Step 3: Run implementation
    await this._runImplementation(feedback, run);
  }

  private async _runImplementation(feedback: ThreadMessage, run: Run, additional_context?: string): Promise<void> {
    // Invoke the implementer
    let result;
    try {
      result = additional_context !== undefined
        ? await this.deps.implementer!.implement(run.spec_path!, run.workspace_path, additional_context)
        : await this.deps.implementer!.implement(run.spec_path!, run.workspace_path);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    if (result.status === 'needs_input') {
      this.logger.info({ event: 'implementation.needs_input', run_id: run.id, request_id: run.request_id }, 'Implementation needs input');
      try {
        await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, `I need input \u2014 ${result.question ?? 'please provide more context'}`);
      } catch (err) {
        this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question');
      }
      this.transition(run, 'awaiting_impl_input');
      return;
    }

    if (result.status === 'failed') {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, new Error(result.error ?? 'Implementation failed'));
      return;
    }

    // status === 'complete'
    this.logger.info({ event: 'implementation.complete', run_id: run.id, request_id: run.request_id, attempt: run.attempt }, 'Implementation complete');

    // Create implementation feedback page (degraded if it fails -- don't abort)
    let feedbackPageUrl: string | undefined;
    try {
      const specPageUrl = `https://notion.so/${run.publisher_ref!.replace(/-/g, '')}`;
      const pageId = await this.deps.implFeedbackPage!.create(
        run.publisher_ref!,
        specPageUrl,
        result.summary ?? '',
        result.testing_instructions ?? '',
      );
      run.impl_feedback_ref = pageId;
      this._persistRuns();
      feedbackPageUrl = `https://notion.so/${pageId.replace(/-/g, '')}`;
    } catch (err) {
      this.logger.error({ event: 'run.feedback_page_failed', run_id: run.id, error: String(err) }, 'Failed to create implementation feedback page; continuing in degraded state');
    }

    const completionMsg = feedbackPageUrl
      ? `Implementation complete. Feedback page: ${feedbackPageUrl}`
      : 'Implementation complete. (Could not create feedback page \u2014 check logs.)';
    try {
      await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, completionMsg);
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
    }

    this.transition(run, 'reviewing_implementation');
  }

  private async _handleImplementationFeedback(feedback: ThreadMessage, run: Run): Promise<void> {
    const wasAwaiting = run.stage === 'awaiting_impl_input';

    // Step 1: Get additional context
    let additional_context: string;
    if (!wasAwaiting && run.impl_feedback_ref) {
      let feedbackItems: FeedbackItem[];
      try {
        feedbackItems = await this.deps.implFeedbackPage!.readFeedback(run.impl_feedback_ref);
      } catch (err) {
        await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
        return;
      }
      const unresolved = feedbackItems.filter(item => !item.resolved);
      additional_context = unresolved
        .map(item =>
          `- ${item.text}${item.conversation.length > 0 ? '\n  ' + item.conversation.join('\n  ') : ''}`,
        )
        .join('\n');
    } else {
      additional_context = feedback.content;
    }

    this.transition(run, 'implementing');
    run.attempt += 1;
    this._persistRuns();

    // Step 2: Run implementation
    let result;
    try {
      result = additional_context
        ? await this.deps.implementer!.implement(run.spec_path!, run.workspace_path, additional_context)
        : await this.deps.implementer!.implement(run.spec_path!, run.workspace_path);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    if (result.status === 'needs_input') {
      this.logger.info({ event: 'implementation.needs_input', run_id: run.id, request_id: run.request_id }, 'Implementation needs more input');
      try {
        await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, `I need input \u2014 ${result.question ?? 'please provide more context'}`);
      } catch (err) {
        this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post question');
      }
      this.transition(run, 'awaiting_impl_input');
      return;
    }

    if (result.status === 'failed') {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, new Error(result.error ?? 'Implementation failed'));
      return;
    }

    // status === 'complete'
    this.logger.info({ event: 'implementation.complete', run_id: run.id, request_id: run.request_id, attempt: run.attempt }, 'Implementation complete');

    // Step 3: Update feedback page (degraded if fails -- don't abort)
    if (run.impl_feedback_ref) {
      try {
        await this.deps.implFeedbackPage!.update(run.impl_feedback_ref, { summary: result.summary });
      } catch (err) {
        this.logger.error({ event: 'run.feedback_page_update_failed', run_id: run.id, error: String(err) }, 'Failed to update implementation feedback page; continuing in degraded state');
      }
    }

    try {
      await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, 'Implementation updated \u2014 check the feedback page for the latest summary and testing instructions.');
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
    }

    this.transition(run, 'reviewing_implementation');
  }

  private async _handleImplementationApproval(feedback: ThreadMessage, run: Run): Promise<void> {
    // Step 1: Create PR
    let prUrl: string;
    try {
      prUrl = await this.deps.prCreator!.createPR(run.workspace_path, run.branch, run.spec_path ?? '');
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    // Step 2: Post PR link (best-effort)
    try {
      await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, `PR opened: ${prUrl}`);
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post PR link');
    }

    this.transition(run, 'done');
  }

  private transition(run: Run, stage: RunStage): void {
    const from = run.stage;
    run.stage = stage;
    run.updated_at = new Date().toISOString();
    this.logger.info({ event: 'run.stage_transition', run_id: run.id, request_id: run.request_id, from_stage: from, to_stage: stage }, 'Stage transition');
    this._persistRuns();
  }

  private _persistRuns(): void {
    this.deps.runStore?.save(this.runs);
  }

  private _notifyRestartFailures(runs: Run[]): void {
    const message = "Server restarted while this was running. The run has been marked as failed. Reply in this thread to try again.";
    for (const run of runs) {
      this.deps.postMessage(run.channel_id, run.thread_ts, message).catch(err => {
        this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post restart notification');
      });
    }
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
    this._persistRuns();
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
      ({ workspace_path, branch } = await this.deps.workspaceManager.create(request.id, this.deps.repo_url));
      run.workspace_path = workspace_path;
      run.branch = branch;
    } catch (err) {
      await this.failRun(run, request.channel_id, request.thread_ts, err);
      return;
    }

    // Step 2: Generate spec
    let spec_path: string;
    try {
      spec_path = await this.deps.specGenerator.create(request, workspace_path);
      run.spec_path = spec_path;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, request.channel_id, request.thread_ts, err);
      return;
    }

    // Step 3: Publish canvas
    let publisher_ref: string;
    try {
      publisher_ref = await this.deps.specPublisher.create(request.channel_id, request.thread_ts, spec_path);
      run.publisher_ref = publisher_ref;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, request.channel_id, request.thread_ts, err);
      return;
    }

    this.transition(run, 'reviewing_spec');
  }

  private async _handleSpecFeedback(feedback: ThreadMessage): Promise<void> {
    const run = this.runs.get(feedback.request_id);
    if (!run || run.stage !== 'reviewing_spec') return;

    if (!run.spec_path || !run.publisher_ref) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, new Error('Run in review state is missing spec_path or publisher_ref'));
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

    // Step 4: Dispatch comment responses (best-effort -- failures don't fail the run)
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
}
