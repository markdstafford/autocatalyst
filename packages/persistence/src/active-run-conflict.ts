function isSqliteUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export function isActiveRunConstraintViolation(error: unknown): boolean {
  if (!isSqliteUniqueConstraintError(error)) {
    return false;
  }
  const message = error instanceof Error ? error.message : '';
  // Match only the runs_one_active_per_topic partial unique index
  return message.includes('runs_one_active_per_topic') || message.includes('runs.topic_id');
}

export class ActiveRunConflictPersistenceError extends Error {
  readonly topicId: string;
  readonly existingRunId: string | null;
  constructor(topicId: string, existingRunId: string | null) {
    super(`Active run conflict for topic '${topicId}'.`);
    this.name = 'ActiveRunConflictPersistenceError';
    this.topicId = topicId;
    this.existingRunId = existingRunId;
  }
}
