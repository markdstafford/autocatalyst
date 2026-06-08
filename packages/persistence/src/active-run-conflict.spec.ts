import { describe, expect, it } from 'vitest';
import { isActiveRunConstraintViolation } from './active-run-conflict.js';

describe('isActiveRunConstraintViolation', () => {
  it('returns true for runs_one_active_per_topic message', () => {
    expect(isActiveRunConstraintViolation(new Error('UNIQUE constraint failed: runs.topic_id (index: runs_one_active_per_topic)'))).toBe(true);
  });
  it('returns true for UNIQUE constraint failed with runs.topic_id', () => {
    expect(isActiveRunConstraintViolation(new Error('UNIQUE constraint failed: runs.topic_id'))).toBe(true);
  });
  it('returns false for topics_one_main_per_conversation constraint', () => {
    expect(isActiveRunConstraintViolation(new Error('UNIQUE constraint failed: topics.id (index: topics_one_main_per_conversation)'))).toBe(false);
  });
  it('returns false for pull_requests constraint', () => {
    expect(isActiveRunConstraintViolation(new Error('UNIQUE constraint failed: pull_requests.run_id (index: pull_requests_one_per_run)'))).toBe(false);
  });
  it('returns false for unrelated errors', () => {
    expect(isActiveRunConstraintViolation(new Error('some other error'))).toBe(false);
  });
  it('handles non-Error values', () => {
    expect(isActiveRunConstraintViolation('UNIQUE constraint failed: runs.topic_id')).toBe(true);
  });
});
