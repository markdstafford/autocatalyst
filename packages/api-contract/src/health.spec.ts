import { describe, expect, it } from 'vitest';

import {
  degradedHealthStatusCode,
  healthResponseSchema,
  type HealthResponse
} from './health.js';

describe('health contract', () => {
  it('parses a healthy response', () => {
    const parsed = healthResponseSchema.parse({
      status: 'ok',
      database: { status: 'reachable' }
    });

    const typed: HealthResponse = parsed;
    expect(typed).toEqual({ status: 'ok', database: { status: 'reachable' } });
  });

  it('parses a degraded response', () => {
    expect(
      healthResponseSchema.parse({
        status: 'degraded',
        database: { status: 'unreachable' }
      })
    ).toEqual({ status: 'degraded', database: { status: 'unreachable' } });
  });

  it('rejects invalid health and dependency status values', () => {
    expect(() =>
      healthResponseSchema.parse({ status: 'unknown', database: { status: 'reachable' } })
    ).toThrow();
    expect(() =>
      healthResponseSchema.parse({ status: 'ok', database: { status: 'slow' } })
    ).toThrow();
  });

  it('exports the degraded health status code', () => {
    expect(degradedHealthStatusCode).toBe(503);
  });
});
