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
import type { IssueManager } from '../../src/adapters/agent/issue-manager.js';
import type { IssueFiler, FilingResult } from '../../src/adapters/agent/issue-filer.js';
import type { CommandEvent, CommandRegistry } from '../../src/types/commands.js';
import type { ChannelRepoMap, RepoEntry } from '../../src/types/config.js';

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
    reactToMessage: vi.fn().mockResolvedValue(undefined),
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

/** A Map subclass that returns a default RepoEntry for any channel_id not explicitly set.
 *  This allows existing tests to work without knowing the exact channel_id in advance. */
class _UniversalChannelRepoMap extends Map<string, RepoEntry> {
  private readonly _defaultEntry: RepoEntry;
  constructor(defaultEntry: RepoEntry, explicitEntries: [string, RepoEntry][] = []) {
    super([[defaultEntry.channel_id, defaultEntry], ...explicitEntries]);
    this._defaultEntry = defaultEntry;
  }
  override has(_key: string): boolean { return true; }
  override get(key: string): RepoEntry { return super.get(key) ?? this._defaultEntry; }
}

function makeChannelRepoMap(entries: Record<string, Partial<RepoEntry>> = {}): ChannelRepoMap {
  const defaultEntry: RepoEntry = {
    channel_id: 'C1',
    repo_url: 'https://github.com/org/repo.git',
    workspace_root: '~/.autocatalyst/workspaces',
  };
  const map = new _UniversalChannelRepoMap(defaultEntry);
  for (const [channelId, partial] of Object.entries(entries)) {
    map.set(channelId, {
      channel_id: channelId,
      repo_url: 'https://github.com/org/repo.git',
      workspace_root: '~/.autocatalyst/workspaces',
      ...partial,
    });
  }
  return map;
}

function makeSpecGenerator(overrides: Partial<SpecGenerator> = {}): SpecGenerator {
  return {
    create: vi.fn().mockResolvedValue({ spec_path: '/ws/request-001/context-human/specs/feature-test.md' }),
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
    issue: undefined,
    attempt: 0,
    pr_url: undefined,
    last_impl_result: undefined,
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
    updateStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeIssueManager(overrides: Partial<IssueManager> = {}): IssueManager {
  return {
    writeIssue: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue(42),
    ...overrides,
  };
}

function makeIssueFiler(resultOverrides: Partial<FilingResult> = {}): IssueFiler {
  const defaultResult: FilingResult = {
    status: 'complete',
    summary: 'Filed 1 new issue: #10 Test Issue',
    filed_issues: [{ number: 10, title: 'Test Issue', action: 'filed' }],
    ...resultOverrides,
  };
  return {
    file: vi.fn().mockResolvedValue(defaultResult),
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

function makeImplFeedbackPage(overrides: Partial<ImplementationFeedbackPage> & {
  updateStatus?: ReturnType<typeof vi.fn>;
  setPRLink?: ReturnType<typeof vi.fn>;
} = {}): ImplementationFeedbackPage {
  return {
    create: vi.fn().mockResolvedValue('feedback-page-id'),
    readFeedback: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCommandEvent(overrides: Partial<CommandEvent> = {}): { type: 'command'; payload: CommandEvent } {
  return {
    type: 'command',
    payload: {
      command: 'test.cmd',
      args: [],
      source: 'slack',
      channel_id: 'C001',
      thread_ts: '1000.0',
      author: 'U001',
      received_at: new Date().toISOString(),
      ...overrides,
    },
  };
}

function makeCommandRegistry(overrides: Partial<CommandRegistry> = {}): CommandRegistry {
  return {
    register: vi.fn(),
    dispatch: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    getUsage: vi.fn().mockReturnValue(undefined),
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();

    const request = makeRequest();
    adapter._emit({ type: 'new_request', payload: request });

    // Give the loop time to process
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.create).toHaveBeenCalledWith('request-001', 'https://github.com/org/repo.git', '~/.autocatalyst/workspaces');
    expect(sg.create).toHaveBeenCalledWith(request, '/ws/request-001', expect.any(Function));
    expect(cp.create).toHaveBeenCalledWith('C123', '100.0', '/ws/request-001/context-human/specs/feature-test.md');
  });

  it('run ends in review stage with all fields populated', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
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
    const sg = makeSpecGenerator({ create: vi.fn().mockRejectedValue(new Error('spec generation failed')) });
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('spec generation failed'));
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic }, { logDestination: nullDest });
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
      expect.any(Function),
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('feedback') }, { logDestination: nullDest });
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 10)); // let it reach speccing stage

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 10));

    // Now resolve the slow create so the loop can finish
    resolveCreate();
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    // With concurrent dispatch: new_request is launched and running concurrently. The for-await loop
    // immediately classifies the thread_message event while the run is still in 'speccing'. _classify
    // sees 'speccing' as a non-actionable stage and discards the thread_message. revise is NOT called.
    expect(sg.revise).not.toHaveBeenCalled();
  });

  it('discards feedback when run is in failed stage', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager({ create: vi.fn().mockRejectedValue(new Error('fail')) });
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic }, { logDestination: nullDest });
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic }, { logDestination: nullDest });
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

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('idea') }, { logDestination: nullDest });
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: sp, feedbackSource: fs, postError, postMessage, channelRepoMap: makeChannelRepoMap(), intentClassifier: ic } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    await seedAndFeedback(orch, adapter);
    await adapter.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')?.stage).toBe('reviewing_spec');
    expect(callOrder).toEqual(['postMessage', 'fetch', 'getPageMarkdown', 'revise', 'update', 'reply', 'reply', 'postMessage']);
    expect(sp.getPageMarkdown).toHaveBeenCalledWith('CANVAS001');
    expect(fs.fetch).toHaveBeenCalledWith('CANVAS001');
    expect(sg.revise).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'request-001' }),
      notionComments,
      expect.any(String),
      expect.any(String),
      undefined,
      expect.any(Function),
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic } as never,
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
      expect.any(Function),
    );
    expect(fs.reply).not.toHaveBeenCalled();
  });

  it('no feedbackSource: revise called with []; no fetch/reply', async () => {
    const sg = makeSpecGenerator({ revise: vi.fn().mockResolvedValue({ comment_responses: [] }) });
    const adapter = makeMockAdapter();

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
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
      expect.any(Function),
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic } as never,
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic } as never,
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), feedbackSource: fs, postError: vi.fn().mockResolvedValue(undefined), postMessage, channelRepoMap: makeChannelRepoMap(), intentClassifier: ic } as never,
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage, channelRepoMap: makeChannelRepoMap(), intentClassifier: ic } as never,
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError, postMessage, channelRepoMap: makeChannelRepoMap(), intentClassifier: ic } as never,
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: makeSpecGenerator(), specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
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
  it('discards thread_message when run is in implementing stage; no busy message, classifier not called', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const ic = makeIntentClassifier('feedback');
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage, channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'implementing' }));

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    // _classify discards implementing stage silently — no busy message posted
    expect(postMessage).not.toHaveBeenCalled();
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
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
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
      channelRepoMap: makeChannelRepoMap(),
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
      undefined,
      expect.any(Function),
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
    expect(createArgs[2]).toBe('Test'); // spec_title derived from spec_path
    expect(createArgs[3]).toBe('Implemented the feature successfully.');
    expect(createArgs[4]).toBe('npm install && npm test');
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

describe('Orchestrator — _runImplementation onProgress wiring', () => {
  it('implement() receives an onProgress function', async () => {
    const adapter = makeMockAdapter();
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const implementFn = vi.fn().mockImplementation(async (_sp: string, _wp: string, _ctx: string | undefined, onProg?: (m: string) => Promise<void>) => {
      capturedOnProgress = onProg;
      return { status: 'complete', summary: 'Done', testing_instructions: 'Test' };
    });
    const impl = { implement: implementFn };
    const orch = makeApprovalOrch({ adapter, implementer: impl as Implementer });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    expect(capturedOnProgress).toBeTypeOf('function');
  });

  it('onProgress callback invokes postMessage with channel_id, thread_ts, and message', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const implementFn = vi.fn().mockImplementation(async (_sp: string, _wp: string, _ctx: string | undefined, onProg?: (m: string) => Promise<void>) => {
      capturedOnProgress = onProg;
      return { status: 'complete', summary: 'Done', testing_instructions: 'Test' };
    });
    const impl = { implement: implementFn };
    const orch = makeApprovalOrch({ adapter, implementer: impl as Implementer, postMessage });
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    // Invoke the captured callback
    await capturedOnProgress!('Task 3 of 7: Implementing the helper');

    const progressCalls = (postMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[2] === 'Task 3 of 7: Implementing the helper');
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0][0]).toBe('C123');
    expect(progressCalls[0][1]).toBe('100.0');
  });

  it('postMessage rejection inside onProgress does not fail the run, progress_failed logged at warn', async () => {
    const adapter = makeMockAdapter();
    const { records, destination } = makeLogCapture();
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const implementFn = vi.fn().mockImplementation(async (_sp: string, _wp: string, _ctx: string | undefined, onProg?: (m: string) => Promise<void>) => {
      capturedOnProgress = onProg;
      return { status: 'complete', summary: 'Done', testing_instructions: 'Test' };
    });
    const impl = { implement: implementFn };
    const postMessage = vi.fn().mockImplementation((_ch: string, _ts: string, msg: string) => {
      if (msg === 'progress relay msg') return Promise.reject(new Error('slack timeout'));
      return Promise.resolve();
    });
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('approval'),
        specCommitter: makeSpecCommitter(),
        implementer: impl as Implementer,
        implFeedbackPage: makeImplFeedbackPage(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: destination },
    );
    await orch.start();
    await approveSpec(orch, adapter);
    await orch.stop();

    // Invoke the captured callback with a message that will make postMessage reject
    if (capturedOnProgress) {
      await capturedOnProgress('progress relay msg').catch(() => {});
      await new Promise(r => setTimeout(r, 0));
    }

    const failLog = records.find(r => r['event'] === 'progress_failed' && r['phase'] === 'implementation');
    expect(failLog).toBeDefined();
    expect(String(failLog!['error'])).toContain('slack timeout');
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
    const impl = { implement: vi.fn().mockRejectedValue(new Error('agent crashed')) } as Implementer;
    const orch = makeApprovalOrch({ adapter, implementer: impl, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('agent crashed'));
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
      channelRepoMap: makeChannelRepoMap(),
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

import type { PRManager } from '../../src/adapters/agent/pr-manager.js';

function makePRManager(overrides: Partial<PRManager> = {}): PRManager {
  return {
    createPR: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/42'),
    mergePR: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeApprovalOrch2(opts: {
  prManager?: PRManager;
  specCommitter?: SpecCommitter;
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
      implementer: makeImplementer(),
      implFeedbackPage: makeImplFeedbackPage(),
      prManager: opts.prManager ?? makePRManager(),
      postError: opts.postError ?? vi.fn().mockResolvedValue(undefined),
      postMessage: opts.postMessage ?? vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
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
      return r?.stage === 'pr_open' || r?.stage === 'failed';
    },
    { timeout: 3000 },
  );
}

// Helper: drive a run to pr_open stage by doing a full impl approval cycle
async function driveRunToPrOpen(
  orch: OrchestratorImpl,
  adapter: ReturnType<typeof makeMockAdapter>,
  runOverrides: Partial<Run> = {},
): Promise<void> {
  const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
  runs.set('request-001', makeRun({ stage: 'reviewing_implementation', branch: 'spec/request-001', ...runOverrides }));
  adapter._emit({ type: 'thread_message', payload: makeFeedback() });
  await vi.waitUntil(
    () => {
      const r = runs.get('request-001');
      return r?.stage === 'pr_open' || r?.stage === 'failed';
    },
    { timeout: 3000 },
  );
}

describe('Orchestrator — _handleImplementationApproval happy path', () => {
  it('calls PRManager.createPR with workspace_path and branch', async () => {
    const adapter = makeMockAdapter();
    const prManager = makePRManager();
    const orch = makeApprovalOrch2({ adapter, prManager });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    expect(prManager.createPR).toHaveBeenCalledOnce();
    expect(prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('posts PR link to Slack after creation', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const prManager = makePRManager({
      createPR: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/99'),
    });
    const orch = makeApprovalOrch2({ adapter, prManager, postMessage });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    expect(messages.some(m => m.includes('https://github.com/org/repo/pull/99'))).toBe(true);
  });

  it('run transitions to pr_open after PR is created', async () => {
    const adapter = makeMockAdapter();
    const orch = makeApprovalOrch2({ adapter });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('pr_open');
  });

  it('run.pr_url set after successful PR creation', async () => {
    const adapter = makeMockAdapter();
    const prManager = makePRManager({
      createPR: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/77'),
    });
    const orch = makeApprovalOrch2({ adapter, prManager });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.pr_url).toBe('https://github.com/org/repo/pull/77');
  });

  it('specCommitter.updateStatus called with {status: complete, last_updated: today} before createPR', async () => {
    const adapter = makeMockAdapter();
    const callOrder: string[] = [];
    const sc = makeSpecCommitter({
      updateStatus: vi.fn().mockImplementation(async () => { callOrder.push('updateStatus'); }),
    });
    const prManager = makePRManager({
      createPR: vi.fn().mockImplementation(async () => { callOrder.push('createPR'); return 'https://github.com/org/repo/pull/1'; }),
    });
    const orch = makeApprovalOrch2({ adapter, prManager, specCommitter: sc });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    expect(sc.updateStatus).toHaveBeenCalledOnce();
    const updateStatusArgs = (sc.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateStatusArgs[0]).toBe('/ws/request-001');
    expect(updateStatusArgs[1]).toBe('/ws/request-001/context-human/specs/feature-test.md');
    expect(updateStatusArgs[2]).toMatchObject({ status: 'complete' });
    expect(callOrder.indexOf('updateStatus')).toBeLessThan(callOrder.indexOf('createPR'));
  });

  it('updateStatus rejection is non-fatal: createPR still called', async () => {
    const adapter = makeMockAdapter();
    const sc = makeSpecCommitter({
      updateStatus: vi.fn().mockRejectedValue(new Error('file not found')),
    });
    const prManager = makePRManager();
    const orch = makeApprovalOrch2({ adapter, prManager, specCommitter: sc });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    expect(prManager.createPR).toHaveBeenCalledOnce();
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('pr_open');
  });

  it('specPublisher.updateStatus called with "Complete" when publisher_ref is set', async () => {
    const adapter = makeMockAdapter();
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const specPublisher = makeSpecPublisher({ updateStatus });
    // Use OrchestratorImpl directly to inject the custom specPublisher
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher,
        intentClassifier: makeIntentClassifier('approval'),
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        prManager: makePRManager(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    // Inject run with publisher_ref set
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation', publisher_ref: 'CANVAS001' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => {
      const r = runs.get('request-001');
      return r?.stage === 'pr_open' || r?.stage === 'failed';
    }, { timeout: 3000 });
    await orch.stop();

    const statusCalls = (updateStatus as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(statusCalls).toContain('Complete');
  });
});

describe('Orchestrator — _handleImplementationApproval failure paths', () => {
  it('PRManager.createPR rejects: error posted to Slack; run transitions to failed', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const prManager = makePRManager({
      createPR: vi.fn().mockRejectedValue(new Error('gh pr create failed')),
    });
    const orch = makeApprovalOrch2({ adapter, prManager, postError });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('gh pr create failed'));
  });

  it('postMessage for PR link rejects: run still transitions to pr_open (PR was created)', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockRejectedValue(new Error('Slack error'));
    const postError = vi.fn().mockResolvedValue(undefined);
    const orch = makeApprovalOrch2({ adapter, postMessage, postError });
    await orch.start();
    await sendImplApproval(orch, adapter);
    await orch.stop();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('pr_open');
    expect(postError).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// _handlePrMerge tests
// ──────────────────────────────────────────────────────────────────────────────

function makeApprovalOrch3(opts: {
  prManager?: PRManager;
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
      prManager: opts.prManager ?? makePRManager(),
      postError: opts.postError ?? vi.fn().mockResolvedValue(undefined),
      postMessage: opts.postMessage ?? vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    } as never,
    { logDestination: nullDest },
  );
}

describe('Orchestrator — _handlePrMerge happy path', () => {
  it('approval + pr_open: mergePR called with workspace_path and pr_url; run transitions to done; "PR merged." posted', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const prManager = makePRManager();
    const orch = makeApprovalOrch3({ adapter, prManager, postMessage });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'pr_open', pr_url: 'https://github.com/org/repo/pull/42' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => {
        const r = runs.get('request-001');
        return r?.stage === 'done' || r?.stage === 'failed';
      },
      { timeout: 3000 },
    );
    await orch.stop();

    expect(prManager.mergePR).toHaveBeenCalledOnce();
    expect(prManager.mergePR).toHaveBeenCalledWith('/ws/request-001', 'https://github.com/org/repo/pull/42');
    expect(runs.get('request-001')!.stage).toBe('done');
    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    expect(messages.some(m => m === 'PR merged.')).toBe(true);
  });
});

describe('Orchestrator — _handlePrMerge failure paths', () => {
  it('mergePR rejection: postError called; run transitions to failed', async () => {
    const adapter = makeMockAdapter();
    const postError = vi.fn().mockResolvedValue(undefined);
    const prManager = makePRManager({
      mergePR: vi.fn().mockRejectedValue(new Error('merge conflict')),
    });
    const orch = makeApprovalOrch3({ adapter, prManager, postError });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'pr_open', pr_url: 'https://github.com/org/repo/pull/42' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 3000 });
    await orch.stop();

    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('merge conflict'));
  });

  it('run.pr_url undefined: mergePR NOT called; error message posted', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const prManager = makePRManager();
    const orch = makeApprovalOrch3({ adapter, prManager, postMessage });
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    // pr_url is undefined (no PR created yet)
    runs.set('request-001', makeRun({ stage: 'pr_open', pr_url: undefined }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    expect(prManager.mergePR).not.toHaveBeenCalled();
    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    expect(messages.some(m => m.includes('no PR URL'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pr_open routing guard tests
// ──────────────────────────────────────────────────────────────────────────────

describe('Orchestrator — pr_open routing guards', () => {
  it('question + pr_open: questionAnswerer.answer called; run stage stays pr_open', async () => {
    const adapter = makeMockAdapter();
    const qa = makeQuestionAnswerer('Here is the answer.');
    const ic = makeIntentClassifier('question');
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        questionAnswerer: qa,
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        prManager: makePRManager(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'pr_open', pr_url: 'https://github.com/org/repo/pull/42' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback({ content: 'What does this PR do?' }) });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    expect(qa.answer).toHaveBeenCalledWith('What does this PR do?');
    expect(runs.get('request-001')!.stage).toBe('pr_open');
  });

  it('feedback + pr_open: postMessage called with "A PR is already open"; run stage stays pr_open', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const ic = makeIntentClassifier('feedback');
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        prManager: makePRManager(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'pr_open', pr_url: 'https://github.com/org/repo/pull/42' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    const messages = (postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[2] as string);
    expect(messages.some(m => m.includes('A PR is already open'))).toBe(true);
    expect(runs.get('request-001')!.stage).toBe('pr_open');
  });

  it('ignore + pr_open: no handlers called; run stage stays pr_open', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const ic = makeIntentClassifier('ignore');
    const prManager = makePRManager();
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        prManager,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'pr_open', pr_url: 'https://github.com/org/repo/pull/42' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 100));
    await orch.stop();

    expect(prManager.mergePR).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(runs.get('request-001')!.stage).toBe('pr_open');
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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
      pr_url: undefined,
      last_impl_result: undefined,
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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

  it('thread_message with question intent: questionAnswerer.answer called with feedback content, response posted', async () => {
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
        channelRepoMap: makeChannelRepoMap(),
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
    // Note: _classify advances stage to 'implementing' before dispatching; question handler does not revert it
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
        channelRepoMap: makeChannelRepoMap(),
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
        channelRepoMap: makeChannelRepoMap(),
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
      channelRepoMap: makeChannelRepoMap(),
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
      channelRepoMap: makeChannelRepoMap(),
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
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    await orch.start();

    const run: Run = {
      id: 'run-1', request_id: 'req-speccing', intent: 'idea', stage: 'speccing',
      workspace_path: '/ws', branch: 'b', spec_path: undefined, publisher_ref: undefined,
      impl_feedback_ref: undefined, attempt: 0, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'C1', thread_ts: '100.0',
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
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    await orch.start();

    const run: Run = {
      id: 'run-1', request_id: 'req-impl', intent: 'idea', stage: 'implementing',
      workspace_path: '/ws', branch: 'b', spec_path: '/spec.md', publisher_ref: 'PAGE1',
      impl_feedback_ref: undefined, attempt: 1, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'C1', thread_ts: '100.0',
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
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    await orch.start();

    const run: Run = {
      id: 'run-1', request_id: 'req-review', intent: 'idea', stage: 'reviewing_spec',
      workspace_path: '/ws', branch: 'b', spec_path: '/spec.md', publisher_ref: 'PAGE1',
      impl_feedback_ref: undefined, attempt: 0, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'C1', thread_ts: '100.0',
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
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 10 });

    const run: Run = {
      id: 'run-1', request_id: 'req-dup', intent: 'idea', stage: 'reviewing_spec',
      workspace_path: '/ws', branch: 'b', spec_path: '/spec.md', publisher_ref: 'PAGE1',
      impl_feedback_ref: undefined, attempt: 0, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'C1', thread_ts: '100.0',
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
      channelRepoMap: makeChannelRepoMap(),
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
      channelRepoMap: makeChannelRepoMap(),
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
      channelRepoMap: makeChannelRepoMap(),
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
      channelRepoMap: makeChannelRepoMap(),
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

describe('_runLoop — classify-dispatch integration', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('two concurrent new_request events both dispatched before either resolves', async () => {
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
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 2 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;

    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r2' }) });

    // Both handlers should be entered before either resolves
    await vi.waitUntil(() => callCount === 2, { timeout: 500 });
    expect(callCount).toBe(2);
    expect((orch as unknown as { _inFlight: Set<unknown> })._inFlight.size).toBe(2);

    ctrl1.resolve();
    ctrl2.resolve();
    await orch.stop();
  });

  it('stop() waits for all in-flight handlers to complete', async () => {
    const ctrl = makeControllablePromise();
    let handlerDone = false;
    const handleReq = vi.fn().mockImplementation(async () => {
      await ctrl.promise;
      handlerDone = true;
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await vi.waitUntil(() => handleReq.mock.calls.length === 1, { timeout: 200 });

    const stopPromise = orch.stop();
    // Handler not done yet
    expect(handlerDone).toBe(false);

    // Resolve the handler
    ctrl.resolve();
    await stopPromise;
    expect(handlerDone).toBe(true);
  });

  it('stop() with queued event: promotes queued handler and drains before resolving', async () => {
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
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    await vi.waitUntil(() => callCount === 1, { timeout: 200 });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r2' }) });

    // Wait until r2 has been classified and placed into the orchestrator's _queue
    // before stopping. Without this, _stopping=true may cause the for-await loop
    // to break before processing r2 from the adapter's event queue.
    await vi.waitUntil(
      () => (orch as unknown as { _queue: unknown[] })._queue.length > 0,
      { timeout: 200 },
    );

    // Stop while handler 1 is running and handler 2 is queued
    const stopPromise = orch.stop();
    ctrl1.resolve(); // triggers dequeue of r2
    await vi.waitUntil(() => callCount === 2, { timeout: 200 });
    ctrl2.resolve();
    await stopPromise;
    expect(callCount).toBe(2);
  });
});

describe('metrics instrumentation', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('orchestrator.in_flight gauge emitted on dispatch and release', async () => {
    const { records, destination } = makeLogCapture();
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
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    const event = makeEventFixture('new_request');
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(event);
    await vi.waitUntil(() => handleReq.mock.calls.length === 1, { timeout: 200 });

    // dispatch gauge emitted (value=1)
    const dispatchGauge = records.find(r => r['metric'] === 'orchestrator.in_flight' && r['value'] === 1);
    expect(dispatchGauge).toBeDefined();

    ctrl.resolve();
    await vi.waitUntil(() => records.some(r => r['metric'] === 'orchestrator.in_flight' && r['value'] === 0), { timeout: 200 });

    // release gauge emitted (value=0)
    const releaseGauge = records.find(r => r['metric'] === 'orchestrator.in_flight' && r['value'] === 0);
    expect(releaseGauge).toBeDefined();

    await orch.stop();
  });

  it('orchestrator.queue_depth gauge emitted on enqueue and after dequeue', async () => {
    const { records, destination } = makeLogCapture();
    const ctrl = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? ctrl.promise : Promise.resolve();
    });
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1, logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    const e1 = makeEventFixture('new_request', { id: 'r1' });
    const e2 = makeEventFixture('new_request', { id: 'r2' });
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(e1);
    await vi.waitUntil(() => callCount === 1, { timeout: 200 });
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(e2);

    // After enqueue: queue_depth should have been emitted with value 1
    await vi.waitUntil(() => records.some(r => r['metric'] === 'orchestrator.queue_depth' && r['value'] === 1), { timeout: 200 });
    expect(records.some(r => r['metric'] === 'orchestrator.queue_depth' && r['value'] === 1)).toBe(true);

    ctrl.resolve();
    await vi.waitUntil(() => callCount === 2, { timeout: 200 });

    // After dequeue: queue_depth emitted with value 0
    await vi.waitUntil(() => records.some(r => r['metric'] === 'orchestrator.queue_depth' && r['value'] === 0), { timeout: 200 });
    expect(records.some(r => r['metric'] === 'orchestrator.queue_depth' && r['value'] === 0)).toBe(true);

    await orch.stop();
  });

  it('orchestrator.queue_wait_ms recorded with non-negative value for queued events', async () => {
    const { records, destination } = makeLogCapture();
    const ctrl = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? ctrl.promise : Promise.resolve();
    });
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1, logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    const e1 = makeEventFixture('new_request', { id: 'r1' });
    const e2 = makeEventFixture('new_request', { id: 'r2' });
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(e1);
    await vi.waitUntil(() => callCount === 1, { timeout: 200 });
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(e2);

    ctrl.resolve();
    await vi.waitUntil(() => records.some(r => r['metric'] === 'orchestrator.queue_wait_ms'), { timeout: 200 });
    const waitMs = records.find(r => r['metric'] === 'orchestrator.queue_wait_ms');
    expect(waitMs).toBeDefined();
    expect(typeof waitMs!['value']).toBe('number');
    expect(waitMs!['value'] as number).toBeGreaterThanOrEqual(0);

    await orch.stop();
  });
});

describe('serial classification — additional coverage', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('classification serial guarantee: no handler entered before its classify call returns', async () => {
    const classifyOrder: string[] = [];
    const handleOrder: string[] = [];

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 10 });

    const origClassify = (orch as unknown as { _classify: (e: unknown) => Promise<string> })._classify.bind(orch);
    (orch as unknown as { _classify: (e: unknown) => Promise<string> })._classify = async (e: unknown) => {
      const result = await origClassify(e);
      const payload = (e as { payload: { id?: string; request_id?: string } }).payload;
      classifyOrder.push(payload.id ?? payload.request_id ?? 'unknown');
      return result;
    };
    const origHandleReq = (orch as unknown as { _handleRequest: (e: unknown) => Promise<void> })._handleRequest.bind(orch);
    (orch as unknown as { _handleRequest: (e: unknown) => Promise<void> })._handleRequest = async (e: unknown) => {
      const payload = (e as { payload: { id?: string; request_id?: string } }).payload;
      handleOrder.push(payload.id ?? payload.request_id ?? 'unknown');
      return origHandleReq(e);
    };

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r2' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r3' }) });

    await vi.waitUntil(() => classifyOrder.length === 3 && handleOrder.length === 3, { timeout: 500 });

    // Each event's classify must resolve before or at the same time its handler is entered
    expect(classifyOrder.indexOf('r1')).toBeLessThanOrEqual(handleOrder.indexOf('r1'));
    expect(classifyOrder.indexOf('r2')).toBeLessThanOrEqual(handleOrder.indexOf('r2'));
    expect(classifyOrder.indexOf('r3')).toBeLessThanOrEqual(handleOrder.indexOf('r3'));

    await orch.stop();
  });

  it('two new_request events for different runs: both dispatched, no request_id cross-contamination', async () => {
    const receivedIds: string[] = [];
    const handleReq = vi.fn().mockImplementation((e: unknown) => {
      receivedIds.push(((e as { payload: { id: string } }).payload.id));
      return Promise.resolve();
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 5 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'alpha' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'beta' }) });

    await vi.waitUntil(() => receivedIds.length === 2, { timeout: 300 });
    expect(receivedIds).toContain('alpha');
    expect(receivedIds).toContain('beta');
    expect(receivedIds[0]).not.toBe(receivedIds[1]);

    await orch.stop();
  });
});

describe('concurrent dispatch — additional coverage', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('stage isolation: transitions for run A have no effect on run B stage', async () => {
    const ctrlA = makeControllablePromise();
    const ctrlB = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? ctrlA.promise : ctrlB.promise;
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 2 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;

    const runA: Run = {
      id: 'run-a', request_id: 'req-a', intent: 'idea', stage: 'reviewing_spec',
      workspace_path: '/ws/a', branch: 'ba', spec_path: '/spec-a.md', publisher_ref: 'PAGE-A',
      impl_feedback_ref: undefined, attempt: 0, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'CA', thread_ts: 'A.0',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const runB: Run = {
      id: 'run-b', request_id: 'req-b', intent: 'idea', stage: 'reviewing_spec',
      workspace_path: '/ws/b', branch: 'bb', spec_path: '/spec-b.md', publisher_ref: 'PAGE-B',
      impl_feedback_ref: undefined, attempt: 0, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'CB', thread_ts: 'B.0',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-a', runA);
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-b', runB);

    await orch.start();
    adapter._emit({ type: 'thread_message', payload: { request_id: 'req-a', content: 'approve', author: 'U1', received_at: new Date().toISOString(), thread_ts: 'A.0', channel_id: 'CA' } });
    adapter._emit({ type: 'thread_message', payload: { request_id: 'req-b', content: 'approve', author: 'U2', received_at: new Date().toISOString(), thread_ts: 'B.0', channel_id: 'CB' } });

    await vi.waitUntil(() => callCount === 2, { timeout: 300 });

    // Both runs advanced to implementing by _classify
    expect(runA.stage).toBe('implementing');
    expect(runB.stage).toBe('implementing');

    // Mutating runA's stage should not affect runB
    runA.stage = 'done';
    expect(runB.stage).toBe('implementing');

    ctrlA.resolve();
    ctrlB.resolve();
    await orch.stop();
  });

  it('each concurrent handler receives its own channel_id, thread_ts, request_id', async () => {
    const receivedPayloads: Array<{ id?: string; channel_id?: string; thread_ts?: string }> = [];
    const ctrlA = makeControllablePromise();
    const ctrlB = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation((e: unknown) => {
      receivedPayloads.push((e as { payload: { id?: string; channel_id?: string; thread_ts?: string } }).payload);
      callCount++;
      return callCount === 1 ? ctrlA.promise : ctrlB.promise;
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 2 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1', channel_id: 'C1', thread_ts: '1.0' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r2', channel_id: 'C2', thread_ts: '2.0' }) });

    await vi.waitUntil(() => callCount === 2, { timeout: 300 });

    const ids = receivedPayloads.map(p => p.id);
    expect(ids).toContain('r1');
    expect(ids).toContain('r2');
    const channels = receivedPayloads.map(p => p.channel_id);
    expect(channels).toContain('C1');
    expect(channels).toContain('C2');
    expect(channels[0]).not.toBe(channels[1]);

    ctrlA.resolve();
    ctrlB.resolve();
    await orch.stop();
  });
});

describe('failure isolation', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('unhandled throw in run A: run.unhandled_error logged; run B unaffected', async () => {
    const { records, destination } = makeLogCapture();
    const ctrlB = makeControllablePromise();
    let bCompleted = false;
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('run-A-boom'));
      return ctrlB.promise.then(() => { bCompleted = true; });
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 2, logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r2' }) });

    await vi.waitUntil(() => records.some(r => r['event'] === 'run.unhandled_error'), { timeout: 300 });
    expect(records.find(r => r['event'] === 'run.unhandled_error')!['error']).toContain('run-A-boom');

    ctrlB.resolve();
    await vi.waitUntil(() => bCompleted, { timeout: 200 });
    expect(bCompleted).toBe(true);

    // _inFlight decrements correctly
    await vi.waitUntil(
      () => (orch as unknown as { _inFlight: Set<unknown> })._inFlight.size === 0,
      { timeout: 200 },
    );
    expect((orch as unknown as { _inFlight: Set<unknown> })._inFlight.size).toBe(0);

    await orch.stop();
  });

  it('_inFlight cleanup after unhandled throw: no ghost entries', async () => {
    const handleReq = vi.fn().mockRejectedValue(new Error('ghost'));
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(makeEventFixture('new_request'));
    await vi.waitUntil(
      () => (orch as unknown as { _inFlight: Set<unknown> })._inFlight.size === 0,
      { timeout: 200 },
    );
    expect((orch as unknown as { _inFlight: Set<unknown> })._inFlight.size).toBe(0);

    await orch.stop();
  });

  it('queue continues after failure: run A fails while run C queued; C still dispatched', async () => {
    const { records, destination } = makeLogCapture();
    const ctrlA = makeControllablePromise();
    const ctrlC = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return ctrlA.promise;
      if (callCount === 2) return ctrlC.promise;
      return Promise.resolve();
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1, logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    await vi.waitUntil(() => callCount === 1, { timeout: 200 });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'rC' }) });
    // Wait until rC is classified and queued before failing r1
    await vi.waitUntil(
      () => (orch as unknown as { _queue: unknown[] })._queue.length > 0,
      { timeout: 200 },
    );

    // Now fail run A — should trigger dequeue of rC
    ctrlA.reject(new Error('A-fail'));
    await vi.waitUntil(() => callCount === 2, { timeout: 300 });
    expect(records.find(r => r['event'] === 'run.dequeued')).toBeDefined();

    ctrlC.resolve();
    await orch.stop();
  });
});

describe('concurrency limit and queue', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('FIFO ordering: maxConcurrentRuns:1, 4 events dispatched in arrival order', async () => {
    const dispatchOrder: string[] = [];
    const ctrls = [
      makeControllablePromise(), makeControllablePromise(),
      makeControllablePromise(), makeControllablePromise(),
    ];
    let idx = 0;
    const handleReq = vi.fn().mockImplementation((e: unknown) => {
      dispatchOrder.push((e as { payload: { id: string } }).payload.id);
      return ctrls[idx++].promise;
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'e1' }) });
    await vi.waitUntil(() => dispatchOrder.length === 1, { timeout: 200 });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'e2' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'e3' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'e4' }) });

    ctrls[0].resolve();
    await vi.waitUntil(() => dispatchOrder.length === 2, { timeout: 200 });
    ctrls[1].resolve();
    await vi.waitUntil(() => dispatchOrder.length === 3, { timeout: 200 });
    ctrls[2].resolve();
    await vi.waitUntil(() => dispatchOrder.length === 4, { timeout: 200 });
    ctrls[3].resolve();

    expect(dispatchOrder).toEqual(['e1', 'e2', 'e3', 'e4']);

    await orch.stop();
  });

  it('maxConcurrentRuns:1 effectively serial: second begins only after first completes', async () => {
    let firstEnd = 0;
    let secondStart = 0;
    const ctrl = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return ctrl.promise.then(() => { firstEnd = Date.now(); });
      }
      secondStart = Date.now();
      return Promise.resolve();
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    await vi.waitUntil(() => callCount === 1, { timeout: 200 });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r2' }) });

    ctrl.resolve();
    await vi.waitUntil(() => callCount === 2, { timeout: 200 });
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);

    await orch.stop();
  });

  it('boundary: exactly at limit then above; both extras dequeued in FIFO', async () => {
    const dispatchOrder: string[] = [];
    const ctrls = [
      makeControllablePromise(), makeControllablePromise(), makeControllablePromise(),
      makeControllablePromise(), makeControllablePromise(),
    ];
    let callIdx = 0;
    const handleReq = vi.fn().mockImplementation((e: unknown) => {
      dispatchOrder.push((e as { payload: { id: string } }).payload.id);
      return ctrls[callIdx++].promise;
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 3 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r2' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r3' }) });
    await vi.waitUntil(() => callIdx === 3, { timeout: 300 });

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r4' }) });
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r5' }) });
    await vi.waitUntil(() => (orch as unknown as { _queue: unknown[] })._queue.length === 2, { timeout: 200 });

    ctrls[0].resolve();
    await vi.waitUntil(() => callIdx === 4, { timeout: 200 });
    ctrls[1].resolve();
    await vi.waitUntil(() => callIdx === 5, { timeout: 200 });
    ctrls[2].resolve(); ctrls[3].resolve(); ctrls[4].resolve();

    await vi.waitUntil(() => dispatchOrder.length === 5, { timeout: 300 });
    expect(dispatchOrder.slice(3)).toEqual(['r4', 'r5']);

    await orch.stop();
  });

  it('queue and in-flight both empty after all processing completes', async () => {
    const handleReq = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 2 });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    for (let i = 1; i <= 4; i++) {
      adapter._emit({ type: 'new_request', payload: makeRequest({ id: `r${i}` }) });
    }

    await orch.stop();
    expect((orch as unknown as { _inFlight: Set<unknown> })._inFlight.size).toBe(0);
    expect((orch as unknown as { _queue: unknown[] })._queue.length).toBe(0);
  });
});

describe('stop drain — remaining cases', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('no post-stop errors: completing handlers do not log additional errors', async () => {
    const { records, destination } = makeLogCapture();
    const ctrl = makeControllablePromise();
    let handlerRan = false;
    const handleReq = vi.fn().mockImplementation(() =>
      ctrl.promise.then(() => { handlerRan = true; }),
    );

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await vi.waitUntil(() => handleReq.mock.calls.length === 1, { timeout: 200 });

    const errsBefore = records.filter(r => r['level'] === 50).length;
    const stopPromise = orch.stop();
    ctrl.resolve();
    await stopPromise;

    expect(handlerRan).toBe(true);
    const errsAfter = records.filter(r => r['level'] === 50).length;
    expect(errsAfter).toBe(errsBefore);
  });

  it('_stopping breaks receive loop: no new events dequeued after stop', async () => {
    const dispatchedIds: string[] = [];
    const ctrl = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation((e: unknown) => {
      callCount++;
      dispatchedIds.push((e as { payload: { id: string } }).payload.id);
      return callCount === 1 ? ctrl.promise : Promise.resolve();
    });

    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();

    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r1' }) });
    await vi.waitUntil(() => callCount === 1, { timeout: 200 });

    const stopPromise = orch.stop();
    // Emit after stop is called — should not be dispatched
    adapter._emit({ type: 'new_request', payload: makeRequest({ id: 'r-post-stop' }) });

    ctrl.resolve();
    await stopPromise;

    expect(dispatchedIds).not.toContain('r-post-stop');
  });
});

describe('observability — log field correctness', () => {
  beforeEach(() => { _fixtureSeq = 0; });

  it('classify.run_not_found includes request_id field', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    await orch.start();
    const e = makeEventFixture('thread_message', { request_id: 'no-such-run' });
    await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(e);
    const log = records.find(r => r['event'] === 'classify.run_not_found');
    expect(log!['request_id']).toBe('no-such-run');
    await orch.stop();
  });

  it('classify.stage_blocked includes stage field', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    await orch.start();
    const run: Run = {
      id: 'x', request_id: 'req-done', intent: 'idea', stage: 'done',
      workspace_path: '', branch: '', spec_path: undefined, publisher_ref: undefined,
      impl_feedback_ref: undefined, attempt: 0, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'C', thread_ts: 'T',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-done', run);
    const e = makeEventFixture('thread_message', { request_id: 'req-done' });
    await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(e);
    const log = records.find(r => r['event'] === 'classify.stage_blocked');
    expect(log!['stage']).toBe('done');
    await orch.stop();
  });

  it('classify.dispatched includes stage field (post-advance value)', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    await orch.start();
    const run: Run = {
      id: 'x', request_id: 'req-rev', intent: 'idea', stage: 'reviewing_spec',
      workspace_path: '', branch: '', spec_path: '/s.md', publisher_ref: 'P',
      impl_feedback_ref: undefined, attempt: 0, pr_url: undefined, last_impl_result: undefined,
      channel_id: 'C', thread_ts: 'T',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    (orch as unknown as { runs: Map<string, Run> }).runs.set('req-rev', run);
    const e = makeEventFixture('thread_message', { request_id: 'req-rev' });
    await (orch as unknown as { _classify(e: unknown): Promise<string> })._classify(e);
    const log = records.find(r => r['event'] === 'classify.dispatched');
    expect(log!['stage']).toBe('implementing');
    await orch.stop();
  });

  it('run.dispatched includes in_flight field', async () => {
    const { records, destination } = makeLogCapture();
    const handleReq = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(makeEventFixture('new_request'));
    await vi.waitUntil(() => handleReq.mock.calls.length === 1, { timeout: 200 });
    const log = records.find(r => r['event'] === 'run.dispatched');
    expect(typeof log!['in_flight']).toBe('number');
    await orch.stop();
  });

  it('run.queued includes queue_depth field', async () => {
    const { records, destination } = makeLogCapture();
    const ctrl = makeControllablePromise();
    const handleReq = vi.fn().mockReturnValue(ctrl.promise);
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1, logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(makeEventFixture('new_request', { id: 'r1' }));
    await vi.waitUntil(() => handleReq.mock.calls.length === 1, { timeout: 200 });
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(makeEventFixture('new_request', { id: 'r2' }));
    const log = records.find(r => r['event'] === 'run.queued');
    expect(typeof log!['queue_depth']).toBe('number');
    expect(log!['queue_depth']).toBe(1);
    ctrl.resolve();
    await orch.stop();
  });

  it('run.dequeued includes in_flight and queue_depth fields', async () => {
    const { records, destination } = makeLogCapture();
    const ctrl = makeControllablePromise();
    let callCount = 0;
    const handleReq = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? ctrl.promise : Promise.resolve();
    });
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { maxConcurrentRuns: 1, logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(makeEventFixture('new_request', { id: 'r1' }));
    await vi.waitUntil(() => callCount === 1, { timeout: 200 });
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(makeEventFixture('new_request', { id: 'r2' }));
    ctrl.resolve();
    await vi.waitUntil(() => records.some(r => r['event'] === 'run.dequeued'), { timeout: 200 });
    const log = records.find(r => r['event'] === 'run.dequeued');
    expect(typeof log!['in_flight']).toBe('number');
    expect(typeof log!['queue_depth']).toBe('number');
    await orch.stop();
  });

  it('run.unhandled_error includes error field', async () => {
    const { records, destination } = makeLogCapture();
    const handleReq = vi.fn().mockRejectedValue(new Error('oops'));
    const adapter = makeMockAdapter();
    const orch = new OrchestratorImpl({
      adapter,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn(),
      postMessage: vi.fn(),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: destination });
    (orch as unknown as { _handleRequest: typeof handleReq })._handleRequest = handleReq;
    await orch.start();
    (orch as unknown as { _dispatchOrEnqueue(e: unknown): void })._dispatchOrEnqueue(makeEventFixture('new_request'));
    await vi.waitUntil(() => records.some(r => r['event'] === 'run.unhandled_error'), { timeout: 200 });
    const log = records.find(r => r['event'] === 'run.unhandled_error');
    expect(typeof log!['error']).toBe('string');
    expect(log!['error']).toContain('oops');
    await orch.stop();
  });
});

describe('Orchestrator — _startSpecPipeline onProgress wiring', () => {
  it('specGenerator.create() receives an onProgress function', async () => {
    const adapter = makeMockAdapter();
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const createFn = vi.fn().mockImplementation(async (_req: unknown, _wp: string, onProg?: (m: string) => Promise<void>) => {
      capturedOnProgress = onProg;
      return '/ws/request-001/context-human/specs/feature-test.md';
    });
    const sg = makeSpecGenerator({ create: createFn });
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('idea'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    const event = makeEventFixture('new_request');
    adapter._emit(event);
    await vi.waitUntil(() => {
      const runs = (orch as unknown as { runs: Map<string, unknown> }).runs;
      const run = [...runs.values()][0] as { stage: string } | undefined;
      return run?.stage === 'reviewing_spec';
    }, { timeout: 3000 });
    await orch.stop();

    expect(capturedOnProgress).toBeTypeOf('function');
  });

  it('create() onProgress invokes postMessage with correct channel_id, thread_ts, and message', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const createFn = vi.fn().mockImplementation(async (_req: unknown, _wp: string, onProg?: (m: string) => Promise<void>) => {
      capturedOnProgress = onProg;
      return '/ws/request-001/context-human/specs/feature-test.md';
    });
    const sg = makeSpecGenerator({ create: createFn });
    const event = makeEventFixture('new_request');
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('idea'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit(event);
    await vi.waitUntil(() => {
      const runs = (orch as unknown as { runs: Map<string, unknown> }).runs;
      const run = [...runs.values()][0] as { stage: string } | undefined;
      return run?.stage === 'reviewing_spec';
    }, { timeout: 3000 });
    await orch.stop();

    await capturedOnProgress!('Analyzing requirements');

    const progressCalls = (postMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[2] === 'Analyzing requirements');
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0][0]).toBe(event.payload.channel_id);
    expect(progressCalls[0][1]).toBe(event.payload.thread_ts);
  });

  it('postMessage rejection in create() onProgress does not fail the run, progress_failed logged at warn', async () => {
    const adapter = makeMockAdapter();
    const { records, destination } = makeLogCapture();
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const createFn = vi.fn().mockImplementation(async (_req: unknown, _wp: string, onProg?: (m: string) => Promise<void>) => {
      capturedOnProgress = onProg;
      return '/ws/request-001/context-human/specs/feature-test.md';
    });
    const sg = makeSpecGenerator({ create: createFn });
    const postMessage = vi.fn().mockImplementation((_ch: string, _ts: string, msg: string) => {
      if (msg === 'spec progress relay') return Promise.reject(new Error('slack unavailable'));
      return Promise.resolve();
    });
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: makeIntentClassifier('idea'),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: destination },
    );
    await orch.start();
    adapter._emit(makeEventFixture('new_request'));
    await vi.waitUntil(() => {
      const runs = (orch as unknown as { runs: Map<string, unknown> }).runs;
      const run = [...runs.values()][0] as { stage: string } | undefined;
      return run?.stage === 'reviewing_spec';
    }, { timeout: 3000 });
    await orch.stop();

    if (capturedOnProgress) {
      await capturedOnProgress('spec progress relay').catch(() => {});
      await new Promise(r => setTimeout(r, 0));
    }

    const failLog = records.find(r => r['event'] === 'progress_failed' && r['phase'] === 'spec_generation');
    expect(failLog).toBeDefined();
    expect(String(failLog!['error'])).toContain('slack unavailable');
  });
});

describe('Orchestrator — _handleSpecFeedback onProgress wiring', () => {
  it('specGenerator.revise() receives an onProgress function', async () => {
    const adapter = makeMockAdapter();
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const reviseFn = vi.fn().mockImplementation(async (...args: unknown[]) => {
      capturedOnProgress = args[5] as ((m: string) => Promise<void>) | undefined;
      return { comment_responses: [] };
    });
    const sg = makeSpecGenerator({ revise: reviseFn });
    const ic = makeIntentClassifier('feedback');
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => runs.get('request-001')?.stage === 'reviewing_spec' && reviseFn.mock.calls.length > 0,
      { timeout: 3000 },
    );
    await orch.stop();

    expect(capturedOnProgress).toBeTypeOf('function');
  });

  it('revise() onProgress invokes postMessage with correct channel_id, thread_ts, and message', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const reviseFn = vi.fn().mockImplementation(async (...args: unknown[]) => {
      capturedOnProgress = args[5] as ((m: string) => Promise<void>) | undefined;
      return { comment_responses: [] };
    });
    const sg = makeSpecGenerator({ revise: reviseFn });
    const ic = makeIntentClassifier('feedback');
    const feedback = makeFeedback();
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: feedback });
    await vi.waitUntil(
      () => runs.get('request-001')?.stage === 'reviewing_spec' && reviseFn.mock.calls.length > 0,
      { timeout: 3000 },
    );
    await orch.stop();

    await capturedOnProgress!('Drafting technical section');

    const progressCalls = (postMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[2] === 'Drafting technical section');
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0][0]).toBe(feedback.channel_id);
    expect(progressCalls[0][1]).toBe(feedback.thread_ts);
  });

  it('postMessage rejection in revise() onProgress does not fail the run, progress_failed logged at warn', async () => {
    const adapter = makeMockAdapter();
    const { records, destination } = makeLogCapture();
    let capturedOnProgress: ((msg: string) => Promise<void>) | undefined;
    const reviseFn = vi.fn().mockImplementation(async (...args: unknown[]) => {
      capturedOnProgress = args[5] as ((m: string) => Promise<void>) | undefined;
      return { comment_responses: [] };
    });
    const sg = makeSpecGenerator({ revise: reviseFn });
    const ic = makeIntentClassifier('feedback');
    const postMessage = vi.fn().mockImplementation((_ch: string, _ts: string, msg: string) => {
      if (msg === 'revise progress relay') return Promise.reject(new Error('connection reset'));
      return Promise.resolve();
    });
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: sg,
        specPublisher: makeSpecPublisher(),
        intentClassifier: ic,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
      } as never,
      { logDestination: destination },
    );
    await orch.start();
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => runs.get('request-001')?.stage === 'reviewing_spec' && reviseFn.mock.calls.length > 0,
      { timeout: 3000 },
    );
    await orch.stop();

    if (capturedOnProgress) {
      await capturedOnProgress('revise progress relay').catch(() => {});
      await new Promise(r => setTimeout(r, 0));
    }

    const failLog = records.find(r => r['event'] === 'progress_failed' && r['phase'] === 'spec_generation');
    expect(failLog).toBeDefined();
    expect(String(failLog!['error'])).toContain('connection reset');
  });
});

describe('Orchestrator — implementation lifecycle status updates', () => {
  function makeOrchestratorWithNotionDeps(overrides: {
    specPublisherUpdateStatus?: ReturnType<typeof vi.fn>;
    implFeedbackPageUpdateStatus?: ReturnType<typeof vi.fn>;
    implFeedbackPageSetPRLink?: ReturnType<typeof vi.fn>;
    implFeedbackPageCreate?: ReturnType<typeof vi.fn>;
  } = {}) {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const updateStatus = overrides.specPublisherUpdateStatus ?? vi.fn().mockResolvedValue(undefined);
    const cp = makeSpecPublisher({ updateStatus });
    const sc = makeSpecCommitter();
    const impl = makeImplementer();
    const implFbUpdateStatus = overrides.implFeedbackPageUpdateStatus ?? vi.fn().mockResolvedValue(undefined);
    const implFbSetPRLink = overrides.implFeedbackPageSetPRLink ?? vi.fn().mockResolvedValue(undefined);
    const implFbCreate = overrides.implFeedbackPageCreate ?? vi.fn().mockResolvedValue('feedback-page-id');
    const implFb = makeImplFeedbackPage({
      create: implFbCreate,
      updateStatus: implFbUpdateStatus,
      setPRLink: implFbSetPRLink,
    });
    const prManager = makePRManager();
    return {
      adapter, wm, sg, cp, sc, impl, implFb, prManager,
      specPublisherUpdateStatus: updateStatus,
      implFeedbackPageUpdateStatus: implFbUpdateStatus,
      implFeedbackPageSetPRLink: implFbSetPRLink,
      implFeedbackPageCreate: implFbCreate,
    };
  }

  it('calls implFeedbackPage.updateStatus("In progress") and ("Waiting on feedback") during first implementation', async () => {
    const deps = makeOrchestratorWithNotionDeps();
    const ic = makeIntentClassifier('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: deps.adapter as never,
        workspaceManager: deps.wm,
        specGenerator: deps.sg,
        specPublisher: deps.cp,
        postError: vi.fn(),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
        specCommitter: deps.sc,
        implementer: deps.impl,
        implFeedbackPage: deps.implFb,
        prManager: deps.prManager,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    // Inject run with existing impl_feedback_ref to test 'In progress' call
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec', impl_feedback_ref: 'existing-feedback-id' }));
    deps.adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => runs.get('request-001')?.stage === 'reviewing_implementation' || runs.get('request-001')?.stage === 'failed',
      { timeout: 3000 },
    );
    await orch.stop();

    const statusCalls = (deps.implFeedbackPageUpdateStatus as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(statusCalls).toContain('In progress');
    expect(statusCalls).toContain('Waiting on feedback');
  });

  it('calls implFeedbackPage.updateStatus("Approved"), specPublisher.updateStatus("Complete"), and setPRLink on implementation approval', async () => {
    const deps = makeOrchestratorWithNotionDeps();
    const ic = makeIntentClassifier('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: deps.adapter as never,
        workspaceManager: deps.wm,
        specGenerator: deps.sg,
        specPublisher: deps.cp,
        postError: vi.fn(),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
        specCommitter: deps.sc,
        implementer: deps.impl,
        implFeedbackPage: deps.implFb,
        prManager: deps.prManager,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    // Inject run in reviewing_implementation with impl_feedback_ref set
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation', impl_feedback_ref: 'feedback-page-id', publisher_ref: 'CANVAS001' }));
    deps.adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => runs.get('request-001')?.stage === 'pr_open' || runs.get('request-001')?.stage === 'failed',
      { timeout: 3000 },
    );
    await orch.stop();

    const implStatusCalls = (deps.implFeedbackPageUpdateStatus as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(implStatusCalls).toContain('Approved');
    const specStatusCalls = (deps.specPublisherUpdateStatus as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(specStatusCalls).toContain('Complete');
    expect(deps.implFeedbackPageSetPRLink).toHaveBeenCalledWith('feedback-page-id', 'https://github.com/org/repo/pull/42');
  });

  it('implFeedbackPage.create() called with spec_title derived from spec_path', async () => {
    const deps = makeOrchestratorWithNotionDeps();
    const ic = makeIntentClassifier('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: deps.adapter as never,
        workspaceManager: deps.wm,
        specGenerator: deps.sg,
        specPublisher: deps.cp,
        postError: vi.fn(),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
        specCommitter: deps.sc,
        implementer: deps.impl,
        implFeedbackPage: deps.implFb,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    // spec_path from makeRun is '/ws/request-001/context-human/specs/feature-test.md'
    // titleFromPath('feature-test.md') -> 'Test'
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_spec' }));
    deps.adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => runs.get('request-001')?.stage === 'reviewing_implementation' || runs.get('request-001')?.stage === 'failed',
      { timeout: 3000 },
    );
    await orch.stop();

    const createCall = (deps.implFeedbackPageCreate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[2]).toBe('Test'); // spec_title is 3rd argument
  });

  it('one rejection in Promise.allSettled on implementation approval does not prevent others', async () => {
    const deps = makeOrchestratorWithNotionDeps({
      implFeedbackPageUpdateStatus: vi.fn().mockRejectedValue(new Error('status failed')),
      implFeedbackPageSetPRLink: vi.fn().mockResolvedValue(undefined),
      specPublisherUpdateStatus: vi.fn().mockResolvedValue(undefined),
    });
    const ic = makeIntentClassifier('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: deps.adapter as never,
        workspaceManager: deps.wm,
        specGenerator: deps.sg,
        specPublisher: deps.cp,
        postError: vi.fn(),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
        specCommitter: deps.sc,
        implementer: deps.impl,
        implFeedbackPage: deps.implFb,
        prManager: deps.prManager,
      } as never,
      { logDestination: nullDest },
    );
    await orch.start();

    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    runs.set('request-001', makeRun({ stage: 'reviewing_implementation', impl_feedback_ref: 'feedback-page-id', publisher_ref: 'CANVAS001' }));
    deps.adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(
      () => runs.get('request-001')?.stage === 'pr_open' || runs.get('request-001')?.stage === 'failed',
      { timeout: 3000 },
    );
    await orch.stop();

    // setPRLink and specPublisher.updateStatus('Complete') still called despite implFb.updateStatus rejection
    expect(deps.implFeedbackPageSetPRLink).toHaveBeenCalled();
    expect(deps.specPublisherUpdateStatus).toHaveBeenCalledWith(expect.any(String), 'Complete');
    // Run reaches 'pr_open' despite the rejection
    expect(runs.get('request-001')!.stage).toBe('pr_open');
  });
});

describe('Orchestrator — spec lifecycle status updates', () => {
  it('calls updateStatus("Waiting on feedback") after reviewing_spec transition in _startSpecPipeline', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const cp = makeSpecPublisher({ updateStatus });
    const ic = makeIntentClassifier('idea');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError: vi.fn(), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(updateStatus).toHaveBeenCalledWith('CANVAS001', 'Waiting on feedback');
  });

  it('updateStatus rejection after reviewing_spec transition: run still reaches reviewing_spec', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const updateStatus = vi.fn().mockRejectedValue(new Error('Notion down'));
    const cp = makeSpecPublisher({ updateStatus });
    const ic = makeIntentClassifier('idea');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError: vi.fn(), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('request-001')!.stage).toBe('reviewing_spec');
  });

  it('calls updateStatus("Speccing") after speccing transition in _handleSpecFeedback', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const cp = makeSpecPublisher({ updateStatus });
    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError: vi.fn(), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const statusCalls = (updateStatus as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[1]);
    expect(statusCalls).toContain('Speccing');
    expect(statusCalls).toContain('Waiting on feedback');
  });

  it('when specPublisher has no updateStatus (SlackCanvasPublisher pattern), optional chaining short-circuits, run reaches reviewing_spec', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    // makeSpecPublisher() without updateStatus — simulates SlackCanvasPublisher
    const cp = makeSpecPublisher();
    const ic = makeIntentClassifier('idea');

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError: vi.fn(), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: ic },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('request-001')!.stage).toBe('reviewing_spec');
  });
});

describe('Orchestrator — bug and chore routing', () => {
  it('new_request classified as bug: run.intent=bug, run reaches reviewing_spec', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('bug') },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    const run = runs.get('request-001')!;
    expect(run.intent).toBe('bug');
    expect(run.stage).toBe('reviewing_spec');
  });

  it('new_request classified as chore: run.intent=chore, run reaches reviewing_spec', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: cp, postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('chore') },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    const run = runs.get('request-001')!;
    expect(run.intent).toBe('chore');
    expect(run.stage).toBe('reviewing_spec');
  });

  it('bug routing: specGenerator.create called with intent=bug', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('bug') },
      { logDestination: nullDest },
    );
    await orch.start();
    const request = makeRequest();
    adapter._emit({ type: 'new_request', payload: request });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.create).toHaveBeenCalledWith(request, '/ws/request-001', expect.any(Function), 'bug');
  });

  it('chore routing: specGenerator.create called with intent=chore', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: makeWorkspaceManager(), specGenerator: sg, specPublisher: makeSpecPublisher(), postError: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('chore') },
      { logDestination: nullDest },
    );
    await orch.start();
    const request = makeRequest();
    adapter._emit({ type: 'new_request', payload: request });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.create).toHaveBeenCalledWith(request, '/ws/request-001', expect.any(Function), 'chore');
  });
});

describe('Orchestrator — triage pipeline error paths', () => {
  it('bug: workspace creation failure → failRun called; run marked failed', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager({ create: vi.fn().mockRejectedValue(new Error('clone failed')) });
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: makeSpecGenerator(), specPublisher: makeSpecPublisher(), postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('bug') },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('clone failed'));
  });

  it('chore: spec generator failure → workspace destroyed; failRun called', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator({ create: vi.fn().mockRejectedValue(new Error('triage failed')) });
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: sg, specPublisher: makeSpecPublisher(), postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('chore') },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('triage failed'));
    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });

  it('bug: publisher failure → workspace destroyed; failRun called', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const cp = makeSpecPublisher({ create: vi.fn().mockRejectedValue(new Error('publish failed')) });
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl(
      { adapter: adapter as never, workspaceManager: wm, specGenerator: makeSpecGenerator(), specPublisher: cp, postError, postMessage: vi.fn().mockResolvedValue(undefined), channelRepoMap: makeChannelRepoMap(), intentClassifier: makeIntentClassifier('bug') },
      { logDestination: nullDest },
    );
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('publish failed'));
    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });
});

describe('Orchestrator — bug/chore approval paths', () => {
  it('bug approval: triage content fetched from Notion via publisher_ref; new issue created; issue number stored', async () => {
    const adapter = makeMockAdapter();
    const cp = makeSpecPublisher({
      getPageMarkdown: vi.fn().mockResolvedValue('# Bug: login broken\n\nDetails here.'),
    });
    const im = makeIssueManager({ createIssue: vi.fn().mockResolvedValue(99) });
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('bug');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('bug')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError,
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: nullDest },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => {
      const s = runs.get('request-001')?.stage;
      return s !== 'reviewing_spec' && s !== 'speccing';
    }, { timeout: 2000 });
    await adapter.stop();

    expect(cp.getPageMarkdown).toHaveBeenCalledWith('CANVAS001');
    expect(im.createIssue).toHaveBeenCalledWith('/ws/request-001', 'Bug: login broken', '# Bug: login broken\n\nDetails here.');
    expect(runs.get('request-001')!.issue).toBe(99);
    expect(postError).not.toHaveBeenCalled();
  });

  it('bug approval: if run.issue already set, writeIssue called instead of createIssue', async () => {
    const adapter = makeMockAdapter();
    const cp = makeSpecPublisher({
      getPageMarkdown: vi.fn().mockResolvedValue('# Bug: login broken\n\nDetails here.'),
    });
    const im = makeIssueManager();

    const ic = makeIntentClassifier('bug');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('bug')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: nullDest },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    runs.get('request-001')!.issue = 55;

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => {
      const s = runs.get('request-001')?.stage;
      return s !== 'reviewing_spec' && s !== 'speccing';
    }, { timeout: 2000 });
    await adapter.stop();

    expect(im.writeIssue).toHaveBeenCalledWith('/ws/request-001', 55, '# Bug: login broken\n\nDetails here.');
    expect(im.createIssue).not.toHaveBeenCalled();
  });

  it('bug approval: Notion page properties updated with issue URL and Approved status', async () => {
    const adapter = makeMockAdapter();
    const setIssueLink = vi.fn().mockResolvedValue(undefined);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const cp = makeSpecPublisher({
      getPageMarkdown: vi.fn().mockResolvedValue('# Bug triage\n\nContent.'),
      setIssueLink,
      updateStatus,
    });
    const im = makeIssueManager({ createIssue: vi.fn().mockResolvedValue(77) });

    const ic = makeIntentClassifier('bug');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('bug')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: nullDest },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => {
      const s = runs.get('request-001')?.stage;
      return s !== 'reviewing_spec' && s !== 'speccing';
    }, { timeout: 2000 });
    await adapter.stop();

    expect(setIssueLink).toHaveBeenCalledWith('CANVAS001', 'https://github.com/org/repo.git/issues/77');
    expect(updateStatus).toHaveBeenCalledWith('CANVAS001', 'Approved');
  });

  it('bug approval: Notion property update failure is non-blocking — run proceeds to implementation', async () => {
    const adapter = makeMockAdapter();
    const logs: Record<string, unknown>[] = [];
    const dest = {
      write(s: string) {
        try { logs.push(JSON.parse(s) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };

    const cp = makeSpecPublisher({
      getPageMarkdown: vi.fn().mockResolvedValue('# Bug triage\n\nContent.'),
      setIssueLink: vi.fn().mockRejectedValue(new Error('notion down')),
      updateStatus: vi.fn().mockRejectedValue(new Error('notion down')),
    });
    const im = makeIssueManager({ createIssue: vi.fn().mockResolvedValue(88) });
    const implementer = makeImplementer();

    const ic = makeIntentClassifier('bug');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('bug')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: makeSpecCommitter(),
        implementer,
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: dest as import('pino').DestinationStream },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => {
      const s = runs.get('request-001')?.stage;
      return s !== 'reviewing_spec' && s !== 'speccing' && s !== 'implementing';
    }, { timeout: 2000 });
    await adapter.stop();

    expect(implementer.implement).toHaveBeenCalled();
    const statusFailed = logs.find(l => l['event'] === 'run.status_update_failed');
    expect(statusFailed).toBeDefined();
  });

  it('bug approval: Notion content fetch failure → failRun called; run does not proceed to implementation', async () => {
    const adapter = makeMockAdapter();
    const cp = makeSpecPublisher({
      getPageMarkdown: vi.fn().mockRejectedValue(new Error('notion fetch failed')),
    });
    const im = makeIssueManager();
    const implementer = makeImplementer();
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('bug');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('bug')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: makeSpecCommitter(),
        implementer,
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError,
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: nullDest },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 2000 });
    await adapter.stop();

    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('notion fetch failed'));
    expect(im.createIssue).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
  });

  it('chore approval: GitHub issue write failure → failRun called', async () => {
    const adapter = makeMockAdapter();
    const cp = makeSpecPublisher({
      getPageMarkdown: vi.fn().mockResolvedValue('# Chore: upgrade Node\n\nContent.'),
    });
    const im = makeIssueManager({ createIssue: vi.fn().mockRejectedValue(new Error('gh failed')) });
    const implementer = makeImplementer();
    const postError = vi.fn().mockResolvedValue(undefined);

    const ic = makeIntentClassifier('chore');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('chore')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: makeSpecCommitter(),
        implementer,
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError,
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: nullDest },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'failed', { timeout: 2000 });
    await adapter.stop();

    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('gh failed'));
    expect(implementer.implement).not.toHaveBeenCalled();
  });

  it('idea approval: spec file committed; setIssueLink NOT called; issueManager NOT called', async () => {
    const adapter = makeMockAdapter();
    const setIssueLink = vi.fn().mockResolvedValue(undefined);
    const cp = makeSpecPublisher({ setIssueLink });
    const sc = makeSpecCommitter();
    const im = makeIssueManager();

    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('idea')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: sc,
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: nullDest },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => {
      const s = runs.get('request-001')?.stage;
      return s !== 'reviewing_spec' && s !== 'speccing';
    }, { timeout: 2000 });
    await adapter.stop();

    expect(sc.commit).toHaveBeenCalled();
    expect(setIssueLink).not.toHaveBeenCalled();
    expect(im.createIssue).not.toHaveBeenCalled();
  });

  it('triage.approved log event emitted with correct fields on bug approval', async () => {
    const logs: Record<string, unknown>[] = [];
    const dest = {
      write(s: string) {
        try { logs.push(JSON.parse(s) as Record<string, unknown>); } catch { /* ignore */ }
      },
    };

    const adapter = makeMockAdapter();
    const cp = makeSpecPublisher({
      getPageMarkdown: vi.fn().mockResolvedValue('# Bug triage\n\nContent.'),
    });
    const im = makeIssueManager({ createIssue: vi.fn().mockResolvedValue(123) });

    const ic = makeIntentClassifier('bug');
    (ic.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('bug')
      .mockResolvedValueOnce('approval');

    const orch = new OrchestratorImpl(
      {
        adapter: adapter as never,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: cp,
        specCommitter: makeSpecCommitter(),
        implementer: makeImplementer(),
        implFeedbackPage: makeImplFeedbackPage(),
        issueManager: im,
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue(undefined),
        channelRepoMap: makeChannelRepoMap(),
        intentClassifier: ic,
      },
      { logDestination: dest as import('pino').DestinationStream },
    );

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    const runs = (orch as unknown as { runs: Map<string, Run> }).runs;
    await vi.waitUntil(() => runs.get('request-001')?.stage === 'reviewing_spec', { timeout: 2000 });

    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await vi.waitUntil(() => {
      const s = runs.get('request-001')?.stage;
      return s !== 'reviewing_spec' && s !== 'speccing';
    }, { timeout: 2000 });
    await adapter.stop();

    const triageApproved = logs.find(l => l['event'] === 'triage.approved');
    expect(triageApproved).toBeDefined();
    expect(triageApproved!['intent']).toBe('bug');
    expect(triageApproved!['issue_number']).toBe(123);
  });
});

describe('Orchestrator — file_issues routing', () => {
  it('new_request + file_issues intent → run reaches done with intent=file_issues', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const issueFiler = makeIssueFiler();
    const postMessage = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: wm,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage,
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: nullDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    const run = runs.get('request-001')!;
    expect(run.intent).toBe('file_issues');
    expect(run.stage).toBe('done');
    expect(issueFiler.file).toHaveBeenCalled();
  });
});

describe('Orchestrator — _startFilingPipeline error paths', () => {
  it('workspace creation failure → failRun; issueFiler.file() not called', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager({ create: vi.fn().mockRejectedValue(new Error('clone failed')) });
    const issueFiler = makeIssueFiler();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: wm,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError,
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: nullDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(issueFiler.file).not.toHaveBeenCalled();
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('clone failed'));
    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });

  it('issueFiler.file() throws → workspace destroyed; failRun called', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const issueFiler = makeIssueFiler();
    (issueFiler.file as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('enrichment failed'));
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: wm,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError,
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: nullDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('enrichment failed'));
    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });

  it('result.status === failed → workspace destroyed; failRun called with result.error', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const issueFiler = makeIssueFiler({
      status: 'failed',
      summary: '',
      filed_issues: [],
      error: 'enrichment agent error',
    });
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: wm,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError,
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: nullDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('enrichment agent error'));
    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('failed');
  });
});

describe('Orchestrator — _startFilingPipeline success paths', () => {
  it('mixed result (1 filed + 1 duplicate): correct events, workspace destroyed, summary posted, done', async () => {
    const { records: logRecords, destination: logDest } = makeLogCapture();
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const postMessage = vi.fn().mockResolvedValue(undefined);

    const issueFiler = makeIssueFiler({
      status: 'complete',
      summary: 'Filed 1 new issue: #10 New — Found 1 existing issue: #45 Dup',
      filed_issues: [
        { number: 10, title: 'New Issue', action: 'filed' },
        { number: 45, title: 'Duplicate', action: 'duplicate' },
      ],
    });

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: wm,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage,
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: logDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    // Workspace destroyed
    expect(wm.destroy).toHaveBeenCalledWith('/ws/request-001');

    // Summary posted
    expect(postMessage).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('Filed 1 new issue'));

    // Run reached done
    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('done');

    // Log events
    const filedEvent = logRecords.find(r => r['event'] === 'filing.issue_filed');
    expect(filedEvent).toBeTruthy();
    expect(filedEvent!['issue_number']).toBe(10);
    expect(filedEvent!['issue_title']).toBe('New Issue');

    const dupEvent = logRecords.find(r => r['event'] === 'filing.duplicate_detected');
    expect(dupEvent).toBeTruthy();
    expect(dupEvent!['existing_issue_number']).toBe(45);
    expect(dupEvent!['existing_issue_title']).toBe('Duplicate');

    const completeEvent = logRecords.find(r => r['event'] === 'filing.complete');
    expect(completeEvent).toBeTruthy();
    expect(completeEvent!['filed_count']).toBe(1);
    expect(completeEvent!['duplicate_count']).toBe(1);
  });

  it('all new: only filing.issue_filed events; no filing.duplicate_detected', async () => {
    const { records: logRecords, destination: logDest } = makeLogCapture();
    const adapter = makeMockAdapter();
    const issueFiler = makeIssueFiler({
      status: 'complete',
      summary: 'Filed 2 new issues',
      filed_issues: [
        { number: 1, title: 'Issue 1', action: 'filed' },
        { number: 2, title: 'Issue 2', action: 'filed' },
      ],
    });

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: logDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const filedEvents = logRecords.filter(r => r['event'] === 'filing.issue_filed');
    const dupEvents = logRecords.filter(r => r['event'] === 'filing.duplicate_detected');
    expect(filedEvents).toHaveLength(2);
    expect(dupEvents).toHaveLength(0);
  });

  it('all duplicates: only filing.duplicate_detected events', async () => {
    const { records: logRecords, destination: logDest } = makeLogCapture();
    const adapter = makeMockAdapter();
    const issueFiler = makeIssueFiler({
      status: 'complete',
      summary: 'Found 2 existing issues',
      filed_issues: [
        { number: 45, title: 'Dup 1', action: 'duplicate' },
        { number: 46, title: 'Dup 2', action: 'duplicate' },
      ],
    });

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: logDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const filedEvents = logRecords.filter(r => r['event'] === 'filing.issue_filed');
    const dupEvents = logRecords.filter(r => r['event'] === 'filing.duplicate_detected');
    expect(filedEvents).toHaveLength(0);
    expect(dupEvents).toHaveLength(2);
  });

  it('acknowledgment post fails → pipeline continues to done', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Slack timeout')) // acknowledgment fails
      .mockResolvedValue(undefined);                      // subsequent calls succeed
    const issueFiler = makeIssueFiler();

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage,
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: nullDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('done');
  });

  it('summary post fails → run transitions to done; issues remain filed', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn()
      .mockResolvedValueOnce(undefined) // acknowledgment succeeds
      .mockRejectedValueOnce(new Error('Slack timeout')); // summary fails
    const issueFiler = makeIssueFiler();

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage,
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: nullDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    const runs = (orch as never as { runs: Map<string, Run> }).runs;
    expect(runs.get('request-001')!.stage).toBe('done');
  });
});

describe('Orchestrator — existing routing unaffected by file_issues', () => {
  it('idea intent still routes to _startSpecPipeline', async () => {
    const adapter = makeMockAdapter();
    const sg = makeSpecGenerator();
    const cp = makeSpecPublisher();

    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: sg,
      specPublisher: cp,
      intentClassifier: makeIntentClassifier('idea'),
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
    }, { logDestination: nullDest });

    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(sg.create).toHaveBeenCalled();
    expect(cp.create).toHaveBeenCalled();
  });
});

describe('OrchestratorImpl — command dispatch', () => {
  let adapter: ReturnType<typeof makeMockAdapter>;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = makeMockAdapter();
    postMessage = vi.fn().mockResolvedValue(undefined);
    _fixtureSeq = 0;
  });

  function makeOrch(registryOverrides: Partial<CommandRegistry> = {}) {
    const commandRegistry = makeCommandRegistry(registryOverrides);
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
        commandRegistry,
      },
      { logDestination: nullDest as unknown as import('pino').DestinationStream },
    );
    return { orch, commandRegistry };
  }

  it('command event → handler dispatched; no run created', async () => {
    const { orch, commandRegistry } = makeOrch();
    await orch.start();

    adapter._emit(makeCommandEvent({ command: 'test.cmd' }));
    await adapter.stop();
    await orch.stop();

    expect(commandRegistry.dispatch).toHaveBeenCalledWith('test.cmd', expect.objectContaining({ command: 'test.cmd' }), expect.any(Function));
    expect(orch.getRuns().size).toBe(0);
  });

  it('command handler reply function posts to correct channel and thread', async () => {
    const { orch } = makeOrch({
      dispatch: vi.fn().mockImplementation(async (_cmd, _event, reply) => {
        await reply('hello from handler');
      }),
    });
    await orch.start();

    adapter._emit(makeCommandEvent({ command: 'test.cmd', channel_id: 'C001', thread_ts: '1000.0' }));
    await adapter.stop();
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith('C001', '1000.0', 'hello from handler');
  });

  it('handler succeeds → command.succeeded logged at info', async () => {
    const { records, destination } = makeLogCapture();
    const commandRegistry = makeCommandRegistry();
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
        commandRegistry,
      },
      { logDestination: destination },
    );
    await orch.start();
    adapter._emit(makeCommandEvent({ command: 'test.cmd' }));
    await adapter.stop();
    await orch.stop();

    const log = records.find(r => r['event'] === 'command.succeeded');
    expect(log).toBeDefined();
    expect(log?.['command']).toBe('test.cmd');
  });

  it('unregistered command → help handler invoked; command.unknown metric logged', async () => {
    const { records, destination } = makeLogCapture();
    const helpDispatch = vi.fn().mockResolvedValue(undefined);
    const commandRegistry = makeCommandRegistry({
      has: vi.fn().mockImplementation((cmd: string) => cmd === 'help'),
      dispatch: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'help') return helpDispatch(cmd);
      }),
    });
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
        commandRegistry,
      },
      { logDestination: destination },
    );
    await orch.start();
    adapter._emit(makeCommandEvent({ command: 'unknown.cmd' }));
    await adapter.stop();
    await orch.stop();

    expect(helpDispatch).toHaveBeenCalled();
    expect(records.find(r => r['event'] === 'command.unknown')).toBeDefined();
  });

  it('unregistered command when help also not registered → raw fallback reply posted', async () => {
    const { orch } = makeOrch({ has: vi.fn().mockReturnValue(false) });
    await orch.start();

    adapter._emit(makeCommandEvent({ command: 'unknown.cmd', channel_id: 'C001', thread_ts: '1000.0' }));
    await adapter.stop();
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith('C001', '1000.0', expect.stringContaining('ac-help'));
  });

  it('handler throws → command.failed logged; fallback reply posted', async () => {
    const { records, destination } = makeLogCapture();
    const commandRegistry = makeCommandRegistry({
      dispatch: vi.fn().mockRejectedValue(new Error('handler exploded')),
    });
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage,
        channelRepoMap: makeChannelRepoMap(),
        commandRegistry,
      },
      { logDestination: destination },
    );
    await orch.start();
    adapter._emit(makeCommandEvent({ command: 'test.cmd', channel_id: 'C001', thread_ts: '1000.0' }));
    await adapter.stop();
    await orch.stop();

    expect(records.find(r => r['event'] === 'command.failed')).toBeDefined();
    expect(postMessage).toHaveBeenCalledWith('C001', '1000.0', expect.stringContaining('check logs'));
  });

  it('reply function fails → command.reply_failed logged; no exception propagates', async () => {
    const { records, destination } = makeLogCapture();
    const commandRegistry = makeCommandRegistry({
      dispatch: vi.fn().mockImplementation(async (_cmd, _event, reply) => {
        await reply('test');
      }),
    });
    const failingPost = vi.fn().mockRejectedValue(new Error('network error'));
    const orch = new OrchestratorImpl(
      {
        adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
        workspaceManager: makeWorkspaceManager(),
        specGenerator: makeSpecGenerator(),
        specPublisher: makeSpecPublisher(),
        postError: vi.fn().mockResolvedValue(undefined),
        postMessage: failingPost,
        channelRepoMap: makeChannelRepoMap(),
        commandRegistry,
      },
      { logDestination: destination },
    );
    await orch.start();
    adapter._emit(makeCommandEvent({ command: 'test.cmd' }));
    await adapter.stop();
    await orch.stop();

    expect(records.find(r => r['event'] === 'command.reply_failed')).toBeDefined();
  });

  it('two command events → both dispatched', async () => {
    const { orch, commandRegistry } = makeOrch();
    await orch.start();

    adapter._emit(makeCommandEvent({ command: 'test.cmd' }));
    adapter._emit(makeCommandEvent({ command: 'test.cmd' }));
    await adapter.stop();
    await orch.stop();

    expect(commandRegistry.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('OrchestratorImpl — multi-repo dispatch', () => {
  it('new_request from mapped channel A uses channel A repo_url and workspace_root', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const workspaceManager = makeWorkspaceManager();
    const channelRepoMap: ChannelRepoMap = new Map([
      ['CA', { channel_id: 'CA', repo_url: 'https://github.com/org/repo-a.git', workspace_root: '/roots/a' }],
      ['CB', { channel_id: 'CB', repo_url: 'https://github.com/org/repo-b.git', workspace_root: '/roots/b' }],
    ]);

    const orch = new OrchestratorImpl({
      adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
      workspaceManager,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      channelRepoMap,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
    }, { logDestination: destination });

    await orch.start();

    const reqId = 'req-mr-1';
    adapter._emit({
      type: 'new_request',
      payload: { id: reqId, source: 'slack' as const, content: 'idea', author: 'U1', received_at: new Date().toISOString(), thread_ts: '1.0', channel_id: 'CA' },
    });

    await vi.waitUntil(() => {
      const run = [...orch.getRuns().values()].find(r => r.request_id === reqId);
      return run?.stage === 'reviewing_spec';
    }, { timeout: 3000 });

    expect(workspaceManager.create).toHaveBeenCalledWith(reqId, 'https://github.com/org/repo-a.git', '/roots/a');
    await orch.stop();
  });

  it('new_request from mapped channel B uses channel B repo_url and workspace_root', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const workspaceManager = makeWorkspaceManager();
    const channelRepoMap: ChannelRepoMap = new Map([
      ['CA', { channel_id: 'CA', repo_url: 'https://github.com/org/repo-a.git', workspace_root: '/roots/a' }],
      ['CB', { channel_id: 'CB', repo_url: 'https://github.com/org/repo-b.git', workspace_root: '/roots/b' }],
    ]);

    const orch = new OrchestratorImpl({
      adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
      workspaceManager,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      channelRepoMap,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
    }, { logDestination: destination });

    await orch.start();

    const reqId = 'req-mr-2';
    adapter._emit({
      type: 'new_request',
      payload: { id: reqId, source: 'slack' as const, content: 'idea', author: 'U1', received_at: new Date().toISOString(), thread_ts: '2.0', channel_id: 'CB' },
    });

    await vi.waitUntil(() => {
      const run = [...orch.getRuns().values()].find(r => r.request_id === reqId);
      return run?.stage === 'reviewing_spec';
    }, { timeout: 3000 });

    expect(workspaceManager.create).toHaveBeenCalledWith(reqId, 'https://github.com/org/repo-b.git', '/roots/b');
    await orch.stop();
  });

  it('new_request from unmapped channel: run.channel_unmapped warn logged, no run created', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const workspaceManager = makeWorkspaceManager();
    const channelRepoMap: ChannelRepoMap = new Map([
      ['CA', { channel_id: 'CA', repo_url: 'https://github.com/org/repo-a.git', workspace_root: '/roots/a' }],
    ]);

    const orch = new OrchestratorImpl({
      adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
      workspaceManager,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      channelRepoMap,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
    }, { logDestination: destination });

    await orch.start();

    const reqId = 'req-mr-3';
    adapter._emit({
      type: 'new_request',
      payload: { id: reqId, source: 'slack' as const, content: 'idea', author: 'U1', received_at: new Date().toISOString(), thread_ts: '3.0', channel_id: 'CUNMAPPED' },
    });

    await new Promise(r => setTimeout(r, 200));

    expect(orch.getRuns().size).toBe(0);
    expect(workspaceManager.create).not.toHaveBeenCalled();
    const warnLog = records.find(r => r['event'] === 'run.channel_unmapped');
    expect(warnLog).toBeDefined();
    expect(warnLog!['channel_id']).toBe('CUNMAPPED');

    await orch.stop();
  });

  it('single-entry ChannelRepoMap matches existing single-repo behavior', async () => {
    const { records, destination } = makeLogCapture();
    const adapter = makeMockAdapter();
    const workspaceManager = makeWorkspaceManager();
    const channelRepoMap: ChannelRepoMap = new Map([
      ['C1', { channel_id: 'C1', repo_url: 'https://github.com/org/repo.git', workspace_root: '~/.autocatalyst/workspaces' }],
    ]);

    const orch = new OrchestratorImpl({
      adapter: adapter as unknown as import('../../src/adapters/slack/slack-adapter.js').SlackAdapter,
      workspaceManager,
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      channelRepoMap,
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
    }, { logDestination: destination });

    await orch.start();

    const reqId = 'req-mr-4';
    adapter._emit({
      type: 'new_request',
      payload: { id: reqId, source: 'slack' as const, content: 'idea', author: 'U1', received_at: new Date().toISOString(), thread_ts: '4.0', channel_id: 'C1' },
    });

    await vi.waitUntil(() => {
      const run = [...orch.getRuns().values()].find(r => r.request_id === reqId);
      return run?.stage === 'reviewing_spec';
    }, { timeout: 3000 });

    expect(workspaceManager.create).toHaveBeenCalledWith(
      reqId,
      'https://github.com/org/repo.git',
      '~/.autocatalyst/workspaces',
    );
    await orch.stop();
  });
});

describe('Orchestrator — intent-specific acknowledgements', () => {
  function makeOrch(intent: string) {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage,
      channelRepoMap: makeChannelRepoMap(),
      intentClassifier: makeIntentClassifier(intent),
    }, { logDestination: nullDest });
    return { adapter, orch, postMessage };
  }

  it("test 7: idea intent — posts 'Writing a spec — will post it here when I'm done.'", async () => {
    const { adapter, orch, postMessage } = makeOrch('idea');
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith(
      'C123', '100.0', "Writing a spec — will post it here when I'm done.",
    );
  });

  it("test 8: bug intent — posts 'Working on a plan — will post it here when I'm done.'", async () => {
    const { adapter, orch, postMessage } = makeOrch('bug');
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith(
      'C123', '100.0', "Working on a plan — will post it here when I'm done.",
    );
  });

  it("test 9: chore intent — posts 'Working on a plan — will post it here when I'm done.'", async () => {
    const { adapter, orch, postMessage } = makeOrch('chore');
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith(
      'C123', '100.0', "Working on a plan — will post it here when I'm done.",
    );
  });

  it("test 10: file_issues intent — posts 'Filing this — will confirm here when I'm done.'", async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const issueFiler = makeIssueFiler();
    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage,
      channelRepoMap: makeChannelRepoMap(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
    }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith(
      'C123', '100.0', "Filing this — will confirm here when I'm done.",
    );
  });

  it("test 11: fallback intent — posts 'On it — will update here when I'm done.'", async () => {
    // 'question' is not in the explicit intent map → fallback message
    const { adapter, orch, postMessage } = makeOrch('question');
    await orch.start();
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postMessage).toHaveBeenCalledWith(
      'C123', '100.0', "On it — will update here when I'm done.",
    );
  });

  it('test 12: thread_message event — no intent-specific message from orchestrator', async () => {
    const adapter = makeMockAdapter();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    // First call: classify new_request as 'idea'; subsequent: classify thread_message as 'feedback'
    const ic = makeIntentClassifier('idea');
    (ic.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce('idea').mockResolvedValue('feedback');
    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage,
      channelRepoMap: makeChannelRepoMap(),
      intentClassifier: ic,
    }, { logDestination: nullDest });
    await orch.start();

    // Seed new_request to create a run in reviewing_spec
    adapter._emit({ type: 'new_request', payload: makeRequest() });
    await new Promise(r => setTimeout(r, 50));
    postMessage.mockClear(); // clear calls from new_request processing

    // Send thread_message
    adapter._emit({ type: 'thread_message', payload: makeFeedback() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    // No intent-specific message should be posted for thread_message
    const intentPhrases = [
      "Writing a spec",
      "Working on a plan",
      "Filing this",
      "On it — will update",
    ];
    for (const phrase of intentPhrases) {
      expect(postMessage).not.toHaveBeenCalledWith(
        expect.any(String), expect.any(String), expect.stringContaining(phrase),
      );
    }
  });
});

describe('Orchestrator — completion reaction', () => {
  async function runToCompletion(reacjiComplete: string | null | undefined) {
    const adapter = makeMockAdapter();
    const issueFiler = makeIssueFiler();
    const orch = new OrchestratorImpl({
      adapter: adapter as never,
      workspaceManager: makeWorkspaceManager(),
      specGenerator: makeSpecGenerator(),
      specPublisher: makeSpecPublisher(),
      postError: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
      channelRepoMap: makeChannelRepoMap(),
      intentClassifier: makeIntentClassifier('file_issues'),
      issueFiler,
      reacjiComplete,
    }, { logDestination: nullDest });
    await orch.start();
    const request = makeRequest();
    adapter._emit({ type: 'new_request', payload: request });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();
    return { adapter, request };
  }

  it('test 13: completion + complete configured — reactToMessage called with originalRequestTs and emoji', async () => {
    const { adapter, request } = await runToCompletion('white_check_mark');

    expect(adapter.reactToMessage).toHaveBeenCalledWith(
      request.channel_id,
      request.thread_ts,
      'white_check_mark',
    );
  });

  it('test 14: completion + complete is null — reactToMessage NOT called for completion', async () => {
    const { adapter } = await runToCompletion(null);

    expect(adapter.reactToMessage).not.toHaveBeenCalled();
  });

  it('test 15: completion + complete omitted — reactToMessage NOT called for completion', async () => {
    const { adapter } = await runToCompletion(undefined);

    expect(adapter.reactToMessage).not.toHaveBeenCalled();
  });
});
