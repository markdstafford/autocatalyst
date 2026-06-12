import { describe, it } from 'vitest';
import { expectTypeOf } from 'vitest';
import type { ConversationIngressRepository, CreateConversationTopicMessageAndRunInput, CreateConversationTopicMessageAndRunResult } from './domain-repositories.js';
import type { FeedbackRepository, ArtifactRepository, FeedbackStatusTransitionPersistenceInput, FeedbackThreadEntryPersistenceInput, FeedbackConcurrentModificationError } from './domain-repositories.js';

describe('domain-repositories types', () => {
  it('exports ConversationIngressRepository type', () => {
    const _check: ConversationIngressRepository | null = null;
    void _check;
  });
  it('exports CreateConversationTopicMessageAndRunInput type', () => {
    const _check: CreateConversationTopicMessageAndRunInput | null = null;
    void _check;
  });
  it('exports CreateConversationTopicMessageAndRunResult type', () => {
    const _check: CreateConversationTopicMessageAndRunResult | null = null;
    void _check;
  });
});

describe('extended domain repository types', () => {
  it('FeedbackRepository exposes transition methods', () => {
    const repo = {} as FeedbackRepository;
    expectTypeOf(repo.updateStatusAndAppendThread).toBeFunction();
    expectTypeOf(repo.findById).toBeFunction();
    expectTypeOf(repo.listByRun).toBeFunction();
  });

  it('ArtifactRepository exposes run-kind lookup and cached status update', () => {
    const repo = {} as ArtifactRepository;
    expectTypeOf(repo.findByRunAndKind).toBeFunction();
    expectTypeOf(repo.updateCachedStatus).toBeFunction();
  });

  it('FeedbackStatusTransitionPersistenceInput has threadEntry with id and createdAt', () => {
    expectTypeOf<FeedbackStatusTransitionPersistenceInput>().toHaveProperty('threadEntry');
    expectTypeOf<FeedbackThreadEntryPersistenceInput>().toHaveProperty('id');
    expectTypeOf<FeedbackThreadEntryPersistenceInput>().toHaveProperty('createdAt');
  });

  it('FeedbackConcurrentModificationError has feedback_concurrent_modification code', () => {
    const err = {} as FeedbackConcurrentModificationError;
    expectTypeOf(err.code).toEqualTypeOf<'feedback_concurrent_modification'>();
  });
});
