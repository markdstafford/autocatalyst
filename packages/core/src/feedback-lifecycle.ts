import type { CreateFeedbackInput, Feedback, FeedbackAnchor, FeedbackStatus, NonModelPrincipal } from '@autocatalyst/api-contract';

import type { FeedbackRepository } from './domain-repositories.js';

// ---- Error ------------------------------------------------------------------

export type FeedbackLifecycleErrorCode =
  | 'feedback_missing'
  | 'feedback_invalid_transition'
  | 'feedback_invalid_input'
  | 'feedback_not_originator';

export class FeedbackLifecycleError extends Error {
  readonly code: FeedbackLifecycleErrorCode;

  constructor(code: FeedbackLifecycleErrorCode, message: string) {
    super(message);
    this.name = 'FeedbackLifecycleError';
    this.code = code;
  }
}

// ---- Dependencies -----------------------------------------------------------

export interface FeedbackLifecycleDependencies {
  readonly feedback: FeedbackRepository;
  readonly ids: () => string;
  readonly clock: () => string;
}

// ---- Internal helpers -------------------------------------------------------

async function requireFeedback(id: string, deps: FeedbackLifecycleDependencies): Promise<Feedback> {
  const feedback = await deps.feedback.findById(id);
  if (feedback === null) {
    throw new FeedbackLifecycleError('feedback_missing', 'Feedback not found.');
  }
  return feedback;
}

function requireStatus(feedback: Feedback, expectedStatus: FeedbackStatus): void {
  if (feedback.status !== expectedStatus) {
    throw new FeedbackLifecycleError(
      'feedback_invalid_transition',
      `Expected feedback status '${expectedStatus}', got '${feedback.status}'.`
    );
  }
}

// ---- Use cases --------------------------------------------------------------

export interface CreateArtifactFeedbackInput {
  readonly runId: string;
  readonly owner: NonModelPrincipal;
  readonly tenant: string;
  readonly principal: NonModelPrincipal;
  readonly title: string;
  readonly body: string;
  readonly anchor?: FeedbackAnchor;
}

export async function createArtifactFeedback(
  input: CreateArtifactFeedbackInput,
  deps: FeedbackLifecycleDependencies
): Promise<Feedback> {
  const createInput: CreateFeedbackInput = {
    runId: input.runId,
    owner: input.owner,
    tenant: input.tenant,
    target: 'artifact',
    status: 'open',
    title: input.title,
    body: input.body,
    ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
    thread: [
      {
        id: deps.ids(),
        author: input.principal,
        body: input.body,
        createdAt: deps.clock()
      }
    ]
  };

  return deps.feedback.create(createInput);
}

export interface AddressFeedbackInput {
  readonly feedbackId: string;
  readonly actor: NonModelPrincipal;
  readonly body: string;
}

export async function addressFeedback(
  input: AddressFeedbackInput,
  deps: FeedbackLifecycleDependencies
): Promise<Feedback> {
  const feedback = await requireFeedback(input.feedbackId, deps);
  requireStatus(feedback, 'open');

  return deps.feedback.updateStatusAndAppendThread({
    feedbackId: input.feedbackId,
    expectedStatus: 'open',
    nextStatus: 'addressed',
    threadEntry: {
      id: deps.ids(),
      author: input.actor,
      body: input.body,
      createdAt: deps.clock()
    },
    updatedAt: deps.clock()
  });
}

export interface MarkFeedbackWontFixInput {
  readonly feedbackId: string;
  readonly actor: NonModelPrincipal;
  readonly body: string;
}

export async function markFeedbackWontFix(
  input: MarkFeedbackWontFixInput,
  deps: FeedbackLifecycleDependencies
): Promise<Feedback> {
  const feedback = await requireFeedback(input.feedbackId, deps);
  requireStatus(feedback, 'open');

  return deps.feedback.updateStatusAndAppendThread({
    feedbackId: input.feedbackId,
    expectedStatus: 'open',
    nextStatus: 'wont_fix',
    threadEntry: {
      id: deps.ids(),
      author: input.actor,
      body: input.body,
      createdAt: deps.clock()
    },
    updatedAt: deps.clock()
  });
}

export interface ResolveFeedbackInput {
  readonly feedbackId: string;
  readonly actor: NonModelPrincipal;
  readonly body?: string;
}

export async function resolveFeedback(
  input: ResolveFeedbackInput,
  deps: FeedbackLifecycleDependencies
): Promise<Feedback> {
  const feedback = await requireFeedback(input.feedbackId, deps);
  requireStatus(feedback, 'addressed');

  const originator = feedback.thread[0]?.author;
  if (originator === undefined || input.actor.id !== originator.id) {
    throw new FeedbackLifecycleError(
      'feedback_not_originator',
      'Only the originator of the feedback may resolve it.'
    );
  }

  const body = input.body ?? 'Confirmed.';

  return deps.feedback.updateStatusAndAppendThread({
    feedbackId: input.feedbackId,
    expectedStatus: 'addressed',
    nextStatus: 'resolved',
    threadEntry: {
      id: deps.ids(),
      author: input.actor,
      body,
      createdAt: deps.clock()
    },
    updatedAt: deps.clock()
  });
}

export interface ReopenFeedbackInput {
  readonly feedbackId: string;
  readonly actor: NonModelPrincipal;
  readonly body: string;
}

export async function reopenFeedback(
  input: ReopenFeedbackInput,
  deps: FeedbackLifecycleDependencies
): Promise<Feedback> {
  const feedback = await requireFeedback(input.feedbackId, deps);
  requireStatus(feedback, 'wont_fix');

  return deps.feedback.updateStatusAndAppendThread({
    feedbackId: input.feedbackId,
    expectedStatus: 'wont_fix',
    nextStatus: 'open',
    threadEntry: {
      id: deps.ids(),
      author: input.actor,
      body: input.body,
      createdAt: deps.clock()
    },
    updatedAt: deps.clock()
  });
}

export interface ListBlockingFeedbackInput {
  readonly runId: string;
  readonly target: 'artifact';
}

export async function listBlockingFeedback(
  input: ListBlockingFeedbackInput,
  deps: FeedbackLifecycleDependencies
): Promise<readonly Feedback[]> {
  const all = await deps.feedback.listByRun(input.runId);
  return all.filter(
    f => f.target === input.target && (f.status === 'open' || f.status === 'addressed')
  );
}

export interface ResolveApproverAddressedFeedbackInput {
  readonly runId: string;
  readonly target: 'artifact';
  readonly approver: NonModelPrincipal;
}

export async function resolveApproverAddressedFeedback(
  input: ResolveApproverAddressedFeedbackInput,
  deps: FeedbackLifecycleDependencies
): Promise<void> {
  const all = await deps.feedback.listByRun(input.runId);

  const matching = all.filter(
    f =>
      f.target === input.target &&
      f.status === 'addressed' &&
      f.thread[0]?.author.id === input.approver.id
  );

  await Promise.all(
    matching.map(f =>
      deps.feedback.updateStatusAndAppendThread({
        feedbackId: f.id,
        expectedStatus: 'addressed',
        nextStatus: 'resolved',
        threadEntry: {
          id: deps.ids(),
          author: input.approver,
          body: 'Confirmed.',
          createdAt: deps.clock()
        },
        updatedAt: deps.clock()
      })
    )
  );
}
