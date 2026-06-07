import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from './index.js';

describe('api-contract scaffold', () => {
  it('validates the health response scaffold schema', () => {
    expect(healthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });
});
