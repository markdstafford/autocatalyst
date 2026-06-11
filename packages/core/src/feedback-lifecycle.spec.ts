import { vi, describe, it, expect } from 'vitest';

import type { Feedback, FeedbackStatus, FeedbackThreadEntry, NonModelPrincipal } from '@autocatalyst/api-contract';

import type { FeedbackRepository, FeedbackStatusTransitionPersistenceInput } from './domain-repositories.js';
import {
  createArtifactFeedback,
  addressFeedback,
  markFeedbackWontFix,
  resolveFeedback,
  reopenFeedback,
  listBlockingFeedback,
  resolveApproverAddressedFeedback,
  type FeedbackLifecycleDependencies
} from './feedback-lifecycle.js';

// ---- helpers ----------------------------------------------------------------

function principal(name: string): NonModelPrincipal {
  return { id: name, kind: 'human', tenantId: 'tenant_1' };
}

function thread(authorName: string, id = `thread_${authorName}`): FeedbackThreadEntry {
  return { id, author: principal(authorName), body: `Body from ${authorName}`, createdAt: '2026-06-11T10:00:00.000Z' };
}

function feedbackItem(partial: Partial<Feedback> & { id: string; status: FeedbackStatus }): Feedback {
  return {
    runId: 'run_1',
    owner: principal('owner'),
    tenant: 'tenant_1',
    target: 'artifact',
    title: 'Test feedback',
    body: 'Feedback body',
    thread: [thread('owner')],
    createdAt: '2026-06-11T09:00:00.000Z',
    updatedAt: '2026-06-11T09:00:00.000Z',
    ...partial
  } as Feedback;
}

type FeedbackDepOverrides = {
  ids?: () => string;
  clock?: () => string;
  findById?: Feedback | null;
  listByRun?: Feedback[];
};

function makeFeedbackDeps(overrides: FeedbackDepOverrides = {}): FeedbackLifecycleDependencies & {
  feedback: FeedbackRepository & {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    listByRun: ReturnType<typeof vi.fn>;
    updateStatusAndAppendThread: ReturnType<typeof vi.fn>;
  };
} {
  const defaultFeedback = feedbackItem({ id: 'fb_1', status: 'open' });

  const findByIdMock = vi.fn(async (id: string) => {
    if (overrides.findById !== undefined) return overrides.findById;
    return feedbackItem({ id, status: 'open' });
  });

  const listByRunMock = vi.fn(async (_runId: string) => {
    return overrides.listByRun ?? [defaultFeedback];
  });

  const updateMock = vi.fn(async (input: FeedbackStatusTransitionPersistenceInput) => {
    const existing = await findByIdMock(input.feedbackId);
    return existing ? { ...existing, status: input.nextStatus } : defaultFeedback;
  });

  const createMock = vi.fn(async (input: Parameters<FeedbackRepository['create']>[0]) => {
    return { ...input, id: 'fb_new', createdAt: '2026-06-11T10:00:00.000Z', updatedAt: '2026-06-11T10:00:00.000Z' } as Feedback;
  });

  return {
    ids: overrides.ids ?? (() => 'thread_id'),
    clock: overrides.clock ?? (() => '2026-06-11T10:00:00.000Z'),
    feedback: {
      create: createMock,
      findById: findByIdMock,
      listByRun: listByRunMock,
      updateStatusAndAppendThread: updateMock
    }
  };
}

// ---- createArtifactFeedback -------------------------------------------------

describe('createArtifactFeedback', () => {
  it('creates feedback with target artifact, status open, and initial thread entry', async () => {
    const deps = makeFeedbackDeps({ ids: () => 'thread_init', clock: () => '2026-06-11T11:00:00.000Z' });
    await createArtifactFeedback(
      { runId: 'run_1', owner: principal('alice'), tenant: 'tenant_1', principal: principal('alice'), title: 'My feedback', body: 'Initial body' },
      deps
    );

    expect(deps.feedback.create).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run_1',
      target: 'artifact',
      status: 'open',
      title: 'My feedback',
      body: 'Initial body',
      thread: [expect.objectContaining({ id: 'thread_init', author: principal('alice'), body: 'Initial body', createdAt: '2026-06-11T11:00:00.000Z' })]
    }));
  });
});

// ---- addressFeedback --------------------------------------------------------

describe('addressFeedback', () => {
  it('addresses open artifact feedback with a generated persisted thread entry', async () => {
    const deps = makeFeedbackDeps({ ids: () => 'thread_response', clock: () => '2026-06-11T12:00:00.000Z' });
    const updated = await addressFeedback({
      feedbackId: 'fb_1',
      actor: principal('enzo'),
      body: 'Recorded as a disposition for reviewer confirmation.'
    }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: 'fb_1',
      expectedStatus: 'open',
      nextStatus: 'addressed',
      threadEntry: expect.objectContaining({ id: 'thread_response', body: 'Recorded as a disposition for reviewer confirmation.' })
    }));
    expect(updated.status).toBe('addressed');
  });

  it('throws feedback_invalid_transition when feedback is not open', async () => {
    const deps = makeFeedbackDeps({ findById: feedbackItem({ id: 'fb_1', status: 'addressed' }) });
    await expect(addressFeedback({ feedbackId: 'fb_1', actor: principal('enzo'), body: 'Too late' }, deps))
      .rejects.toMatchObject({ code: 'feedback_invalid_transition' });
  });

  it('throws feedback_missing when feedback does not exist', async () => {
    const deps = makeFeedbackDeps({ findById: null });
    await expect(addressFeedback({ feedbackId: 'fb_missing', actor: principal('enzo'), body: 'body' }, deps))
      .rejects.toMatchObject({ code: 'feedback_missing' });
  });
});

// ---- markFeedbackWontFix ----------------------------------------------------

describe('markFeedbackWontFix', () => {
  it('persists open → wont_fix with actor thread entry', async () => {
    const deps = makeFeedbackDeps({ ids: () => 'thread_wont_fix', clock: () => '2026-06-11T12:00:00.000Z' });
    const updated = await markFeedbackWontFix({ feedbackId: 'fb_1', actor: principal('ops'), body: 'Not in scope.' }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: 'fb_1',
      expectedStatus: 'open',
      nextStatus: 'wont_fix',
      threadEntry: expect.objectContaining({ id: 'thread_wont_fix', body: 'Not in scope.' })
    }));
    expect(updated.status).toBe('wont_fix');
  });

  it('throws feedback_invalid_transition when feedback is not open', async () => {
    const deps = makeFeedbackDeps({ findById: feedbackItem({ id: 'fb_1', status: 'wont_fix' }) });
    await expect(markFeedbackWontFix({ feedbackId: 'fb_1', actor: principal('ops'), body: 'body' }, deps))
      .rejects.toMatchObject({ code: 'feedback_invalid_transition' });
  });
});

// ---- resolveFeedback --------------------------------------------------------

describe('resolveFeedback', () => {
  it('persists addressed → resolved when actor is originator', async () => {
    const addressedFeedback = feedbackItem({
      id: 'fb_1',
      status: 'addressed',
      thread: [thread('alice'), thread('bob', 'thread_bob')]
    });
    const deps = makeFeedbackDeps({ findById: addressedFeedback, ids: () => 'thread_resolve', clock: () => '2026-06-11T13:00:00.000Z' });

    const updated = await resolveFeedback({ feedbackId: 'fb_1', actor: principal('alice'), body: 'Looks good!' }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: 'fb_1',
      expectedStatus: 'addressed',
      nextStatus: 'resolved',
      threadEntry: expect.objectContaining({ body: 'Looks good!' })
    }));
    expect(updated.status).toBe('resolved');
  });

  it('uses generated confirmation message when no body is provided', async () => {
    const addressedFeedback = feedbackItem({ id: 'fb_1', status: 'addressed', thread: [thread('alice')] });
    const deps = makeFeedbackDeps({ findById: addressedFeedback });

    await resolveFeedback({ feedbackId: 'fb_1', actor: principal('alice') }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).toHaveBeenCalledWith(expect.objectContaining({
      threadEntry: expect.objectContaining({ body: 'Confirmed.' })
    }));
  });

  it('throws feedback_not_originator when actor is not the originator', async () => {
    const addressedFeedback = feedbackItem({ id: 'fb_1', status: 'addressed', thread: [thread('alice')] });
    const deps = makeFeedbackDeps({ findById: addressedFeedback });

    await expect(resolveFeedback({ feedbackId: 'fb_1', actor: principal('bob') }, deps))
      .rejects.toMatchObject({ code: 'feedback_not_originator' });
  });

  it('throws feedback_invalid_transition when feedback is not addressed', async () => {
    const openFeedback = feedbackItem({ id: 'fb_1', status: 'open', thread: [thread('alice')] });
    const deps = makeFeedbackDeps({ findById: openFeedback });

    await expect(resolveFeedback({ feedbackId: 'fb_1', actor: principal('alice') }, deps))
      .rejects.toMatchObject({ code: 'feedback_invalid_transition' });
  });
});

// ---- reopenFeedback ---------------------------------------------------------

describe('reopenFeedback', () => {
  it('persists wont_fix → open with actor thread entry', async () => {
    const wontFixFeedback = feedbackItem({ id: 'fb_1', status: 'wont_fix' });
    const deps = makeFeedbackDeps({ findById: wontFixFeedback, ids: () => 'thread_reopen', clock: () => '2026-06-11T14:00:00.000Z' });

    const updated = await reopenFeedback({ feedbackId: 'fb_1', actor: principal('alice'), body: 'Still relevant.' }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: 'fb_1',
      expectedStatus: 'wont_fix',
      nextStatus: 'open',
      threadEntry: expect.objectContaining({ id: 'thread_reopen', body: 'Still relevant.' })
    }));
    expect(updated.status).toBe('open');
  });

  it('throws feedback_invalid_transition when feedback is not wont_fix', async () => {
    const deps = makeFeedbackDeps({ findById: feedbackItem({ id: 'fb_1', status: 'open' }) });
    await expect(reopenFeedback({ feedbackId: 'fb_1', actor: principal('alice'), body: 'body' }, deps))
      .rejects.toMatchObject({ code: 'feedback_invalid_transition' });
  });
});

// ---- listBlockingFeedback ---------------------------------------------------

describe('listBlockingFeedback', () => {
  it('returns only open and addressed artifact feedback', async () => {
    const deps = makeFeedbackDeps({
      listByRun: [
        feedbackItem({ id: 'fb_open', status: 'open', target: 'artifact' }),
        feedbackItem({ id: 'fb_addressed', status: 'addressed', target: 'artifact' }),
        feedbackItem({ id: 'fb_resolved', status: 'resolved', target: 'artifact' }),
        feedbackItem({ id: 'fb_wont_fix', status: 'wont_fix', target: 'artifact' }),
        feedbackItem({ id: 'fb_impl', status: 'open', target: 'implementation' })
      ]
    });

    const result = await listBlockingFeedback({ runId: 'run_1', target: 'artifact' }, deps);

    expect(result).toHaveLength(2);
    expect(result.map(f => f.id)).toEqual(expect.arrayContaining(['fb_open', 'fb_addressed']));
  });
});

// ---- resolveApproverAddressedFeedback ---------------------------------------

describe('resolveApproverAddressedFeedback', () => {
  it('co-resolves only addressed feedback originated by the approver', async () => {
    const deps = makeFeedbackDeps({
      listByRun: [
        feedbackItem({ id: 'fb_self', status: 'addressed', thread: [thread('phoebe')] }),
        feedbackItem({ id: 'fb_other', status: 'addressed', owner: principal('phoebe'), thread: [thread('opal')] })
      ]
    });

    await resolveApproverAddressedFeedback({ runId: 'run_1', target: 'artifact', approver: principal('phoebe') }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).toHaveBeenCalledTimes(1);
    expect(deps.feedback.updateStatusAndAppendThread).toHaveBeenCalledWith(expect.objectContaining({ feedbackId: 'fb_self' }));
  });

  it('does nothing when no addressed feedback originates from the approver', async () => {
    const deps = makeFeedbackDeps({
      listByRun: [
        feedbackItem({ id: 'fb_other', status: 'addressed', thread: [thread('opal')] })
      ]
    });

    await resolveApproverAddressedFeedback({ runId: 'run_1', target: 'artifact', approver: principal('phoebe') }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).not.toHaveBeenCalled();
  });

  it('does not resolve open feedback originated by the approver', async () => {
    const deps = makeFeedbackDeps({
      listByRun: [
        feedbackItem({ id: 'fb_open', status: 'open', thread: [thread('phoebe')] })
      ]
    });

    await resolveApproverAddressedFeedback({ runId: 'run_1', target: 'artifact', approver: principal('phoebe') }, deps);

    expect(deps.feedback.updateStatusAndAppendThread).not.toHaveBeenCalled();
  });
});
