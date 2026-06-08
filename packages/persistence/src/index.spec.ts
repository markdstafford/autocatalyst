import { describe, expect, it } from 'vitest';

import {
  DrizzleArtifactRepository,
  DrizzleConversationRepository,
  DrizzleFeedbackRepository,
  DrizzleMessageRepository,
  DrizzleProbeResourceRepository,
  DrizzleProjectRepository,
  DrizzlePublicationRepository,
  DrizzlePullRequestRepository,
  DrizzleRunRepository,
  DrizzleRunStepRepository,
  DrizzleSessionRepository,
  DrizzleTestResultRepository,
  DrizzleTopicRepository,
  checkSqliteDatabaseReachability,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from './index.js';

describe('persistence barrel', () => {
  it('exports the public persistence API', () => {
    expect(createSqliteDatabase).toBeTypeOf('function');
    expect(migrateSqliteDatabase).toBeTypeOf('function');
    expect(checkSqliteDatabaseReachability).toBeTypeOf('function');
    expect(DrizzleProbeResourceRepository).toBeTypeOf('function');
    expect(DrizzleProjectRepository).toBeTypeOf('function');
    expect(DrizzleConversationRepository).toBeTypeOf('function');
    expect(DrizzleTopicRepository).toBeTypeOf('function');
    expect(DrizzleMessageRepository).toBeTypeOf('function');
    expect(DrizzleRunRepository).toBeTypeOf('function');
    expect(DrizzleArtifactRepository).toBeTypeOf('function');
    expect(DrizzleFeedbackRepository).toBeTypeOf('function');
    expect(DrizzlePublicationRepository).toBeTypeOf('function');
    expect(DrizzlePullRequestRepository).toBeTypeOf('function');
    expect(DrizzleRunStepRepository).toBeTypeOf('function');
    expect(DrizzleSessionRepository).toBeTypeOf('function');
    expect(DrizzleTestResultRepository).toBeTypeOf('function');
    expect(createDrizzleDomainRepositories).toBeTypeOf('function');
  });
});
