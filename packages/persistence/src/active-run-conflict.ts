export function isActiveRunConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Exclude other uniqueness failures
  if (message.includes('topics_one_main_per_conversation') || message.includes('pull_requests')) {
    return false;
  }
  // Match the runs_one_active_per_topic partial unique index
  return (
    message.includes('runs_one_active_per_topic') ||
    (message.includes('UNIQUE constraint failed') && message.includes('runs.topic_id'))
  );
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
