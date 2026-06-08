import { describe, expect, it } from 'vitest';

import { healthResponseSchema } from '@autocatalyst/api-contract';

import { getHealth, type HealthDependencyChecker } from './health.js';

describe('getHealth', () => {
  it('returns ok when the database is reachable', async () => {
    const checker: HealthDependencyChecker = { isDatabaseReachable: async () => true };

    const response = await getHealth(checker);

    expect(healthResponseSchema.parse(response)).toEqual({
      status: 'ok',
      database: { status: 'reachable' }
    });
  });

  it('returns degraded when the database is unreachable', async () => {
    const checker: HealthDependencyChecker = { isDatabaseReachable: async () => false };

    await expect(getHealth(checker)).resolves.toEqual({
      status: 'degraded',
      database: { status: 'unreachable' }
    });
  });

  it('converts checker errors into degraded health', async () => {
    const checker: HealthDependencyChecker = {
      isDatabaseReachable: async () => {
        throw new Error('database closed');
      }
    };

    await expect(getHealth(checker)).resolves.toEqual({
      status: 'degraded',
      database: { status: 'unreachable' }
    });
  });
});
