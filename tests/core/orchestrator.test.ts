// tests/core/orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorImpl } from '../../src/core/orchestrator.js';
import type { WorkspaceManager } from '../../src/core/workspace-manager.js';
import type { SpecGenerator } from '../../src/adapters/agent/spec-generator.js';
import type { CanvasPublisher } from '../../src/adapters/slack/canvas-publisher.js';
import type { Idea, SpecFeedback } from '../../src/types/events.js';

const nullDest = { write: () => {} };

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
    create: vi.fn().mockResolvedValue({ workspace_path: '/ws/idea-001', branch: 'spec/idea-001' }),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSpecGenerator(overrides: Partial<SpecGenerator> = {}): SpecGenerator {
  return {
    create: vi.fn().mockResolvedValue('/ws/idea-001/context-human/specs/feature-test.md'),
    revise: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCanvasPublisher(overrides: Partial<CanvasPublisher> = {}): CanvasPublisher {
  return {
    create: vi.fn().mockResolvedValue('CANVAS001'),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: 'idea-001',
    source: 'slack',
    content: 'add a setup wizard',
    author: 'U123',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<SpecFeedback> = {}): SpecFeedback {
  return {
    idea_id: 'idea-001',
    content: 'wizard should not require all settings',
    author: 'U456',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

describe('Orchestrator — new_idea happy path', () => {
  it('calls all four components in order with correct arguments', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeCanvasPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, canvasPublisher: cp, postError, repo_url: 'https://github.com/org/repo' }, { logDestination: nullDest });
    await orch.start();

    const idea = makeIdea();
    adapter._emit({ type: 'new_idea', payload: idea });

    // Give the loop time to process
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.create).toHaveBeenCalledWith('idea-001', 'https://github.com/org/repo');
    expect(sg.create).toHaveBeenCalledWith(idea, '/ws/idea-001');
    expect(cp.create).toHaveBeenCalledWith('C123', '100.0', '/ws/idea-001/context-human/specs/feature-test.md');
  });

  it('run ends in review stage with all fields populated', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeCanvasPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, canvasPublisher: cp, postError, repo_url: 'https://github.com/org/repo' }, { logDestination: nullDest });
    await orch.start();

    adapter._emit({ type: 'new_idea', payload: makeIdea() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    // Access internal state to verify — cast through any for testing
    const runs = (orch as never as { runs: Map<string, { stage: string; workspace_path: string; branch: string; spec_path: string; canvas_id: string }> }).runs;
    const run = runs.get('idea-001')!;
    expect(run.stage).toBe('review');
    expect(run.workspace_path).toBe('/ws/idea-001');
    expect(run.branch).toBe('spec/idea-001');
    expect(run.spec_path).toBe('/ws/idea-001/context-human/specs/feature-test.md');
    expect(run.canvas_id).toBe('CANVAS001');
  });
});

describe('Orchestrator — new_idea failure paths', () => {
  it('WorkspaceManager failure: run is failed, error posted, no further components called', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager({ create: vi.fn().mockRejectedValue(new Error('clone failed')) });
    const sg = makeSpecGenerator();
    const cp = makeCanvasPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, canvasPublisher: cp, postError, repo_url: 'https://github.com/org/repo' }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_idea', payload: makeIdea() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('clone failed'));
    expect(sg.create).not.toHaveBeenCalled();
    expect(cp.create).not.toHaveBeenCalled();

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('idea-001')!.stage).toBe('failed');
  });

  it('SpecGenerator failure: run is failed, error posted, workspace destroyed', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator({ create: vi.fn().mockRejectedValue(new Error('omc failed')) });
    const cp = makeCanvasPublisher();
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, canvasPublisher: cp, postError, repo_url: 'https://github.com/org/repo' }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_idea', payload: makeIdea() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/idea-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('omc failed'));
    expect(cp.create).not.toHaveBeenCalled();

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('idea-001')!.stage).toBe('failed');
  });

  it('CanvasPublisher failure: run is failed, error posted, workspace destroyed', async () => {
    const adapter = makeMockAdapter();
    const wm = makeWorkspaceManager();
    const sg = makeSpecGenerator();
    const cp = makeCanvasPublisher({ create: vi.fn().mockRejectedValue(new Error('canvas error')) });
    const postError = vi.fn().mockResolvedValue(undefined);

    const orch = new OrchestratorImpl({ adapter: adapter as never, workspaceManager: wm, specGenerator: sg, canvasPublisher: cp, postError, repo_url: 'https://github.com/org/repo' }, { logDestination: nullDest });
    await orch.start();
    adapter._emit({ type: 'new_idea', payload: makeIdea() });
    await new Promise(r => setTimeout(r, 50));
    await orch.stop();

    expect(wm.destroy).toHaveBeenCalledWith('/ws/idea-001');
    expect(postError).toHaveBeenCalledWith('C123', '100.0', expect.stringContaining('canvas error'));

    const runs = (orch as never as { runs: Map<string, { stage: string }> }).runs;
    expect(runs.get('idea-001')!.stage).toBe('failed');
  });
});
