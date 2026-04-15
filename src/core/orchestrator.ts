// src/core/orchestrator.ts
import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { createLogger } from './logger.js';
import type { SlackAdapter } from '../adapters/slack/slack-adapter.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { SpecGenerator, ReviseResult } from '../adapters/agent/spec-generator.js';
import type { SpecPublisher } from '../adapters/slack/canvas-publisher.js';
import type { Run, RunStage, RequestIntent } from '../types/runs.js';
import type { Request, ThreadMessage } from '../types/events.js';
import type { FeedbackSource } from '../adapters/notion/notion-feedback-source.js';
import type { NotionComment } from '../adapters/agent/spec-generator.js';
import type { IntentClassifier } from '../adapters/agent/intent-classifier.js';

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
      if (event.type === 'new_request') {
        await this._handleNewRequest(event.payload);
      } else if (event.type === 'thread_message') {
        await this._handleSpecFeedback(event.payload);
      }
      // approval_signal handled in a future feature
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
      intent: 'idea' as RequestIntent,
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

  private async _handleNewRequest(request: Request): Promise<void> {
    const run = this.createRun(request);
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

    this.transition(run, 'review' as RunStage);
  }

  private async _handleSpecFeedback(feedback: ThreadMessage): Promise<void> {
    const run = this.runs.get(feedback.request_id);
    if (!run || run.stage !== ('review' as RunStage)) return;

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

    this.transition(run, 'review' as RunStage);
  }
}
