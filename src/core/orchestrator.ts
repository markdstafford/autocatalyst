// src/core/orchestrator.ts
import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { createLogger } from './logger.js';
import type { SlackAdapter } from '../adapters/slack/slack-adapter.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { SpecGenerator, ReviseResult } from '../adapters/agent/spec-generator.js';
import { titleFromPath } from '../types/publisher.js';
import type { SpecPublisher } from '../types/publisher.js';
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
import type { IssueManager } from '../adapters/agent/issue-manager.js';
import type { IssueFiler, FilingResult } from '../adapters/agent/issue-filer.js';
import { RunStore, FileRunStore } from './run-store.js';
import type { ThreadRegistry } from '../adapters/slack/thread-registry.js';

function extractH1(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/** Maps an actionable review stage to the in-progress stage that prevents duplicate dispatch. */
function stageAfterApproval(stage: RunStage): RunStage {
  if (stage === 'reviewing_spec') return 'implementing';
  if (stage === 'reviewing_implementation') return 'implementing';
  if (stage === 'awaiting_impl_input') return 'implementing';
  return stage;
}

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
  issueManager?: IssueManager;
  issueFiler?: IssueFiler;
  runStore?: RunStore;
  threadRegistry?: ThreadRegistry;
  postError: (channel_id: string, thread_ts: string, text: string) => Promise<void>;
  postMessage: (channel_id: string, thread_ts: string, text: string) => Promise<void>;
  repo_url: string;
}

interface OrchestratorOptions {
  logDestination?: pino.DestinationStream;
  maxConcurrentRuns?: number; // default: 5
}

export class OrchestratorImpl implements Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly logger: pino.Logger;
  private readonly runs = new Map<string, Run>();
  private _stopping = false;
  private _loopPromise: Promise<void> = Promise.resolve();
  private _inFlight = new Set<Promise<void>>();
  private _queue: InboundEvent[] = [];
  private readonly _maxConcurrentRuns: number;
  /** Maps request_id → the run stage that was current when _classify dispatched the event.
   *  Stored before _classify advances the stage; read and deleted by _handleRequest for routing. */
  private _pendingStage = new Map<string, RunStage>();
  /** Maps queued InboundEvent reference → enqueue timestamp (ms) for queue_wait_ms metric. */
  private _queueTimestamps = new Map<InboundEvent, number>();

  constructor(deps: OrchestratorDeps, options?: OrchestratorOptions) {
    this.deps = deps;
    this.logger = createLogger('orchestrator', { destination: options?.logDestination });
    this._maxConcurrentRuns = options?.maxConcurrentRuns ?? 5;
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
      // Classification is serial and awaited: advances run state and commits the
      // dispatch decision before the next event is processed. Prevents duplicate
      // or conflicting dispatches for the same run (e.g., double-approval).
      const action = await this._classify(event as InboundEvent);
      if (action === 'dispatch') {
        this._dispatchOrEnqueue(event as InboundEvent);
      }
    }
    // Drain all in-flight handlers before resolving (including those promoted from queue)
    while (this._inFlight.size > 0) {
      await Promise.allSettled([...this._inFlight]);
    }
  }

  /**
   * Classifies an event and decides whether to dispatch a heavy handler.
   * Runs serially in the main loop — this is the deduplication gate.
   *
   * For new_request events: always returns 'dispatch'.
   * For thread_message events: checks the run's current stage. If the action is
   * valid, stores the original stage in _pendingStage (for routing in _handleRequest),
   * advances the stage atomically before returning 'dispatch' so that a concurrent
   * duplicate message sees the updated stage and is discarded.
   */
  private async _classify(event: InboundEvent): Promise<'dispatch' | 'discard'> {
    if (event.type === 'new_request') {
      return 'dispatch';
    }
    // thread_message path: look up run and check stage
    const run = this.runs.get(event.payload.request_id);
    if (!run) {
      this.logger.debug({ event: 'classify.run_not_found', request_id: event.payload.request_id }, 'No run found; discarding');
      return 'discard';
    }
    const actionableStages: RunStage[] = ['reviewing_spec', 'reviewing_implementation', 'awaiting_impl_input'];
    if (!actionableStages.includes(run.stage)) {
      this.logger.debug({ event: 'classify.stage_blocked', stage: run.stage }, 'Stage blocked: discarding thread_message');
      return 'discard';
    }
    // Store original stage for routing in _handleRequest before advancing
    this._pendingStage.set(event.payload.request_id, run.stage);
    // Advance stage here — prevents a duplicate message from also dispatching
    run.stage = stageAfterApproval(run.stage);
    this.logger.debug({ event: 'classify.dispatched', stage: run.stage }, 'Stage advanced; dispatching');
    return 'dispatch';
  }

  private _dispatchOrEnqueue(event: InboundEvent): void {
    if (this._inFlight.size >= this._maxConcurrentRuns) {
      this._queueTimestamps.set(event, Date.now());
      this._queue.push(event);
      // Notify user their request has been queued (best-effort; new_request only)
      if (event.type === 'new_request') {
        const { channel_id, thread_ts } = event.payload;
        this.deps.postMessage(channel_id, thread_ts,
          'The system is at capacity right now — your request has been queued and will start shortly.',
        ).catch(err => {
          this.logger.error({ event: 'run.notify_failed', error: String(err) }, 'Failed to post queue notification');
        });
      }
      this.logger.warn({ event: 'run.queued', queue_depth: this._queue.length }, 'Concurrency limit reached; event queued');
      this.logger.info({ metric: 'orchestrator.queue_depth', value: this._queue.length }, 'queue_depth gauge (enqueue)');
      return;
    }
    this._launch(event);
  }

  private _launch(event: InboundEvent): void {
    let p: Promise<void>;
    p = this._handleRequest(event)
      .catch(err => {
        this.logger.error({ event: 'run.unhandled_error', error: String(err) }, 'Unhandled error in request handler');
      })
      .finally(() => {
        this._inFlight.delete(p);
        this.logger.info({ metric: 'orchestrator.in_flight', value: this._inFlight.size }, 'in_flight gauge (release)');
        // Dequeue next event if any
        const next = this._queue.shift();
        if (next) {
          const enqueuedAt = this._queueTimestamps.get(next);
          this._queueTimestamps.delete(next);
          const waitMs = enqueuedAt !== undefined ? Date.now() - enqueuedAt : 0;
          this.logger.debug({ event: 'run.dequeued', in_flight: this._inFlight.size, queue_depth: this._queue.length }, 'Dequeued event; dispatching');
          this.logger.info({ metric: 'orchestrator.queue_wait_ms', value: waitMs }, 'queue_wait_ms histogram');
          this.logger.info({ metric: 'orchestrator.queue_depth', value: this._queue.length }, 'queue_depth gauge (dequeue)');
          this._launch(next);
        }
      });
    this._inFlight.add(p);
    this.logger.debug({ event: 'run.dispatched', in_flight: this._inFlight.size }, 'Handler dispatched');
    this.logger.info({ metric: 'orchestrator.in_flight', value: this._inFlight.size }, 'in_flight gauge (dispatch)');
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
        await this._startTriagePipeline(run, request, 'bug');
      } else if (intent === 'chore') {
        run.intent = 'chore';
        this._persistRuns();
        await this._startTriagePipeline(run, request, 'chore');
      } else if (intent === 'file_issues') {
        run.intent = 'file_issues';
        this._persistRuns();
        await this._startFilingPipeline(run, request);
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
        // Safety net: _classify already checked this
        this.logger.debug({ event: 'thread_message.discarded', request_id: feedback.request_id, reason: 'no_run' }, 'No run for request_id; discarding');
        return;
      }

      // Retrieve and clear the routing stage stored by _classify before it advanced run.stage.
      // This preserves the original stage for correct intent × stage routing below.
      const routingStage = this._pendingStage.get(feedback.request_id) ?? run.stage;
      this._pendingStage.delete(feedback.request_id);

      // _classify has already validated the stage and advanced it for deduplication.
      // Classify intent using the original (routing) stage as context.
      let intent: Intent = 'feedback';
      if (this.deps.intentClassifier) {
        const context: ClassificationContext = routingStage as ClassificationContext;
        try {
          intent = await this.deps.intentClassifier.classify(feedback.content, context);
        } catch (err) {
          this.logger.warn({ event: 'intent_classification.failed', run_id: run.id, error: String(err) }, 'Intent classification failed; defaulting to feedback');
          intent = 'feedback';
        }
        this.logger.debug({ event: 'intent_classification.result', run_id: run.id, intent, stage: routingStage }, 'Intent classified');
      }

      // Route by intent × routingStage
      if (intent === 'feedback') {
        if (routingStage === 'reviewing_spec') {
          await this._handleSpecFeedback(feedback);
        } else if (routingStage === 'reviewing_implementation' || routingStage === 'awaiting_impl_input') {
          await this._handleImplementationFeedback(feedback, run, routingStage);
        }
      } else if (intent === 'approval') {
        if (routingStage === 'reviewing_spec') {
          await this._handleSpecApproval(feedback, run);
        } else if (routingStage === 'reviewing_implementation') {
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
      const ackMsg = (run.intent === 'bug' || run.intent === 'chore')
        ? 'Approved \u2014 writing triage to issue and starting implementation.'
        : 'Approved \u2014 committing spec and starting implementation.';
      await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, ackMsg);
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post approval acknowledgement');
    }

    if (run.intent === 'bug' || run.intent === 'chore') {
      // Bug / chore approval path: fetch from Notion, write to GitHub issue

      // Step 2: Fetch triage content from Notion (canonical reviewed version)
      let triageContent: string;
      try {
        triageContent = await this.deps.specPublisher.getPageMarkdown(run.publisher_ref);
      } catch (err) {
        await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
        return;
      }

      // Step 3: Write to GitHub issue (create new if none associated with this run)
      let issue_number: number;
      try {
        if (run.issue) {
          await this.deps.issueManager!.writeIssue(run.workspace_path, run.issue, triageContent);
          issue_number = run.issue;
        } else {
          const title = extractH1(triageContent) ?? `${run.intent} triage`;
          issue_number = await this.deps.issueManager!.createIssue(run.workspace_path, title, triageContent);
          run.issue = issue_number;
          this._persistRuns();
        }
      } catch (err) {
        await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
        return;
      }

      this.logger.info(
        { event: 'triage.approved', run_id: run.id, request_id: run.request_id, intent: run.intent, issue_number },
        'Triage approved',
      );

      const issue_url = `${this.deps.repo_url}/issues/${issue_number}`;

      // Step 4: Update Notion page properties (best-effort — non-blocking)
      await Promise.allSettled([
        this.deps.specPublisher.setIssueLink?.(run.publisher_ref, issue_url),
        this.deps.specPublisher.updateStatus?.(run.publisher_ref, 'Approved'),
      ]).then(results => {
        for (const r of results) {
          if (r.status === 'rejected') {
            this.logger.error(
              { event: 'run.status_update_failed', run_id: run.id, error: String(r.reason) },
              'Failed to update triage document properties',
            );
          }
        }
      });
    } else {
      // Idea approval path: commit spec file to workspace

      // Step 2: Commit spec to workspace
      try {
        await this.deps.specCommitter!.commit(run.workspace_path, run.publisher_ref, run.spec_path);
      } catch (err) {
        await this.failRun(run, feedback.channel_id, feedback.thread_ts, err);
        return;
      }

      // Step 3: Update status to Approved (best-effort)
      await this.deps.specPublisher.updateStatus?.(run.publisher_ref!, 'Approved').catch(err =>
        this.logger.error(
          { event: 'run.status_update_failed', run_id: run.id, status: 'Approved', error: String(err) },
          'Failed to update spec status',
        ),
      );
    }

    // Run implementation (both paths)
    await this._runImplementation(feedback, run);
  }

  private async _runImplementation(feedback: ThreadMessage, run: Run, additional_context?: string): Promise<void> {
    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(feedback.channel_id, feedback.thread_ts, message).catch(err => {
        this.logger.warn(
          { event: 'progress_failed', phase: 'implementation', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    if (run.impl_feedback_ref) {
      await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'In progress').catch(err =>
        this.logger.error(
          { event: 'run.status_update_failed', run_id: run.id, status: 'In progress', error: String(err) },
          'Failed to update testing guide status',
        ),
      );
    }

    let result;
    try {
      result = await this.deps.implementer!.implement(
        run.spec_path!,
        run.workspace_path,
        additional_context,
        onProgress,
      );
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
        titleFromPath(run.spec_path!),
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

    if (run.impl_feedback_ref) {
      await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'Waiting on feedback').catch(err =>
        this.logger.error(
          { event: 'run.status_update_failed', run_id: run.id, status: 'Waiting on feedback', error: String(err) },
          'Failed to update testing guide status',
        ),
      );
    }

    this.transition(run, 'reviewing_implementation');
  }

  private async _handleImplementationFeedback(feedback: ThreadMessage, run: Run, routingStage: RunStage = run.stage): Promise<void> {
    const wasAwaiting = routingStage === 'awaiting_impl_input';

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

    // Step 3: Update statuses (best-effort, all in parallel)
    if (run.impl_feedback_ref) {
      await Promise.allSettled([
        this.deps.implFeedbackPage?.setPRLink?.(run.impl_feedback_ref, prUrl),
        this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'Approved'),
        this.deps.specPublisher.updateStatus?.(run.publisher_ref!, 'Complete'),
      ]).then(results => {
        for (const r of results) {
          if (r.status === 'rejected') {
            this.logger.error(
              { event: 'run.status_update_failed', run_id: run.id, error: String(r.reason) },
              'Failed to update status on implementation approval',
            );
          }
        }
      });
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
      issue: undefined,
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
    const specCreateProgress = (message: string): Promise<void> =>
      this.deps.postMessage(request.channel_id, request.thread_ts, message).catch(err => {
        this.logger.warn(
          { event: 'progress_failed', phase: 'spec_generation', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    let spec_path: string;
    try {
      spec_path = await this.deps.specGenerator.create(request, workspace_path, specCreateProgress);
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
    await this.deps.specPublisher.updateStatus?.(run.publisher_ref!, 'Waiting on feedback').catch(err =>
      this.logger.error(
        { event: 'run.status_update_failed', run_id: run.id, status: 'Waiting on feedback', error: String(err) },
        'Failed to update spec status',
      ),
    );
  }

  private async _startTriagePipeline(run: Run, request: Request, intent: 'bug' | 'chore'): Promise<void> {
    this.transition(run, 'speccing');
    this.logger.info(
      { event: 'triage.started', run_id: run.id, request_id: run.request_id, intent },
      'Triage started',
    );

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

    // Step 2: Generate triage document
    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(request.channel_id, request.thread_ts, message).catch(err => {
        this.logger.warn(
          { event: 'progress_failed', phase: 'triage_generation', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    let spec_path: string;
    try {
      spec_path = await this.deps.specGenerator.create(request, workspace_path, onProgress, intent);
      run.spec_path = spec_path;
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, request.channel_id, request.thread_ts, err);
      return;
    }

    // Step 3: Publish triage document
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
    this.logger.info(
      { event: 'triage.complete', run_id: run.id, request_id: run.request_id, intent, publisher_ref },
      'Triage complete',
    );
    await this.deps.specPublisher.updateStatus?.(run.publisher_ref!, 'Waiting on feedback').catch(err =>
      this.logger.error(
        { event: 'run.status_update_failed', run_id: run.id, status: 'Waiting on feedback', error: String(err) },
        'Failed to update triage document status',
      ),
    );
  }

  private async _startFilingPipeline(run: Run, request: Request): Promise<void> {
    this.transition(run, 'speccing');
    this.logger.info(
      { event: 'filing.started', run_id: run.id, request_id: run.request_id },
      'Filing pipeline started',
    );

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

    // Step 2: Acknowledge (best-effort)
    try {
      await this.deps.postMessage(request.channel_id, request.thread_ts, 'On it — investigating and filing issues...');
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post acknowledgment');
    }

    // Step 3: File issues (enrichment + creation)
    const onProgress = (message: string): Promise<void> =>
      this.deps.postMessage(request.channel_id, request.thread_ts, message).catch(err => {
        this.logger.warn(
          { event: 'progress_failed', phase: 'filing', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    let result: FilingResult;
    try {
      result = await this.deps.issueFiler!.file(request, workspace_path, onProgress);
    } catch (err) {
      await this.deps.workspaceManager.destroy(workspace_path);
      await this.failRun(run, request.channel_id, request.thread_ts, err);
      return;
    }

    // Step 4: Emit per-issue events
    for (const issue of result.filed_issues) {
      if (issue.action === 'filed') {
        this.logger.info(
          { event: 'filing.issue_filed', run_id: run.id, request_id: run.request_id, issue_number: issue.number, issue_title: issue.title },
          'Issue filed',
        );
      } else {
        this.logger.info(
          { event: 'filing.duplicate_detected', run_id: run.id, request_id: run.request_id, existing_issue_number: issue.number, existing_issue_title: issue.title },
          'Duplicate issue detected',
        );
      }
    }

    // Step 5: Destroy workspace (no implementation follows)
    await this.deps.workspaceManager.destroy(workspace_path).catch(err =>
      this.logger.warn({ event: 'workspace.destroy_failed', run_id: run.id, error: String(err) }, 'Failed to destroy workspace after filing'),
    );

    if (result.status === 'failed') {
      await this.failRun(run, request.channel_id, request.thread_ts, new Error(result.error ?? 'Filing failed'));
      return;
    }

    // Step 6: Post summary
    try {
      await this.deps.postMessage(request.channel_id, request.thread_ts, result.summary);
    } catch (err) {
      this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post filing summary');
    }

    const filed_count = result.filed_issues.filter(i => i.action === 'filed').length;
    const duplicate_count = result.filed_issues.filter(i => i.action === 'duplicate').length;
    this.logger.info(
      { event: 'filing.complete', run_id: run.id, request_id: run.request_id, filed_count, duplicate_count },
      'Filing pipeline complete',
    );
    this.transition(run, 'done');
  }

  private async _handleSpecFeedback(feedback: ThreadMessage): Promise<void> {
    const run = this.runs.get(feedback.request_id);
    if (!run) return; // safety net

    if (!run.spec_path || !run.publisher_ref) {
      await this.failRun(run, feedback.channel_id, feedback.thread_ts, new Error('Run in review state is missing spec_path or publisher_ref'));
      return;
    }

    this.transition(run, 'speccing');
    await this.deps.specPublisher.updateStatus?.(run.publisher_ref!, 'Speccing').catch(err =>
      this.logger.error(
        { event: 'run.status_update_failed', run_id: run.id, status: 'Speccing', error: String(err) },
        'Failed to update spec status',
      ),
    );
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
    const specReviseProgress = (message: string): Promise<void> =>
      this.deps.postMessage(feedback.channel_id, feedback.thread_ts, message).catch(err => {
        this.logger.warn(
          { event: 'progress_failed', phase: 'spec_generation', run_id: run.id, error: String(err) },
          'Failed to post progress update',
        );
      });

    let result: ReviseResult;
    try {
      result = await this.deps.specGenerator.revise(feedback, notionComments, run.spec_path, run.workspace_path, pageMarkdown, specReviseProgress);
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
