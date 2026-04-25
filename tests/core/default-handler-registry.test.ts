import { describe, expect, it, vi } from 'vitest';
import { buildDefaultHandlerRegistry } from '../../src/core/default-handler-registry.js';
import type { ThreadMessage, InboundEvent } from '../../src/types/events.js';
import type { Run } from '../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN, testChannelBinding } from '../helpers/channel-refs.js';

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'approved',
    author: 'U123',
    received_at: new Date().toISOString(),
    ...overrides,
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
    spec_path: undefined,
    publisher_ref: undefined,
    artifact: {
      kind: 'feature_spec',
      local_path: '/ws/request-001/context-human/specs/typed-feature.md',
      published_ref: { provider: 'artifact_publisher', id: 'CANVAS-TYPED' },
      status: 'waiting_on_feedback',
    },
    impl_feedback_ref: undefined,
    issue: undefined,
    attempt: 0,
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    pr_url: undefined,
    last_impl_result: undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps() {
  return {
    workspaceManager: {
      create: vi.fn(),
      destroy: vi.fn(),
    },
    artifactAuthoringAgent: {
      create: vi.fn(),
      revise: vi.fn(),
    },
    artifactPublisher: {
      createArtifact: vi.fn(),
      updateArtifact: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setIssueLink: vi.fn().mockResolvedValue(undefined),
    },
    specCommitter: {
      commit: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    implementer: {
      implement: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Done',
        testing_instructions: 'npm test',
      }),
    },
    implFeedbackPage: {
      create: vi.fn().mockResolvedValue({ id: 'feedback-page-id', url: 'https://example.test/feedback-page-id' }),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      readFeedback: vi.fn(),
      update: vi.fn(),
      setPRLink: vi.fn(),
    },
    prManager: {
      createPR: vi.fn(),
      mergePR: vi.fn(),
    },
    issueManager: {
      writeIssue: vi.fn(),
      create: vi.fn(),
    },
    issueFiler: {
      file: vi.fn(),
    },
    channelRepoMap: new Map([
      testChannelBinding(),
    ]),
    postMessage: vi.fn().mockResolvedValue(undefined),
    postError: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    reactToRunMessage: vi.fn().mockResolvedValue(undefined),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('buildDefaultHandlerRegistry', () => {
  it('routes artifact approval through approval and implementation handlers', async () => {
    const deps = makeDeps();
    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun();
    const feedback = makeFeedback();
    const event: InboundEvent = { type: 'thread_message', payload: feedback };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'reviewing_spec',
      intent: 'approval',
    });

    expect(handler).toBeDefined();
    await handler?.(event, run);

    expect(deps.specCommitter.commit).toHaveBeenCalledWith('/ws/request-001', 'CANVAS-TYPED', '/ws/request-001/context-human/specs/typed-feature.md');
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/typed-feature.md',
      '/ws/request-001',
      undefined,
      expect.any(Function),
    );
    expect(run.stage).toBe('reviewing_implementation');
  });

  it('does not start implementation when lifecycle policy marks it unnecessary', async () => {
    const deps = {
      ...makeDeps(),
      artifactPolicies: {
        feature_spec: {
          commit_on_approval: true,
          sync_issue_on_approval: false,
          implementation_required: false,
        },
        bug_triage: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
        chore_plan: {
          commit_on_approval: false,
          sync_issue_on_approval: true,
          implementation_required: true,
        },
      },
    };
    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun();
    const event: InboundEvent = { type: 'thread_message', payload: makeFeedback() };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'reviewing_spec',
      intent: 'approval',
    });

    await handler?.(event, run);

    expect(deps.specCommitter.commit).toHaveBeenCalled();
    expect(deps.implementer.implement).not.toHaveBeenCalled();
    expect(run.stage).toBe('done');
  });

  it('does not mutate or persist pr_open runs when handling non-actionable feedback', async () => {
    const deps = makeDeps();
    const registry = buildDefaultHandlerRegistry(deps);
    const run = makeRun({ stage: 'pr_open' });
    const event: InboundEvent = { type: 'thread_message', payload: makeFeedback({ content: 'another note' }) };

    const handler = registry.resolve({
      event_type: 'thread_message',
      stage: 'pr_open',
      intent: 'feedback',
    });

    await handler?.(event, run);

    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'A PR is already open — merge it or close it first.');
    expect(deps.transition).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(run.stage).toBe('pr_open');
  });
});
