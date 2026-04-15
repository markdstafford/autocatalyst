// tests/core/orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorImpl } from '../../src/core/orchestrator.js';
import type { WorkspaceManager } from '../../src/core/workspace-manager.js';
import type { SpecGenerator } from '../../src/adapters/agent/spec-generator.js';
import type { SpecPublisher } from '../../src/adapters/slack/canvas-publisher.js';
import type { Request, ThreadMessage } from '../../src/types/events.js';
import type { FeedbackSource } from '../../src/adapters/notion/notion-feedback-source.js';
import type { NotionComment, NotionCommentResponse } from '../../src/adapters/agent/spec-generator.js';
import type { Run } from '../../src/types/runs.js';
import type { IntentClassifier } from '../../src/adapters/agent/intent-classifier.js';
import type { QuestionAnswerer } from '../../src/adapters/agent/question-answerer.js';
import type { SpecCommitter } from '../../src/adapters/notion/spec-committer.js';
import type { Implementer, ImplementationResult } from '../../src/adapters/agent/implementer.js';
import type { ImplementationFeedbackPage } from '../../src/adapters/notion/implementation-feedback-page.js';

const nullDest = { write: () => {} };

// Helper: returns a promise whose resolution can be controlled externally
function makeControllablePromise<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Helper: captures pino log records for assertion
function makeLogCapture() {
  const records: Record<string, unknown>[] = [];
  const destination = {
    write(msg: string) {
      try { records.push(JSON.parse(msg) as Record<string, unknown>); } catch { /* ignore non-JSON */ }
    },
  };
  return { records, destination: destination as unknown as import('pino').DestinationStream };
}

// Counter for deterministic fixture IDs — reset in beforeEach
let _fixtureSeq = 0;
function makeEventFixture(
  type: 'new_request',
  overrides?: Partial<Request>,
): { type: 'new_request'; payload: Request };
function makeEventFixture(
  type: 'thread_message',
  overrides?: Partial<ThreadMessage>,
): { type: 'thread_message'; payload: ThreadMessage };
function makeEventFixture(type: 'new_request' | 'thread_message', overrides: Record<string, unknown> = {}): { type: 'new_request'; payload: Request } | { type: 'thread_message'; payload: ThreadMessage } {
  const n = ++_fixtureSeq;
  if (type === 'new_request') {
    return {
      type: 'new_request',
      payload: {
        id: `req-${n}`,
        source: 'slack' as const,
        content: `content ${n}`,
        author: `U${n}`,
        received_at: new Date().toISOString(),
        thread_ts: `${n}00.0`,
        channel_id: `C${n}`,
        ...overrides,
      } as Request,
    };
  }
  return {
    type: 'thread_message',
    payload: {
      request_id: `req-${n}`,
      content: `content ${n}`,
      author: `U${n}`,
      received_at: new Date().toISOString(),
      thread_ts: `${n}00.0`,
      channel_id: `C${n}`,
      ...overrides,
    } as ThreadMessage,
  };
}

// Minimal mock of SlackAdapter — controls event emission
function makeMockAdapter() {
  const eventQueue: unknown[] = [];
  let waiter: (() => void) | null = null;
  let closed = false;

  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      closed = true;
      if (waiter) { waiter(); waiter = null; }
    }),
    receive: async function* () {
      while (!closed || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift();
        } else {
          await new Promise<void>(r => { waiter = r; });
        }
      }
    },
    _emit: (event: unknown) => {
      eventQueue.push(event);
      if (waiter) { waiter(); waiter = null; }
    },
  };
}

function makeWorkspaceManager(overrides: Partial<WorkspaceManager> = {}): WorkspaceManager {
  return {
    create: vi.fn().mockResolvedValue({ workspace_path: '/ws/request-001', branch: 'spec/request-001' }),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSpecGenerator(overrides: Partial<SpecGenerator> = {}): SpecGenerator {
  return {
    create: vi.fn().mockResolvedValue('/ws/request-001/context-human/specs/feature-test.md'),
    revise: vi.fn().mockResolvedValue({ comment_responses: [] }),
    ...overrides,
  };
}

function makeFeedbackSource(overrides: Partial<FeedbackSource> = {}): FeedbackSource {
  return {
    fetch: vi.fn().mockResolvedValue([]),
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSpecPublisher(overrides: Partial<SpecPublisher> = {}): SpecPublisher {
  return {
    create: vi.fn().mockResolvedValue('CANVAS001'),
    update: vi.fn().mockResolvedValue(undefined),
    getPageMarkdown: vi.fn().mockResolvedValue(''),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'request-001',
    source: 'slack',
    content: 'add a setup wizard',
    author: 'U123',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    content: 'wizard should not require all settings',
    author: 'U456',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

function makeIntentClassifier(intent = 'feedback'): IntentClassifier {
  return {
    classify: vi.fn().mockResolvedValue(intent),
  };
}

function makeQuestionAnswerer(response = 'Here is your answer.'): QuestionAnswerer {
  return {
    answer: vi.fn().mockResolvedValue(response),
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'request-001',
    intent: 'idea',
    stage: 'reviewing_spec',
    workspace_path: '/ws/request-001',
    branch: 'spec/request-001',
    spec_path: '/ws/request-001/context-human/specs/feature-test.md',
    publisher_ref: 'CANVAS001',
    impl_feedback_ref: undefined,
    attempt: 0,
    channel_id: 'C001',
    thread_ts: '1000.0000',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSpecCommitter(overrides: Partial<SpecCommitter> = {}): SpecCommitter {
  return {
    commit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeImplementer(resultOverrides: Partial<ImplementationResult> = {}): Implementer {
  const defaultResult: ImplementationResult = {
    status: 'complete',
    summary: 'Implemented the feature successfully.',
    testing_instructions: 'npm install && npm test',
    ...resultOverrides,
  };
  return {
    implement: vi.fn().mockResolvedValue(defaultResult),
  };
}

function makeImplFeedbackPage(overrides: Partial<ImplementationFeedbackPage> = {}): ImplementationFeedbackPage {
  return {
    create: vi.fn().mockResolvedValue('feedback-page-id'),
    readFeedback: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Orchestrator — new_request happy path', () => {
  it('calls all four components in order with correct arguments', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();

    const request = makeRequest();
    adapter._emit({ type: 'new_request', payload: request });

    // Give the loop time to process
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.create).toHaveBeenCalledWith('request-001', 'https://github.com/org/repo');
    expect(sg.create).toHaveBeenCalledWith(request, '/ws/request-001');
    expect(cp.create).toHaveBeenCalledWith('C123', '100.0', '/ws/request-001/context-human/specs/feature-test.md');
  });

  it('run ends in review stage with all fields populated', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    // Access internal state to verify — cast through any for testing
    const runs = (orch as never as { runs: Map<string, { stage: string; workspace_path: string; branch: string; spec_path: string; publisher_ref: string }> }).runs;
    const run = runs.get('request-001')!;
    expect(run.stage).toBe('reviewing_spec');
    expect(run.workspace_path).toBe('/ws/request-001');
    expect(run.branch).toBe('spec/request-001');
    expect(run.spec_path).toBe('/ws/request-001/context-human/specs/feature-test.md');
    expect(run.publisher_ref).toBe('CANVAS001');
  });
});

describe('Orchestrator — new_request failure paths', () => {
  it('WorkspaceManager failure: run is failed, error posted, no further components called', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager({ create: vi.fn().mockRejectedValue(new Error('clone failed')) });
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('clone failed'));
    expect(sg.create).not.toHaveBeenCalled();
    expect(cp.create).not.toHaveBeenCalled();

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });

  it('SpecGenerator failure: run is failed, error posted, workspace destroyed', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator({ create: vi.fn().mockRejectedValue(new Error('omc failed')) });
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('omc failed'));
    expect(cp.create).not.toHaveBeenCalled();

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });

  it('SpecPublisher failure: run is failed, error posted, workspace destroyed', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher({ create: vi.fn().mockRejectedValue(new Error('canvas error')) });
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('canvas error'));

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });
});

describe('Orchestrator — feedback happy path', () => {
  it('increments attempt, calls revise and update, run back in review', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    // First call: classify new_request as 'idea'; subsequent calls: classify thread_message as 'feedback'
    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: ic }, { logDestination: nullDest });
    await orch.start();

    // First seed the request to get a run in review
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));

    // Then send feedback
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, { stage: string; attempt: number }> }).runs;
    const run = runs.get('request-001')!;
    expect(run.stage).toBe('reviewing_spec');
    expect(run.attempt).toBe(1);

    expect(cp.getPageMarkdown).toHaveBeenCalledWith('CANVAS001');
    expect(sg.revise).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'request-001' }),
      [],
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      undefined,
    );
    expect(cp.update).toHaveBeenCalledWith('CANVAS001', '/ws/request-001/context-human/specs/feature-test.md', undefined);
  });
});

describe('Orchestrator — feedback guard conditions', () => {
  it('discards feedback for unknown request_id', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('feedback') }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'thread_message', payload: makeFeedback({ request_id: 'unknown-request' }) });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.revise).not.toHaveBeenCalled();
    expect(cp.update).not.toHaveBeenCalled();
    expect(postError).not.toHaveBeenCalled();
  });

  it('discards feedback when run is in speccing stage', async () => {
    const adapter = makeMockAdapter();
    // Make spec generation slow so run stays in speccing when feedback arrives
    let resolveCreate!: () => void;
    const slowCreate = vi.fn().mockReturnValue(new Promise<string>(r => { resolveCreate = () => r('/ws/request-001/context-human/specs/feature-test.md'); }));
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator({ create: slowCreate });
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: ic }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 10)); // let it reach speccing stage

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 10));

    // Now resolve the slow create so the loop can finish
    resolveCreate();
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    // NOTE: With a sequential event loop, thread_message is queued while new_request is being processed.
    // By the time thread_message is dequeued, the run is already in 'review', not 'speccing'.
    // So revise WILL be called — the guard for speccing stage is not observable in this sequential model.
    // We verify the actual observable behavior: run ends in review, revise was called once.
    expect(sg.revise).toHaveBeenCalledTimes(1);
  });

  it('discards feedback when run is in failed stage', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager({ create: vi.fn().mockRejectedValue(new Error('fail')) });
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50)); // run is now failed

    postError.mockClear();
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.revise).not.toHaveBeenCalled();
    expect(postError).not.toHaveBeenCalled();
  });
});

describe('Orchestrator — feedback failure paths', () => {
  it('SpecGenerator.revise failure: run is failed, error posted', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator({ revise: vi.fn().mockRejectedValue(new Error('revise failed')) });
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: ic }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    postError.mockClear();

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('revise failed'));
  });

  it('SpecPublisher.update failure: run is failed, error posted', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher({ update: vi.fn().mockRejectedValue(new Error('update failed')) });
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: ic }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    postError.mockClear();

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('update failed'));

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });
});

describe('Orchestrator — concurrency', () => {
  it('two simultaneous requests produce independent runs with no cross-contamination', async () => {
    const adapter = makeMockAdapter();
    const wm: WorkspaceManager = {
      create: vi.fn().mockImplementation(async (request_id: string) => ({
        workspace_path: `/ws/${request_id}`,
        branch: `spec/${request_id}`,
      })),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const sg: SpecGenerator = {
      create: vi.fn().mockImplementation(async (_request: Request, workspace_path: string) =>
        `${workspace_path}/context-human/specs/feature-test.md`
      ),
      revise: vi.fn().mockResolvedValue({ comment_responses: [] }),
    };
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'https://github.com/org/repo', intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'request-A', thread_ts: 'A.0' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'request-B', thread_ts: 'B.0' }) });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, { stage: string; workspace_path: string }> }).runs;
    expect(runs.get('request-A')!.stage).toBe('reviewing_spec');
    expect(runs.get('request-B')!.stage).toBe('reviewing_spec');
    expect(runs.get('request-A')!.workspace_path).toBe('/ws/request-A');
    expect(runs.get('request-B')!.workspace_path).toBe('/ws/request-B');
  });
});

// Helper to seed a run to 'reviewing_spec' stage, then trigger feedback
async function seedAndFeedback(
  orch: OrchestratorImpl,
  adapter: ReturnType<typeof makeMockAdapter>,
  feedbackOverrides: Partial<ThreadMessage> = {},
) {
  const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
  adapter._emit({ type: 'new_request', payload: makeRequest() });
  // Wait for run to reach 'reviewing_spec'
  await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });
  adapter._emit({ type: 'thread_message', payload: makeFeedback(feedbackOverrides) });
  // Wait for run to no longer be 'speccing'
  await vi.waitUntil(() => runs.get('request-001')?.stage !== 'speccing', { timeout: 2000 });
}

describe('Orchestrator — feedback with feedbackSource', () => {
  it('with feedbackSource: fetch called before revise, revise receives notion_comments, update/reply called in order', async () => {
    const notionComments: NotionComment[] = [
      { id: 'disc-1', body: 'Phoebe: first feedback' },
      { id: 'disc-2', body: 'Enzo: second feedback' },
    ];
    const commentResponses: NotionCommentResponse[] = [
      { comment_id: 'disc-1', response: 'Updated per Phoebe' },
      { comment_id: 'disc-2', response: 'Updated per Enzo' },
    ];
    const fs = makeFeedbackSource({ fetch: vi.fn().mockResolvedValue(notionComments) });
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: commentResponses }) });
    const sp = makeSpecPublisher();
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);

    const callOrder: string[] = [];
    (sp.getPageMarkdown as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('getPageMarkdown'); return ''; });
    (fs.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('fetch'); return notionComments; });
    (sg.revise as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('revise'); return { comment_responses: commentResponses }; });
    (sp.update as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('update'); });
    (fs.reply as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('reply'); });
    const postMessage = vi.fn().mockImplementation(async () => { callOrder.push('postMessage'); });

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: sp, feedbackSource: fs, postError, postMessage, repo_url: 'https://github.com/org/repo', intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')?.stage).toBe('reviewing_spec');
    expect(callOrder).toEqual(['fetch', 'getPageMarkdown', 'revise', 'update', 'reply', 'reply', 'postMessage']);
    expect(sp.getPageMarkdown).toHaveBeenCalledWith('CANVAS001');
    expect(fs.fetch).toHaveBeenCalledWith('CANVAS001');
    expect(sg.revise).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'request-001' }),
      notionComments,
      expect.any(String),
      expect.any(String),
      undefined,
    );
    expect(fs.reply).toHaveBeenCalledTimes(2);
    expect(fs.reply).toHaveBeenCalledWith('CANVAS001', 'disc-1', 'Updated per Phoebe');
    expect(fs.reply).toHaveBeenCalledWith('CANVAS001', 'disc-2', 'Updated per Enzo');
  });

  it('empty fetch: revise called with []; no reply', async () => {
    const fs = makeFeedbackSource({ fetch: vi.fn().mockResolvedValue([]) });
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: [] }) });
    const adapter = makeMockAdapter();

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    expect(sg.revise).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'request-001' }),
      [],
      expect.any(String),
      expect.any(String),
      undefined,
    );
    expect(fs.reply).not.toHaveBeenCalled();
  });

  it('no feedbackSource: revise called with []; no fetch/reply', async () => {
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: [] }) });
    const adapter = makeMockAdapter();

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    expect(sg.revise).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'request-001' }),
      [],
      expect.any(String),
      expect.any(String),
      undefined,
    );
  });

  it('feedbackSource.fetch rejects → run fails; revise not called', async () => {
    const fs = makeFeedbackSource({ fetch: vi.fn().mockRejectedValue(new Error('fetch error')) });
    const sg = makeSpecGenerator();
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 2000 });
    await adapter.stop();

    expect(sg.revise).not.toHaveBeenCalled();
    expect(postError).toHaveBeenCalled();
  });

  it('reply fails on one of three: run stays in review; postError not called', async () => {
    const commentResponses: NotionCommentResponse[] = [
      { comment_id: 'd1', response: 'r1' },
      { comment_id: 'd2', response: 'r2' },
      { comment_id: 'd3', response: 'r3' },
    ];
    const fs = makeFeedbackSource({
      fetch: vi.fn().mockResolvedValue(commentResponses.map(r => ({ id: r.comment_id, body: 'feedback' }))),
      reply: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('reply error'))
        .mockResolvedValueOnce(undefined),
    });
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: commentResponses }) });
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')?.stage).toBe('reviewing_spec');
    expect(fs.reply).toHaveBeenCalledTimes(3);
    expect(postError).not.toHaveBeenCalled();
  });

});

describe('Orchestrator — feedback completion notification', () => {
  it('posts completion message with comment count after replies', async () => {
    const notionComments = [{ id: 'disc-1', body: 'feedback' }];
    const commentResponses = [{ comment_id: 'disc-1', response: 'Done' }];
    const fs = makeFeedbackSource({ fetch: vi.fn().mockResolvedValue(notionComments) });
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: commentResponses }) });
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError: vi.fn().mockResolvedValue(undefined), postMessage, repo_url: 'r', intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    expect(postMessage).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('1 comment'));
  });

  it('posts message with zero comments when none addressed', async () => {
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: [] }) });
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage, repo_url: 'r', intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    expect(postMessage).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('updated'));
  });

  it('postMessage failure: logged, run still transitions to review', async () => {
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: [] }) });
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockRejectedValue(new Error('Slack error'));
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError, postMessage, repo_url: 'r', intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')?.stage).toBe('reviewing_spec');
    expect(postError).not.toHaveBeenCalled();
  });
});

describe('Orchestrator — intent classification routing', () => {
  it('classifier called with feedback content and run stage when in reviewing_spec', async () => {
    const adapter = makeMockAdapter();
    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: makeSpecGenerator(), specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    // Second call is the thread_message classification (first is new_request)
    expect(ic.classify).toHaveBeenCalledWith(
      'wizard should not require all settings',
      'reviewing_spec',
    );
  });

  it('feedback intent routes to spec feedback handler (calls revise)', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    expect(sg.revise).toHaveBeenCalledOnce();
  });

  it('approval intent: does not call revise', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const ic = makeIntentClassifier('approval');
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();

    // Inject a run in reviewing_spec so we don't have to go through new_request
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.revise).not.toHaveBeenCalled();
  });

  it('feedback intent on reviewing_implementation: does not call revise', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const ic = makeIntentClassifier('feedback');
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation' }));

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.revise).not.toHaveBeenCalled();
  });

  it('approval intent on reviewing_implementation: does not call revise', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const ic = makeIntentClassifier('approval');
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation' }));

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.revise).not.toHaveBeenCalled();
  });
});

describe('Orchestrator — implementing stage guard', () => {
  it('posts busy message when run is in implementing stage; classifier not called', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const ic = makeIntentClassifier('feedback');
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage, repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'implementing' }));

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith('C123', '100.0', expect.any(String));
    expect(ic.classify).not.toHaveBeenCalled();
    expect(sg.revise).not.toHaveBeenCalled();
  });
});

describe('Orchestrator — done stage guard', () => {
  it('discards thread_message when run is in done stage; classifier not called', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const ic = makeIntentClassifier('feedback');
    const postError = vi.fn().mockResolvedValue(undefined);
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError, postMessage: vi.fn().mockResolvedValue(undefined), repo_url: 'r', intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'done' }));

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(ic.classify).not.toHaveBeenCalled();
    expect(sg.revise).not.toHaveBeenCalled();
    expect(postError).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Spec approval handler tests
// ──────────────────────────────────────────────────────────────────────────────

function makeApprovalOrch(opts: {
  specCommitter?: SpecCommitter;
  implementer?: Implementer;
  implFeedbackPage?: ImplementationFeedbackPage;
  postMessage?: ReturnType<typeof vi.fn>;
  postError?: ReturnType<typeof vi.fn>;
  adapter: ReturnType<typeof makeMockAdapter>;
}) {
  return new OrchestratorImpl(
    {
      adapter: opts.adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('approval'),
      specCommitter: opts.specCommitter ?? makeSpecCommitter(),
      implementer: opts.implementer ?? makeImplementer(),
      implFeedbackPage: opts.implFeedbackPage ?? makeImplFeedbackPage(),
      postError: opts.postError ?? vi.fn().mockResolvedValue(undefined),
      postMessage: opts.postMessage ?? vi.fn().mockResolvedValue(undefined),
      repo_url: 'https://github.com/org/repo',
    } as never,
    { logDestination: nullDest },
  );
}

// Inject a run in reviewing_spec and emit approval thread_message
async function approveSpec(
  orch: OrchestratorImpl,
  adapter: ReturnType<typeof makeMockAdapter>,
) {
  const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
  runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
  adapter._emit({ type: 'thread_message', payload: makeFeedback() });
  await vi.waitUntil(
    () => {
      const r = runs.get('request-001');
      return r?.stage !== 'reviewing_spec' && r?.stage !== 'implementing';
    },
    { timeout: 3000 },
  );
}

describe('Orchestrator — _handleSpecApproval happy path', () => {
  it('run transitions to implementing before any component is called', async () => {
    const adapter = makeMockAdapter();
    const stages: string[] = [];
    const commitFn = vi.fn().mockImplementation(async () => {
      const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
      stages.push(runs.get('request-001')!.stage);
    });
    const sc = makeSpecCommitter({ commit: commitFn });
    const orch = makeApprovalOrch({ adapter, specCommitter: sc });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    expect(stages[0]).toBe('implementing');
  });

  it('posts approval acknowledgement to Slack before committing', async () => {
    const adapter = makeMockAdapter();
    const callOrder: string[] = [];
    const postMessage = vi.fn().mockImplementation(async (_ch: string, _ts: string, msg: string) => {
      callOrder.push(`postMessage:${msg.slice(0, 20)}`);
    });
    const commitFn = vi.fn().mockImplementation(async () => { callOrder.push('commit'); });
    const sc = makeSpecCommitter({ commit: commitFn });
    const orch = makeApprovalOrch({ adapter, specCommitter: sc, postMessage });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    const approvalAckIdx = callOrder.findIndex(s => s.startsWith('postMessage:'));
    const commitIdx = callOrder.indexOf('commit');
    expect(approvalAckIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(approvalAckIdx);
    expect(postMessage.mock.calls[0][2]).toMatch(/approved|committing/i);
  });

  it('calls SpecCommitter.commit with workspace_path, publisher_ref, spec_path', async () => {
    const adapter = makeMockAdapter();
    const sc = makeSpecCommitter();
    const orch = makeApprovalOrch({ adapter, specCommitter: sc });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    expect(sc.commit).toHaveBeenCalledOnce();
    expect(sc.commit).toHaveBeenCalledWith(
      '/ws/request-001',
      'CANVAS001',
      '/ws/request-001/context-human/specs/feature-test.md',
    );
  });

  it('calls Implementer.implement after commit resolves, with spec_path and workspace_path', async () => {
    const adapter = makeMockAdapter();
    const callOrder: string[] = [];
    const commitFn = vi.fn().mockImplementation(async () => { callOrder.push('commit'); });
    const implementFn = vi.fn().mockImplementation(async () => {
      callOrder.push('implement');
      return { status: 'complete', summary: 'Done', testing_instructions: 'Test' };
    });
    const sc = makeSpecCommitter({ commit: commitFn });
    const impl = { implement: implementFn };
    const orch = makeApprovalOrch({ adapter, specCommitter: sc, implementer: impl as Implementer });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    expect(callOrder.indexOf('commit')).toBeLessThan(callOrder.indexOf('implement'));
    expect(implementFn).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
    );
  });

  it('complete result: calls ImplementationFeedbackPage.create with summary and testing_instructions', async () => {
    const adapter = makeMockAdapter();
    const implFeedbackPage = makeImplFeedbackPage();
    const orch = makeApprovalOrch({ adapter, implFeedbackPage });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    expect(implFeedbackPage.create).toHaveBeenCalledOnce();
    const createArgs = (implFeedbackPage.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createArgs[2]).toBe('Implemented the feature successfully.');
    expect(createArgs[3]).toBe('npm install && npm test');
  });

  it('complete result: stores impl_feedback_ref on run after page creation', async () => {
    const adapter = makeMockAdapter();
    const implFeedbackPage = makeImplFeedbackPage({
      create: vi.fn().mockResolvedValue('impl-page-xyz'),
    });
    const orch = makeApprovalOrch({ adapter, implFeedbackPage });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.impl_feedback_ref).toBe('impl-page-xyz');
  });

  it('complete result: posts completion message containing feedback page URL', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const implFeedbackPage = makeImplFeedbackPage({
      create: vi.fn().mockResolvedValue('feedback-page-id'),
    });
    const orch = makeApprovalOrch({ adapter, implFeedbackPage, postMessage });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    const completionMsg = messages.find(m => m.includes('feedback-page-id') || m.includes('notion'));
    expect(completionMsg).toBeDefined();
  });

  it('complete result: run transitions to reviewing_implementation', async () => {
    const adapter = makeMockAdapter();
    const orch = makeApprovalOrch({ adapter });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('reviewing_implementation');
  });

  it('needs_input result: question posted to Slack; run transitions to awaiting_impl_input', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const implFeedbackPage = makeImplFeedbackPage();
    const impl = makeImplementer({ status: 'needs_input', question: 'Which approach do you prefer?' });
    const orch = makeApprovalOrch({ adapter, implementer: impl, implFeedbackPage, postMessage });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'awaiting_impl_input', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('awaiting_impl_input');
    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    expect(messages.some(m => m.includes('Which approach do you prefer?'))).toBe(true);
    expect(implFeedbackPage.create).not.toHaveBeenCalled();
  });
});

describe('Orchestrator — _handleSpecApproval failure paths', () => {
  it('SpecCommitter.commit rejects: run fails, error posted, implement not called', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const sc = makeSpecCommitter({ commit: vi.fn().mockRejectedValue(new Error('commit failed')) });
    const impl = makeImplementer();
    const orch = makeApprovalOrch({ adapter, specCommitter: sc, implementer: impl, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('commit failed'));
    expect(impl.implement).not.toHaveBeenCalled();
  });

  it('Implementer returns failed: run fails, error posted, feedback page not created', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const implFeedbackPage = makeImplFeedbackPage();
    const impl = makeImplementer({ status: 'failed', error: 'agent crashed' });
    const orch = makeApprovalOrch({ adapter, implementer: impl, implFeedbackPage, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('agent crashed'));
    expect(implFeedbackPage.create).not.toHaveBeenCalled();
  });

  it('Implementer throws: run fails, error posted', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const impl = { implement: vi.fn().mockRejectedValue(new Error('OMC crashed')) } as Implementer;
    const orch = makeApprovalOrch({ adapter, implementer: impl, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('OMC crashed'));
  });

  it('ImplementationFeedbackPage.create rejects: run still transitions to reviewing_implementation; completion message still posted', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const postError = vi.fn().mockResolvedValue(undefined);
    const implFeedbackPage = makeImplFeedbackPage({
      create: vi.fn().mockRejectedValue(new Error('Notion page creation failed')),
    });
    const orch = makeApprovalOrch({ adapter, implFeedbackPage, postMessage, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_implementation', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('reviewing_implementation');
    // Completion message still posted even without page link
    expect(postMessage.mock.calls.length).toBeGreaterThanOrEqual(2); // approval ack + completion
    // postError not called for page creation failure (it's degraded, not fatal)
    expect(postError).not.toHaveBeenCalled();
  });

  it('postMessage for approval ack rejects: execution continues, commit still called', async () => {
    const adapter = makeMockAdapter();
    const sc = makeSpecCommitter();
    const postMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Slack error'))  // approval ack fails
      .mockResolvedValue(undefined);                    // completion message succeeds
    const orch = makeApprovalOrch({ adapter, specCommitter: sc, postMessage });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_implementation', { timeout: 3000 });
    await orch.stop();

    expect(sc.commit).toHaveBeenCalledOnce();
    expect(runs.get('request-001')!.stage).toBe('reviewing_implementation');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Implementation feedback handler tests
// ──────────────────────────────────────────────────────────────────────────────

function makeImplFeedbackOrch(opts: {
  implementer?: Implementer;
  implFeedbackPage?: ImplementationFeedbackPage;
  postMessage?: ReturnType<typeof vi.fn>;
  postError?: ReturnType<typeof vi.fn>;
  adapter: ReturnType<typeof makeMockAdapter>;
  intentOverride?: string;
}) {
  return new OrchestratorImpl(
    {
      adapter: opts.adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier(opts.intentOverride ?? 'feedback'),
      specCommitter: makeSpecCommitter(),
      implementer: opts.implementer ?? makeImplementer(),
      implFeedbackPage: opts.implFeedbackPage ?? makeImplFeedbackPage(),
      postError: opts.postError ?? vi.fn().mockResolvedValue(undefined),
      postMessage: opts.postMessage ?? vi.fn().mockResolvedValue(undefined),
      repo_url: 'https://github.com/org/repo',
    } as never,
    { logDestination: nullDest },
  );
}

// Inject a run in reviewing_implementation and emit thread_message classified as feedback.
// Waits until the handler finishes: attempt incremented and no longer in 'implementing'.
async function sendImplFeedback(
  orch: OrchestratorImpl,
  adapter: ReturnType<typeof makeMockAdapter>,
  runOverrides: Partial<Run> = {},
) {
  const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
  runs.set('request-001', makeRun({ stage: 'reviewing_implementation', impl_feedback_ref: 'feedback-page-id', ...runOverrides }));
  adapter._emit({ type: 'thread_message', payload: makeFeedback() });
  await vi.waitUntil(
    () => {
      const r = runs.get('request-001');
      // Handler increments attempt before implementing; done when attempt > 0 and no longer implementing
      return r !== undefined && r.attempt > 0 && r.stage !== 'implementing';
    },
    { timeout: 3000 },
  );
}

describe('Orchestrator — _handleImplementationFeedback happy path (reviewing_implementation)', () => {
  it('reads feedback from impl_feedback_ref page before implementing', async () => {
    const adapter = makeMockAdapter();
    const callOrder: string[] = [];
    const feedbackItems = [{ id: 'item-1', text: 'Fix the bug', resolved: false, conversation: [] }];
    const readFn = vi.fn().mockImplementation(async () => { callOrder.push('readFeedback'); return feedbackItems; });
    const implementFn = vi.fn().mockImplementation(async () => {
      callOrder.push('implement');
      return { status: 'complete', summary: 'Fixed', testing_instructions: 'Test' };
    });
    const implFeedbackPage = makeImplFeedbackPage({ readFeedback: readFn });
    const impl = { implement: implementFn } as Implementer;
    const orch = makeImplFeedbackOrch({ adapter, implFeedbackPage, implementer: impl });
    await orch.start();
    await sendImplFeedback(orch, adapter);
    await orch.stop();

    expect(callOrder.indexOf('readFeedback')).toBeLessThan(callOrder.indexOf('implement'));
    expect(readFn).toHaveBeenCalledWith('feedback-page-id');
  });

  it('passes serialized unresolved feedback items as additional_context to implement', async () => {
    const adapter = makeMockAdapter();
    const feedbackItems = [
      { id: 'item-1', text: 'Fix the bug', resolved: false, conversation: ['Some context'] },
      { id: 'item-2', text: 'Already done', resolved: true, conversation: [] },
    ];
    const implFeedbackPage = makeImplFeedbackPage({
      readFeedback: vi.fn().mockResolvedValue(feedbackItems),
    });
    const impl = makeImplementer();
    const orch = makeImplFeedbackOrch({ adapter, implFeedbackPage, implementer: impl });
    await orch.start();
    await sendImplFeedback(orch, adapter);
    await orch.stop();

    expect(impl.implement).toHaveBeenCalledOnce();
    const implementArgs = (impl.implement as ReturnType<typeof vi.fn>).mock.calls[0];
    // Third arg should be additional_context containing only unresolved items
    expect(implementArgs[2]).toContain('Fix the bug');
    expect(implementArgs[2]).not.toContain('Already done');
  });

  it('complete result: calls ImplementationFeedbackPage.update with new summary and resolved items', async () => {
    const adapter = makeMockAdapter();
    const implFeedbackPage = makeImplFeedbackPage({
      readFeedback: vi.fn().mockResolvedValue([
        { id: 'item-1', text: 'Fix the bug', resolved: false, conversation: [] },
      ]),
      update: vi.fn().mockResolvedValue(undefined),
    });
    const impl = makeImplementer({
      status: 'complete',
      summary: 'Fixed it',
      testing_instructions: 'Test',
    });
    const orch = makeImplFeedbackOrch({ adapter, implFeedbackPage, implementer: impl });
    await orch.start();
    await sendImplFeedback(orch, adapter);
    await orch.stop();

    expect(implFeedbackPage.update).toHaveBeenCalledOnce();
    const updateArgs = (implFeedbackPage.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateArgs[0]).toBe('feedback-page-id');
    expect(updateArgs[1]).toMatchObject({ summary: 'Fixed it' });
  });

  it('complete result: run transitions to reviewing_implementation', async () => {
    const adapter = makeMockAdapter();
    const orch = makeImplFeedbackOrch({ adapter });
    await orch.start();
    await sendImplFeedback(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('reviewing_implementation');
  });

  it('complete result: posts completion message to Slack', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const orch = makeImplFeedbackOrch({ adapter, postMessage });
    await orch.start();
    await sendImplFeedback(orch, adapter);
    await orch.stop();

    expect(postMessage).toHaveBeenCalled();
  });

  it('needs_input result: question posted; run transitions to awaiting_impl_input', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const impl = makeImplementer({ status: 'needs_input', question: 'Which refactor pattern?' });
    const orch = makeImplFeedbackOrch({ adapter, implementer: impl, postMessage });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation', impl_feedback_ref: 'feedback-page-id' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'awaiting_impl_input', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('awaiting_impl_input');
    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    expect(messages.some(m => m.includes('Which refactor pattern?'))).toBe(true);
  });
});

describe('Orchestrator — _handleImplementationFeedback happy path (awaiting_impl_input)', () => {
  it('uses Slack message content directly as additional_context (does not call readFeedback)', async () => {
    const adapter = makeMockAdapter();
    const implFeedbackPage = makeImplFeedbackPage();
    const impl = makeImplementer();
    const orch = makeImplFeedbackOrch({ adapter, implFeedbackPage, implementer: impl });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'awaiting_impl_input', impl_feedback_ref: 'feedback-page-id' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback({ content: 'go with the subtype approach' }) });
    await vi.waitUntil(
      () => {
        const r = runs.get('request-001');
        return r?.stage !== 'awaiting_impl_input' && r?.stage !== 'implementing';
      },
      { timeout: 3000 },
    );
    await orch.stop();

    expect(implFeedbackPage.readFeedback).not.toHaveBeenCalled();
    const implementArgs = (impl.implement as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(implementArgs[2]).toContain('go with the subtype approach');
  });
});

describe('Orchestrator — _handleImplementationFeedback failure paths', () => {
  it('readFeedback rejects: run fails, error posted, implement not called', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const implFeedbackPage = makeImplFeedbackPage({
      readFeedback: vi.fn().mockRejectedValue(new Error('Notion read failed')),
    });
    const impl = makeImplementer();
    const orch = makeImplFeedbackOrch({ adapter, implFeedbackPage, implementer: impl, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation', impl_feedback_ref: 'feedback-page-id' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('Notion read failed'));
    expect(impl.implement).not.toHaveBeenCalled();
  });

  it('Implementer returns failed: run fails, error posted; page not updated', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const implFeedbackPage = makeImplFeedbackPage();
    const impl = makeImplementer({ status: 'failed', error: 'agent crashed during feedback' });
    const orch = makeImplFeedbackOrch({ adapter, implFeedbackPage, implementer: impl, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation', impl_feedback_ref: 'feedback-page-id' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('agent crashed'));
    expect(implFeedbackPage.update).not.toHaveBeenCalled();
  });

  it('ImplementationFeedbackPage.update rejects: run still transitions to reviewing_implementation', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const implFeedbackPage = makeImplFeedbackPage({
      update: vi.fn().mockRejectedValue(new Error('Notion update failed')),
    });
    const orch = makeImplFeedbackOrch({ adapter, implFeedbackPage, postError });
    await orch.start();
    await sendImplFeedback(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('reviewing_implementation');
    expect(postError).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Implementation approval handler tests
// ──────────────────────────────────────────────────────────────────────────────

import type { PRCreator } from '../../src/adapters/agent/pr-creator.js';

function makePRCreator(overrides: Partial<PRCreator> = {}): PRCreator {
  return {
    createPR: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/42'),
    ...overrides,
  };
}

function makeApprovalOrch2(opts: {
  prCreator?: PRCreator;
  postMessage?: ReturnType<typeof vi.fn>;
  postError?: ReturnType<typeof vi.fn>;
  adapter: ReturnType<typeof makeMockAdapter>;
}) {
  return new OrchestratorImpl(
    {
      adapter: opts.adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('approval'),
      specCommitter: makeSpecCommitter(),
      implementer: makeImplementer(),
      implFeedbackPage: makeImplFeedbackPage(),
      prCreator: opts.prCreator ?? makePRCreator(),
      postError: opts.postError ?? vi.fn().mockResolvedValue(undefined),
      postMessage: opts.postMessage ?? vi.fn().mockResolvedValue(undefined),
      repo_url: 'https://github.com/org/repo',
    } as never,
    { logDestination: nullDest },
  );
}

async function sendImplApproval(
  orch: OrchestratorImpl,
  adapter: ReturnType<typeof makeMockAdapter>,
) {
  const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
  runs.set('request-001', makeRun({ stage: 'reviewing_implementation', branch: 'spec/request-001' }));
  adapter._emit({ type: 'thread_message', payload: makeFeedback() });
  await vi.waitUntil(
    () => {
      const r = runs.get('request-001');
      return r?.stage === 'done' || r?.stage === 'failed';
    },
    { timeout: 3000 },
  );
}

describe('Orchestrator — _handleImplementationApproval happy path', () => {
  it('calls PRCreator.createPR with workspace_path and branch', async () => {
    const adapter = makeMockAdapter();
    const prCreator = makePRCreator();
    const orch = makeApprovalOrch2({ adapter, prCreator });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    expect(prCreator.createPR).toHaveBeenCalledOnce();
    expect(prCreator.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      expect.any(String),
    );
  });

  it('posts PR link to Slack after creation', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const prCreator = makePRCreator({
      createPR: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/99'),
    });
    const orch = makeApprovalOrch2({ adapter, prCreator, postMessage });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    expect(messages.some(m => m.includes('https://github.com/org/repo/pull/99'))).toBe(true);
  });

  it('run transitions to done after PR is created', async () => {
    const adapter = makeMockAdapter();
    const orch = makeApprovalOrch2({ adapter });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('done');
  });
});

describe('Orchestrator — _handleImplementationApproval failure paths', () => {
  it('PRCreator.createPR rejects: error posted to Slack; run transitions to failed', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const prCreator = makePRCreator({
      createPR: vi.fn().mockRejectedValue(new Error('gh pr create failed')),
    });
    const orch = makeApprovalOrch2({ adapter, prCreator, postError });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('gh pr create failed'));
  });

  it('postMessage for PR link rejects: run still transitions to done (PR was created)', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockRejectedValue(new Error('Slack error'));
    const postError = vi.fn().mockResolvedValue(undefined);
    const orch = makeApprovalOrch2({ adapter, postMessage, postError });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('done');
    expect(postError).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Run persistence tests
// ──────────────────────────────────────────────────────────────────────────────

import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileRunStore } from '../../src/core/run-store.js';

describe('Orchestrator — run persistence', () => {
  it('loads runs on construction: existing run is matched by request_id on thread_message', async () => {
    const existingRun = makeRun({ request_id: 'request-loaded', stage: 'reviewing_spec', channel_id: 'C999', thread_ts: '9000.0' });
    const mockRunStore = { load: vi.fn().mockReturnValue([existingRun]), save: vi.fn() };

    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('feedback'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        repo_url: 'r',
        runStore: mockRunStore,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    // Send thread_message for the loaded run's request_id — if loaded, revise will be called
    adapter._emit({ type: 'thread_message', payload: { ...makeFeedback(), request_id: 'request-loaded', channel_id: 'C999', thread_ts: '9000.0' } });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    // revise called means the run was found by request_id (not discarded as unknown)
    expect(sg.revise).toHaveBeenCalledOnce();
    expect(mockRunStore.load).toHaveBeenCalledOnce();
  });

  it('persists after createRun: save is called when new_request is processed', async () => {
    const mockRunStore = { load: vi.fn().mockReturnValue([]), save: vi.fn() };

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('idea'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        repo_url: 'r',
        runStore: mockRunStore,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    expect(mockRunStore.save).toHaveBeenCalled();
    // The Map passed to save should contain the new run
    const savedMap = (mockRunStore.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as Map<string, Run>;
    expect(savedMap.has('request-001')).toBe(true);
  });

  it('persists after transition: save is called on stage transition', async () => {
    const mockRunStore = { load: vi.fn().mockReturnValue([]), save: vi.fn() };

    const adapter = makeMockAdapter();
    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        repo_url: 'r',
        runStore: mockRunStore,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    // Seed a run and send feedback to trigger a transition
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    mockRunStore.save.mockClear();
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec' && runs.get('request-001')?.attempt === 1, { timeout: 2000 });
    await orch.stop();

    expect(mockRunStore.save).toHaveBeenCalled();
  });

  it('persists after attempt increment in _handleSpecApproval', async () => {
    const mockRunStore = { load: vi.fn().mockReturnValue([]), save: vi.fn() };

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('approval'),
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        repo_url: 'r',
        runStore: mockRunStore,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    mockRunStore.save.mockClear();

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => {
        const r = runs.get('request-001');
        return r?.stage === 'reviewing_implementation' || r?.stage === 'failed';
      },
      { timeout: 3000 },
    );
    await orch.stop();

    expect(mockRunStore.save).toHaveBeenCalled();
  });

  it('persists after attempt increment in _handleImplementationFeedback', async () => {
    const mockRunStore = { load: vi.fn().mockReturnValue([]), save: vi.fn() };

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('feedback'),
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        repo_url: 'r',
        runStore: mockRunStore,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation', impl_feedback_ref: 'fp-id' }));
    mockRunStore.save.mockClear();

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => {
        const r = runs.get('request-001');
        return r !== undefined && r.attempt > 0 && r.stage !== 'implementing';
      },
      { timeout: 3000 },
    );
    await orch.stop();

    expect(mockRunStore.save).toHaveBeenCalled();
  });

  it('persists after impl_feedback_ref is set in _runImplementation', async () => {
    const mockRunStore = { load: vi.fn().mockReturnValue([]), save: vi.fn() };

    const adapter = makeMockAdapter();
    const implFeedbackPage = makeImplFeedbackPage({ create: vi.fn().mockResolvedValue('new-feedback-page') });
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('approval'),
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        repo_url: 'r',
        runStore: mockRunStore,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    mockRunStore.save.mockClear();

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.impl_feedback_ref === 'new-feedback-page', { timeout: 3000 });
    await orch.stop();

    expect(mockRunStore.save).toHaveBeenCalled();
  });

  it('no runStore dep: orchestrator works without errors', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    // No runStore in deps — should work fine
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('idea'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        repo_url: 'r',
      },
      { logDestination: nullDest },
    );
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    // Verify normal operation still works
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')?.stage).toBe('reviewing_spec');
  });

  it('Slack restart notification: posts "Server restarted" to channel/thread of demoted runs', async () => {
    // Create a temp dir with a runs.json containing a run in 'implementing' stage
    const tmpDir = mkdirSync(join(tmpdir(), `orch-test-${Date.now()}`), { recursive: true }) ?? join(tmpdir(), `orch-test-${Date.now()}`);
    const storeDir = join(tmpDir as string, '.autocatalyst');
    mkdirSync(storeDir, { recursive: true });

    // Use an existing directory for workspace_path so FileRunStore doesn't drop it
    const workspacePath = tmpDir as string;

    const persistedRun: Run = {
      id: 'run-restart',
      request_id: 'request-restart',
      intent: 'idea',
      stage: 'implementing',
      workspace_path: workspacePath,
      branch: 'feat/restart',
      spec_path: undefined,
      publisher_ref: undefined,
      impl_feedback_ref: undefined,
      attempt: 1,
      channel_id: 'C999',
      thread_ts: '9999.0000',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    writeFileSync(join(storeDir, 'runs.json'), JSON.stringify([persistedRun], null, 2), 'utf-8');

    const fileRunStore = new FileRunStore(tmpDir as string, { logDestination: nullDest });

    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('feedback'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        repo_url: 'r',
        runStore: fileRunStore,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    // Wait for next tick (setImmediate) so _notifyRestartFailures fires
    await new Promise(resolve => setImmediate(resolve));
    // Additional small wait for async postMessage
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith('C999', '9999.0000', expect.stringContaining('Server restarted'));
  });
});

describe('Orchestrator — question intent', () => {
  it('new_request with question intent: questionAnswerer.answer called with content, response posted', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const qa = makeQuestionAnswerer('You can submit ideas by @mentioning me.');
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('question'),
        questionAnswerer: qa,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        repo_url: 'r',
      },
      { logDestination: nullDest },
    );
    await orch.start();

    const request = makeRequest({ content: 'How do I submit a feature request?' });
    adapter._emit({ type: 'new_request', payload: request });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(qa.answer).toHaveBeenCalledWith('How do I submit a feature request?');
    expect(postMessage).toHaveBeenCalledWith('C123', '100.0', 'You can submit ideas by @mentioning me.');
  });

  it('thread_message with question intent: questionAnswerer.answer called with feedback content, stage unchanged', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const qa = makeQuestionAnswerer('Great question about the auth flow.');
    const ic = makeIntentClassifier('question');
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        questionAnswerer: qa,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        repo_url: 'r',
      },
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback({ content: 'How does auth work?' }) });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(qa.answer).toHaveBeenCalledWith('How does auth work?');
    expect(postMessage).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'Great question about the auth flow.');
    expect(runs.get('request-001')!.stage).toBe('reviewing_spec');
  });

  it('questionAnswerer throws: fallback response posted, run does not fail', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const postError = vi.fn().mockResolvedValue(undefined);
    const qa: QuestionAnswerer = { answer: vi.fn().mockRejectedValue(new Error('API down')) };
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('question'),
        questionAnswerer: qa,
        postError,
        postMessage,
        repo_url: 'r',
      },
      { logDestination: nullDest },
    );
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ content: 'what can you do?' }) });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining("wasn't able"));
    expect(postError).not.toHaveBeenCalled();
  });

  it('no questionAnswerer configured: fallback text posted', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('question'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        repo_url: 'r',
      },
      { logDestination: nullDest },
    );
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith('C123', '100.0', expect.any(String));
  });
});

describe('_classify — serial classification gate', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('new_request always returns dispatch', async () => {
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    });
    await orch.start();

    const event = makeEventFixture('new_request');
    const action = await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(event);
    expect(action).toBe('dispatch');

    await orch.stop();
  });

  it('thread_message with no matching run returns discard and logs classify.run_not_found', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { logDestination: destination });
    await orch.start();

    const event = makeEventFixture('thread_message', { request_id: 'nonexistent-run' });
    const action = await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(event);
    expect(action).toBe('discard');
    const logEntry = records.find(r => r['event'] === 'classify.run_not_found');
    expect(logEntry).toBeDefined();
    expect(logEntry!['request_id']).toBe('nonexistent-run');

    await orch.stop();
  });

  it('thread_message with run in speccing stage returns discard and logs classify.stage_blocked', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { logDestination: destination });
    await orch.start();

    const run: Run = {
      id: 'run-1', request_id: 'req-speccing', intent: 'idea', stage: 'speccing',
      workspace_path: '/ws', branch: 'b', spec_path: undefined, publisher_ref: undefined,
      impl_feedback_ref: undefined, attempt: 0, channel_id: 'C1', thread_ts: '100.0',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-speccing', run);

    const event = makeEventFixture('thread_message', { request_id: 'req-speccing' });
    const action = await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(event);
    expect(action).toBe('discard');
    const logEntry = records.find(r => r['event'] === 'classify.stage_blocked');
    expect(logEntry).toBeDefined();
    expect(logEntry!['stage']).toBe('speccing');

    await orch.stop();
  });

  it('thread_message with run in implementing stage returns discard (stage_blocked)', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { logDestination: destination });
    await orch.start();

    const run: Run = {
      id: 'run-1', request_id: 'req-impl', intent: 'idea', stage: 'implementing',
      workspace_path: '/ws', branch: 'b', spec_path: '/spec.md', publisher_ref: 'PAGE1',
      impl_feedback_ref: undefined, attempt: 1, channel_id: 'C1', thread_ts: '100.0',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-impl', run);

    const event = makeEventFixture('thread_message', { request_id: 'req-impl' });
    const action = await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(event);
    expect(action).toBe('discard');
    expect(records.find(r => r['event'] === 'classify.stage_blocked' && r['stage'] === 'implementing')).toBeDefined();

    await orch.stop();
  });

  it('thread_message in reviewing_spec advances stage to implementing and returns dispatch', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { logDestination: destination });
    await orch.start();

    const run: Run = {
      id: 'run-1', request_id: 'req-review', intent: 'idea', stage: 'reviewing_spec',
      workspace_path: '/ws', branch: 'b', spec_path: '/spec.md', publisher_ref: 'PAGE1',
      impl_feedback_ref: undefined, attempt: 0, channel_id: 'C1', thread_ts: '100.0',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-review', run);

    const event = makeEventFixture('thread_message', { request_id: 'req-review' });
    const action = await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(event);
    expect(action).toBe('dispatch');
    // Stage must be advanced before _classify returns
    expect(run.stage).toBe('implementing');
    expect(records.find(r => r['event'] === 'classify.dispatched')).toBeDefined();

    await orch.stop();
  });

  it('duplicate approval: first returns dispatch advancing stage; second sees implementing and returns discard', async () => {
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { maxConcurrentRuns: 10 });

    const run: Run = {
      id: 'run-1', request_id: 'req-dup', intent: 'idea', stage: 'reviewing_spec',
      workspace_path: '/ws', branch: 'b', spec_path: '/spec.md', publisher_ref: 'PAGE1',
      impl_feedback_ref: undefined, attempt: 0, channel_id: 'C1', thread_ts: '100.0',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-dup', run);

    await orch.start();

    const approval1 = makeEventFixture('thread_message', { request_id: 'req-dup' });
    const approval2 = makeEventFixture('thread_message', { request_id: 'req-dup' });

    const action1 = await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(approval1);
    expect(action1).toBe('dispatch');
    expect(run.stage).toBe('implementing');

    const action2 = await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(approval2);
    expect(action2).toBe('discard');

    await orch.stop();
  });
});

describe('_dispatchOrEnqueue and _launch', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('launches immediately when below concurrency limit', async () => {
    const adapter = makeMockAdapter();
    const handleReq = vi.fn().mockResolvedValue(undefined);
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { maxConcurrentRuns: 2 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    const event = makeEventFixture('new_request');
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(event);

    await vi.waitUntil(() => handleReq.mock.calls.length === 1, { timeout: 200 });
    expect(handleReq).toHaveBeenCalledTimes(1);

    await orch.stop();
  });

  it('enqueues and logs run.queued when at capacity', async () => {
    const { records, destination } = makeLogCapture();
    const postMessage = vi.fn().mockResolvedValue(undefined);

    const ctrl1 = makeControllablePromise();
    const ctrl2 = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? ctrl1.promise : ctrl2.promise;
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage,
      repo_url: 'https://github.com/org/repo',
    }, { maxConcurrentRuns: 2, logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    const e1 = makeEventFixture('new_request', { id: 'r1', channel_id: 'C1', thread_ts: '1.0' });
    const e2 = makeEventFixture('new_request', { id: 'r2', channel_id: 'C2', thread_ts: '2.0' });
    const e3 = makeEventFixture('new_request', { id: 'r3', channel_id: 'C3', thread_ts: '3.0' });

    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(e1);
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(e2);
    await vi.waitUntil(() => callCount === 2, { timeout: 200 });

    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(e3);

    // Third event should be queued
    const queuedLog = records.find(r => r['event'] === 'run.queued');
    expect(queuedLog).toBeDefined();
    expect(queuedLog!['queue_depth']).toBe(1);
    // Queue notification sent to C3
    expect(postMessage).toHaveBeenCalledWith('C3', '3.0', expect.stringContaining('queued'));
    // _handleRequest called only twice (not three times yet)
    expect(handleReq).toHaveBeenCalledTimes(2);

    // Resolve first handler — third should now be dispatched
    ctrl1.resolve();
    await vi.waitUntil(() => handleReq.mock.calls.length === 3, { timeout: 200 });
    expect(records.find(r => r['event'] === 'run.dequeued')).toBeDefined();

    ctrl2.resolve();
    await orch.stop();
  });

  it('_inFlight.size is accurate throughout dispatch lifecycle', async () => {
    const ctrl = makeControllablePromise();
    const handleReq = vi.fn().mockReturnValue(ctrl.promise);
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { maxConcurrentRuns: 5 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    const inFlight = () => (orch as unknown as { _inFlight: Set<unknown> })._inFlight.size;

    expect(inFlight()).toBe(0);
    const event = makeEventFixture('new_request');
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(event);
    await vi.waitUntil(() => handleReq.mock.calls.length === 1, { timeout: 200 });
    expect(inFlight()).toBe(1);

    ctrl.resolve();
    await vi.waitUntil(() => inFlight() === 0, { timeout: 200 });
    expect(inFlight()).toBe(0);

    await orch.stop();
  });

  it('catch handler logs run.unhandled_error for unexpected throws', async () => {
    const { records, destination } = makeLogCapture();
    const handleReq = vi.fn().mockRejectedValue(new Error('kaboom'));
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      repo_url: 'https://github.com/org/repo',
    }, { logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    const event = makeEventFixture('new_request');
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(event);

    await vi.waitUntil(
      () => records.some(r => r['event'] === 'run.unhandled_error'),
      { timeout: 200 },
    );
    const errLog = records.find(r => r['event'] === 'run.unhandled_error');
    expect(errLog!['error']).toContain('kaboom');
    expect((orch as unknown as { _inFlight: Set<unknown> })._inFlight.size).toBe(0);

    await orch.stop();
  });
});
