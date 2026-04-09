// src/core/orchestrator.ts
import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { createLogger } from './logger.js';
import type { SlackAdapter } from '../adapters/slack/slack-adapter.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { SpecGenerator } from '../adapters/agent/spec-generator.js';
import type { CanvasPublisher } from '../adapters/slack/canvas-publisher.js';
import type { Run, RunStage } from '../types/runs.js';
import type { Idea, SpecFeedback } from '../types/events.js';

export interface Orchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface OrchestratorDeps {
  adapter: SlackAdapter;
  workspaceManager: WorkspaceManager;
  specGenerator: SpecGenerator;
  canvasPublisher: CanvasPublisher;
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
      canvas_id: undefined,
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
    let canvas_id: string;
    try {
      canvas_id = await this.deps.canvasPublisher.create(idea.channel_id, idea.thread_ts, spec_path);
      run.canvas_id = canvas_id;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, idea.channel_id, idea.thread_ts, err);
      return;
    }

    this.transition(run, 'review');
  }

  private async _handleSpecFeedback(feedback: SpecFeedback): Promise<void> {
    const run = this.runs.get(feedback.idea_id);
    if (!run || run.stage !== 'review') return; // discard if not found or not in review

    if (!run.spec_path || !run.canvas_id) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, new Error('Run in review state is missing spec_path or canvas_id'));
      return;
    }

    this.transition(run, 'speccing');
    run.attempt += 1;

    // Step 1: Revise spec
    try {
      await this.deps.specGenerator.revise(feedback, run.spec_path, run.workspace_path);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    // Note: workspace is intentionally NOT destroyed on revision failure — preserve it for debugging.
    // This differs from new-idea failures where the workspace is always cleaned up.

    // Step 2: Update canvas
    try {
      await this.deps.canvasPublisher.update(run.canvas_id, run.spec_path);
    } catch (err) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
      return;
    }

    this.transition(run, 'review');
  }
}
