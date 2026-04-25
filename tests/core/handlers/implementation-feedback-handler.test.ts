import { describe, expect, it, vi } from 'vitest';
import { ImplementationFeedbackHandler } from '../../../src/core/handlers/implementation-feedback-handler.js';
import type { ThreadMessage } from '../../../src/types/events.js';
import type { FeedbackItem } from '../../../src/types/impl-feedback-page.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    channel: TEST_CHANNEL,
    conversation: TEST_CONVERSATION,
    origin: TEST_ORIGIN,
    content: 'go with the subtype approach',
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof ImplementationFeedbackHandler>[0]> = {}) {
  const deps = {
    implementer: {
      implement: vi.fn().mockResolvedValue({
        status: 'complete',
        summary: 'Fixed it',
        testing_instructions: 'npm test',
      }),
    },
    implFeedbackPage: {
      readFeedback: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn((run: Run, stage: Run['stage']) => { run.stage = stage; }),
    failRun: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };

  return { handler: new ImplementationFeedbackHandler(deps), deps };
}

describe('ImplementationFeedbackHandler', () => {
  it('continues implementation feedback using typed artifact refs when legacy spec fields are absent', async () => {
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

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/typed-feature.md',
      '/ws/request-001',
    );
    expect(deps.failRun).not.toHaveBeenCalled();
  });

  it('reads unresolved feedback page items and passes them as implementation context', async () => {
    const feedbackItems: FeedbackItem[] = [
      { id: 'item-1', text: 'Fix the bug', resolved: false, conversation: ['Some context'] },
      { id: 'item-2', text: 'Already done', resolved: true, conversation: [] },
    ];
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockResolvedValue(feedbackItems),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.implFeedbackPage?.readFeedback).toHaveBeenCalledWith('feedback-page-id');
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      expect.stringContaining('Fix the bug'),
    );
    const context = (deps.implementer.implement as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(context).toContain('Some context');
    expect(context).not.toContain('Already done');
    expect(run.attempt).toBe(1);
    expect(run.last_impl_result).toEqual({ summary: 'Fixed it', testing_instructions: 'npm test' });
    expect(run.stage).toBe('reviewing_implementation');
  });

  it('uses the channel message as context while awaiting implementation input', async () => {
    const { handler, deps } = makeHandler();
    const run = makeRun({ stage: 'awaiting_impl_input' });
    const feedback = makeFeedback({ content: 'use adapter composition' });

    const result = await handler.handle(run, feedback, 'awaiting_impl_input');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.implFeedbackPage?.readFeedback).not.toHaveBeenCalled();
    expect(deps.implementer.implement).toHaveBeenCalledWith(
      '/ws/request-001/context-human/specs/feature-test.md',
      '/ws/request-001',
      'use adapter composition',
    );
  });

  it('fails the run when feedback items cannot be read', async () => {
    const error = new Error('review read failed');
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockRejectedValue(error),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, error);
    expect(deps.implementer.implement).not.toHaveBeenCalled();
  });

  it('asks for more input when the implementer needs clarification', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({ status: 'needs_input', question: 'Which refactor pattern?' }),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'needs_input' });
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('Which refactor pattern?'));
    expect(run.stage).toBe('awaiting_impl_input');
  });

  it('fails the run when the implementer fails', async () => {
    const { handler, deps } = makeHandler({
      implementer: {
        implement: vi.fn().mockResolvedValue({ status: 'failed', error: 'agent crashed' }),
      },
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'failed' });
    expect(deps.failRun).toHaveBeenCalledWith(run, TEST_CONVERSATION, expect.any(Error));
    expect(deps.implFeedbackPage?.update).not.toHaveBeenCalled();
  });

  it('does not fail the run when updating the feedback page or notifying the channel fails', async () => {
    const { handler, deps } = makeHandler({
      implFeedbackPage: {
        readFeedback: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockRejectedValue(new Error('review update failed')),
      },
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
    });
    const run = makeRun();

    const result = await handler.handle(run, makeFeedback(), 'reviewing_implementation');

    expect(result).toEqual({ status: 'updated' });
    expect(deps.failRun).not.toHaveBeenCalled();
    expect(run.stage).toBe('reviewing_implementation');
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.feedback_page_update_failed', run_id: 'run-001' }),
      'Failed to update implementation feedback page; continuing in degraded state',
    );
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post completion notification',
    );
  });
});
