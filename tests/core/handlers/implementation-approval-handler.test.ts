import { describe, expect, it, vi } from 'vitest';
import { ImplementationApprovalHandler } from '../../../src/core/handlers/implementation-approval-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'approved',
    author: 'U456',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-001',
    request_id: 'request-001',
    intent: 'idea',
    stage: 'reviewing_implementation',
    workspace_path: '/ws/request-001',
    branch: 'spec/request-001',
    spec_path: '/ws/request-001/context-human/specs/feature-test.md',
    publisher_ref: 'CANVAS001',
    artifact: {
      kind: 'feature_spec',
      local_path: '/ws/request-001/context-human/specs/feature-test.md',
      published_ref: { provider: 'artifact_publisher', id: 'CANVAS001' },
      status: 'approved',
    },
    impl_feedback_ref: 'feedback-page-id',
    issue: undefined,
    attempt: 1,
    pr_url: undefined,
    last_impl_result: {
      summary: 'Implemented it.',
      testing_instructions: 'npm test',
    },
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeHandler(overrides: Partial<ConstructorParameters<typeof ImplementationApprovalHandler>[0]> = {}) {
  const deps = {
    specCommitter: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    artifactPublisher: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    prManager: {
      createPR: vi.fn().mockResolvedValue('https://example.test/org/repo/pull/42'),
    },
    implFeedbackPage: {
      setPRLink: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: {
      error: vi.fn(),
    },
    now: () => new Date('2026-04-25T00:00:00.000Z'),
    ...overrides,
  };

  return { handler: new ImplementationApprovalHandler(deps), deps };
}

describe('ImplementationApprovalHandler', () => {
  it('creates the PR using typed artifact refs when legacy spec fields are absent', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      spec_path: undefined,
      publisher_ref: undefined,
      artifact: {
        kind: 'feature_spec',
        local_path: '/ws/request-001/context-human/specs/typed-feature.md',
        published_ref: { provider: 'artifact_publisher', id: 'CANVAS-TYPED' },
        status: 'approved',
      },
    });

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.specCommitter?.updateStatus).toHaveBeenCalledWith(
      '/ws/request-001',
      '/ws/request-001/context-human/specs/typed-feature.md',
      { status: 'complete', last_updated: '2026-04-25' },
    );
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS-TYPED', 'complete');
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      '/ws/request-001/context-human/specs/typed-feature.md',
      expect.objectContaining({ run_intent: 'idea' }),
    );
    expect(run.artifact?.status).toBe('complete');
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('marks the artifact complete, creates a PR, stores the PR URL, and opens the PR stage', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.specCommitter?.updateStatus).toHaveBeenCalledWith(
      '/ws/request-001',
      '/ws/request-001/context-human/specs/feature-test.md',
      { status: 'complete', last_updated: '2026-04-25' },
    );
    expect(deps.artifactPublisher.updateStatus).toHaveBeenCalledWith('CANVAS001', 'complete');
    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      '/ws/request-001/context-human/specs/feature-test.md',
      {
        impl_result: { summary: 'Implemented it.', testing_instructions: 'npm test' },
        run_intent: 'idea',
        title: 'Implemented it.',
      },
    );
    expect(run.artifact?.status).toBe('complete');
    expect(run.pr_url).toBe('https://example.test/org/repo/pull/42');
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'PR opened: https://example.test/org/repo/pull/42');
    expect(deps.implFeedbackPage?.setPRLink).toHaveBeenCalledWith('feedback-page-id', 'https://example.test/org/repo/pull/42');
    expect(deps.implFeedbackPage?.updateStatus).toHaveBeenCalledWith('feedback-page-id', 'approved');
    expect(run.stage).toBe('pr_open');
  });

  it('continues to create the PR when spec status or publisher status updates fail', async () => {
    const { handler, deps } = makeHandler({
      specCommitter: {
        updateStatus: vi.fn().mockRejectedValue(new Error('file missing')),
      },
      artifactPublisher: {
        updateStatus: vi.fn().mockRejectedValue(new Error('publisher down')),
      },
    });

    const result = await handler.handle(makeRun(), makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.prManager.createPR).toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'spec.status_update_failed', run_id: 'run-001' }),
      'Failed to update spec status to complete; continuing',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'spec.publisher_update_failed', run_id: 'run-001' }),
      'Failed to update spec publisher status to complete; continuing',
    );
  });

  it('fails the run when PR creation fails', async () => {
    const error = new Error('pr create failed');
    const { handler, deps } = makeHandler({
      prManager: {
        createPR: vi.fn().mockRejectedValue(error),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.postMessage).not.toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('PR opened'));
  });

  it('does not fail the run when PR notification or feedback page updates fail', async () => {
    const { handler, deps } = makeHandler({
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
      implFeedbackPage: {
        setPRLink: vi.fn().mockRejectedValue(new Error('link failed')),
        updateStatus: vi.fn().mockRejectedValue(new Error('status failed')),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback());

    expect(result).toEqual({ status: 'pr_open' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('pr_open');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post PR link',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.status_update_failed', run_id: 'run-001' }),
      'Failed to update impl feedback page on implementation approval',
    );
  });

  it('passes run.issue as issue_number to createPR when run.issue is set', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ intent: 'bug', issue: 54 });

    await handler.handle(run, makeFeedback());

    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      expect.any(String),
      expect.objectContaining({ issue_number: 54 }),
    );
  });

  it('passes impl_result.summary as title to createPR', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({
      intent: 'bug',
      issue: 54,
      last_impl_result: { summary: 'Fixed the widget crash.', testing_instructions: 'npm test' },
    });

    await handler.handle(run, makeFeedback());

    expect(deps.prManager.createPR).toHaveBeenCalledWith(
      '/ws/request-001',
      'spec/request-001',
      expect.any(String),
      expect.objectContaining({ title: 'Fixed the widget crash.' }),
    );
  });

  it('does not pass issue_number to createPR when run.issue is undefined', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ intent: 'idea', issue: undefined });

    await handler.handle(run, makeFeedback());

    const callArg = (deps.prManager.createPR as ReturnType<typeof vi.fn>).mock.calls[0][3] as Record<string, unknown>;
    expect(callArg['issue_number']).toBeUndefined();
  });
});
