import { describe, expect, it } from 'vitest';

import {
  healthResponseSchema,
  notFoundErrorCode,
  secretStoreLockedErrorCode,
  unauthorizedErrorCode,
  validationErrorCode
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
});
