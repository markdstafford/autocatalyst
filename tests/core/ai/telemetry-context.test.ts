import { describe, it, expect } from 'vitest';
import { buildTelemetryContext, emptyTelemetryContext } from '../../../src/core/ai/telemetry-context.js';

describe('buildTelemetryContext', () => {
  it('builds context from provided fields', () => {
    const ctx = buildTelemetryContext({ run_id: 'r1', request_id: 'req1', phase: 'implementation', route_task: 'implementation.run', handler: 'ImplementationStartHandler' });
    expect(ctx).toEqual({ run_id: 'r1', request_id: 'req1', phase: 'implementation', route_task: 'implementation.run', handler: 'ImplementationStartHandler' });
  });

  it('emptyTelemetryContext returns empty object', () => {
    expect(emptyTelemetryContext()).toEqual({});
  });
});
