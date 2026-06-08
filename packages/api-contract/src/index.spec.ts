import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from './index.js';

describe('api-contract barrel', () => {
  it('exports the health contract', () => {
    expect(
      healthResponseSchema.parse({ status: 'ok', database: { status: 'reachable' } })
    ).toEqual({ status: 'ok', database: { status: 'reachable' } });
  });
});
