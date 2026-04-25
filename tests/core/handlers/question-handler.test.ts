import { describe, expect, it, vi } from 'vitest';
import { QuestionHandler } from '../../../src/core/handlers/question-handler.js';
import type { Run } from '../../../src/types/runs.js';
import { TEST_CHANNEL, TEST_CONVERSATION, TEST_ORIGIN } from '../../helpers/channel-refs.js';

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
    artifact: undefined,
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

function makeHandler(overrides: Partial<ConstructorParameters<typeof QuestionHandler>[0]> = {}) {
  const deps = {
    questionAnswerer: {
      answer: vi.fn().mockResolvedValue('Here is the answer.'),
    },
    postMessage: vi.fn().mockResolvedValue(undefined),
    postError: vi.fn().mockResolvedValue(undefined),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };

  return { handler: new QuestionHandler(deps), deps };
}

describe('QuestionHandler', () => {
  it('answers with the configured question answerer and posts the response', async () => {
    const { handler, deps } = makeHandler();

    const result = await handler.handle('What changed?', TEST_CONVERSATION, makeRun());

    expect(deps.questionAnswerer?.answer).toHaveBeenCalledWith('What changed?');
    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, 'Here is the answer.');
    expect(result.status).toBe('answered');
  });

  it('posts a static error when question answering fails', async () => {
    const { handler, deps } = makeHandler({
      questionAnswerer: {
        answer: vi.fn().mockRejectedValue(new Error('agent failed')),
      },
    });

    const result = await handler.handle('What changed?', TEST_CONVERSATION, makeRun());

    expect(deps.postError).toHaveBeenCalledWith(
      TEST_CONVERSATION,
      'I could not answer that question because the AI service is unavailable. Please try again shortly.',
    );
    expect(result.status).toBe('unavailable');
    expect(deps.postMessage).not.toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining("wasn't able"));
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'question.answer_failed', run_id: 'run-001' }),
      'Failed to answer question',
    );
  });

  it('posts the not-configured message when no question answerer is available', async () => {
    const { handler, deps } = makeHandler({ questionAnswerer: undefined });

    const result = await handler.handle('What changed?', TEST_CONVERSATION, makeRun());

    expect(deps.postMessage).toHaveBeenCalledWith(TEST_CONVERSATION, expect.stringContaining('coming soon'));
    expect(result.status).toBe('not_configured');
  });

  it('does not throw when posting the response fails', async () => {
    const { handler, deps } = makeHandler({
      postMessage: vi.fn().mockRejectedValue(new Error('channel failed')),
    });

    await handler.handle('What changed?', TEST_CONVERSATION, makeRun());

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run.notify_failed', run_id: 'run-001' }),
      'Failed to post question response',
    );
  });
});
