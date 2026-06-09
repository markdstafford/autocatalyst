import { describe, expect, it } from 'vitest';

import {
  activeRunConflictErrorCode,
  conflictErrorCode,
  conversationCollectionPath,
  createConversationWithFirstRunRequestSchema,
  forbiddenErrorCode,
  healthResponseSchema,
  intakeRoutingErrorCode,
  notFoundErrorCode,
  runCollectionPath,
  runEventsPath,
  runResourcePath,
  runStepsPath,
  secretStoreLockedErrorCode,
  submissionKindSchema,
  unauthorizedErrorCode,
  validationErrorCode,
  runnerEventSchema,
  executionContextSchema,
  type RunnerEvent,
  type ExecutionContext
} from './index.js';

describe('api-contract barrel', () => {
  it('exports the health contract', () => {
    expect(
      healthResponseSchema.parse({ status: 'ok', database: { status: 'reachable' } })
    ).toEqual({ status: 'ok', database: { status: 'reachable' } });
  });

  it('exports stable shared error code constants', () => {
    expect(unauthorizedErrorCode).toBe('unauthorized');
    expect(validationErrorCode).toBe('validation_error');
    expect(notFoundErrorCode).toBe('not_found');
    expect(secretStoreLockedErrorCode).toBe('secret_store_locked');
  });

  it('exports new error code constants', () => {
    expect(conflictErrorCode).toBe('conflict');
    expect(activeRunConflictErrorCode).toBe('active_run_conflict');
    expect(intakeRoutingErrorCode).toBe('intake_routing_error');
    expect(forbiddenErrorCode).toBe('forbidden');
  });

  it('exports conversation ingress contract', () => {
    expect(conversationCollectionPath).toBe('/v1/conversations');
    expect(submissionKindSchema.parse('free_form')).toBe('free_form');
    expect(() => createConversationWithFirstRunRequestSchema.parse({})).toThrow();
  });

  it('exports run path constants', () => {
    expect(runCollectionPath).toBe('/v1/runs');
    expect(runResourcePath).toBe('/v1/runs/:id');
    expect(runStepsPath).toBe('/v1/runs/:id/steps');
    expect(runEventsPath).toBe('/v1/runs/:id/events');
  });

  it('exports runner event and execution context contracts', () => {
    expect(runnerEventSchema).toBeDefined();
    expect(executionContextSchema).toBeDefined();
  });
});
