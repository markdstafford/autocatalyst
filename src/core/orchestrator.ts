// src/core/orchestrator.ts
import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { createLogger } from './logger.js';
import type { SlackAdapter } from '../adapters/slack/slack-adapter.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { SpecGenerator } from '../adapters/agent/spec-generator.js';
import type { SpecPublisher } from '../adapters/slack/canvas-publisher.js';
import type { Run, RunStage } from '../types/runs.js';
import type { Idea, SpecFeedback } from '../types/events.js';
import type { FeedbackSource } from '../adapters/notion/notion-feedback-source.js';
import type { NotionComment } from '../adapters/agent/spec-generator.js';

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
  postError: (channel_id: string, thread_ts: string, text: string) => Promise<void>;
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
      if (event.type === 'new_idea') {
        await this._handleNewIdea(event.payload);
      } else if (event.type === 'spec_feedback') {
        await this._handleSpecFeedback(event.payload);
      }
      // approval_signal handled in a future feature
    }
  }

  private transition(run: Run, stage: RunStage): void {
    const from = run.stage;
    run.stage = stage;
    run.updated_at = new Date().toISOString();
    this.logger.info({ event: 'run.stage_transition', run_id: run.id, idea_id: run.idea_id, from_stage: from, to_stage: stage }, 'Stage transition');
  }

  private createRun(idea_id: string): Run {
    const run: Run = {
      id: randomUUID(),
      idea_id,
      stage: 'intake',
      workspace_path: '',
      branch: '',
      spec_path: undefined,
      publisher_ref: undefined,
      attempt: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Keyed by idea_id: at most one active run per idea is the design invariant.
    // The event loop is sequential, so a second new_idea for the same idea_id
    // would not arrive until the first is fully processed.
    this.runs.set(idea_id, run);
    this.logger.info({ event: 'run.created', run_id: run.id, idea_id }, 'Run created');
    return run;
  }

  private async failRun(run: Run, channel_id: string, thread_ts: string, error: unknown): Promise<void> {
    this.transition(run, 'failed');
    this.logger.error({ event: 'run.failed', run_id: run.id, idea_id: run.idea_id, error: String(error) }, 'Run failed');
    await this.deps.postError(channel_id, thread_ts, `Sorry, something went wrong: ${String(error)}`);
  }

  private async _handleNewIdea(idea: Idea): Promise<void> {
    const run = this.createRun(idea.id);
    this.transition(run, 'speccing');

    // Step 1: Create workspace
    let workspace_path: string;
    let branch: string;
    try {
      ({ workspace_path, branch } = await this.deps.workspaceManager.create(idea.id, this.deps.repo_url));
      run.workspace_path = workspace_path;
      run.branch = branch;
    } catch (err) {
      await this.failRun(run, idea.channel_id, idea.thread_ts, err);
      return;
    }

    // Step 2: Generate spec
    let spec_path: string;
    try {
      spec_path = await this.deps.specGenerator.create(idea, workspace_path);
      run.spec_path = spec_path;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, idea.channel_id, idea.thread_ts, err);
      return;
    }

    // Step 3: Publish canvas
    let publisher_ref: string;
    try {
      publisher_ref = await this.deps.specPublisher.create(idea.channel_id, idea.thread_ts, spec_path);
      run.publisher_ref = publisher_ref;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, idea.channel_id, idea.thread_ts, err);
      return;
    }

    this.transition(run, 'review');
  }

  private async _handleSpecFeedback(feedback: SpecFeedback): Promise<void> {
    const run = this.runs.get(feedback.idea_id);
    if (!run || run.stage !== 'review') return;

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

    this.logger.debug({
      event: 'spec_revision.enriched',
      run_id: run.id,
      idea_id: run.idea_id,
      slack_feedback: feedback.content.length > 0,
      notion_comment_count: notionComments.length,
    }, 'Revision enriched with feedback sources');

    // Step 2: Revise spec
    let commentResponses;
    try {
      commentResponses = await this.deps.specGenerator.revise(feedback, notionComments, run.spec_path, run.workspace_path);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    // Step 3: Update published page
    try {
      await this.deps.specPublisher.update(run.publisher_ref, run.spec_path);
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
      try {
        await this.deps.feedbackSource.resolve(run.publisher_ref, commentResponses.map(r => r.comment_id));
      } catch (err) {
        this.logger.error({ event: 'run.resolve_failed', run_id: run.id, error: String(err) }, 'Failed to resolve Notion comments');
      }
    }

    this.transition(run, 'review');
  }
}
