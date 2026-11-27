import { randomUUID } from 'node:crypto';
import type { CreateFeedbackInput, Feedback } from '@autocatalyst/api-contract';

import type { FeedbackRepository } from './domain-repositories.js';

export class StaleDispatchError extends Error {}

/** Check the reserved occurrence and hold its mutation lock for one durable commit. */
export type CommitDispatchResult = <T>(commit: () => Promise<T>) => Promise<T | undefined>;

export async function commitConvergenceEffect<T>(
  guard: CommitDispatchResult | undefined,
  commit: () => Promise<T>
): Promise<T | undefined> {
  return guard === undefined ? commit() : guard(commit);
}

/**
 * A canceled loop can still finish its rounds. Keep its uncommitted feedback in memory so
 * it can pass IDs and dispositions between its sessions without changing durable records.
 */
export function guardConvergenceFeedback(repo: FeedbackRepository, guard?: CommitDispatchResult): FeedbackRepository {
  if (guard === undefined) return repo;
  const transient = new Map<string, Feedback>();
  const findById = async (id: string) => transient.get(id) ?? await repo.findById(id);
  const add = (id: string, input: CreateFeedbackInput) => {
    const now = new Date().toISOString();
    const item = { ...input, id, createdAt: now, updatedAt: now };
    transient.set(id, item);
    return item;
  };
  const update = async (id: string, patch: (item: Feedback) => Feedback) => {
    const item = await findById(id);
    if (item === null) throw new Error('Convergence feedback no longer exists.');
    const changed = patch(item);
    transient.set(id, changed);
    return changed;
  };
  return {
    findById,
    listByRun: (id) => repo.listByRun(id),
    create: async (input) => (await guard(() => repo.create(input))) ?? add(`fb_discarded_${randomUUID()}`, input),
    updateStatusAndAppendThread: async (input) =>
      (await guard(() => repo.updateStatusAndAppendThread(input))) ?? update(input.feedbackId, (item) => ({
        ...item, status: input.nextStatus, updatedAt: input.updatedAt, thread: [...item.thread, input.threadEntry]
      })),
    appendThreadEntry: async (input) =>
      (await guard(() => repo.appendThreadEntry(input))) ?? update(input.feedbackId, (item) => ({
        ...item, updatedAt: input.updatedAt, thread: [...item.thread, input.threadEntry]
      })),
    ...(repo.createSpecReviewFinding === undefined ? {} : {
      createSpecReviewFinding: async (id, input) =>
        (await guard(() => repo.createSpecReviewFinding!(id, input))) ?? add(id, input)
    }),
    ...(repo.bindSpecReviewAnchor === undefined ? {} : {
      bindSpecReviewAnchor: async (input) => { await guard(() => repo.bindSpecReviewAnchor!(input)); }
    })
  };
}
