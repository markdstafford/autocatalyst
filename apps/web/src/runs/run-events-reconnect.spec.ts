/**
 * Reconnect-policy tests: the backoff progression and the stream-error classifier.
 */
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import { describe, expect, it } from 'vitest';

import {
  RUN_EVENTS_RECONNECT_DELAY_MS,
  RUN_EVENTS_RECONNECT_MAX_DELAY_MS,
  classifyStreamError,
  nextReconnectDelay
} from './run-events-reconnect.js';

describe('nextReconnectDelay', () => {
  it('starts at the base delay and doubles up to the maximum', () => {
    let delay = nextReconnectDelay(undefined);
    expect(delay).toBe(RUN_EVENTS_RECONNECT_DELAY_MS);
    const seen = [delay];
    for (let i = 0; i < 10; i += 1) {
      delay = nextReconnectDelay(delay);
      seen.push(delay);
    }
    // Monotonically non-decreasing and capped.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
      expect(seen[i]).toBeLessThanOrEqual(RUN_EVENTS_RECONNECT_MAX_DELAY_MS);
    }
    expect(seen[seen.length - 1]).toBe(RUN_EVENTS_RECONNECT_MAX_DELAY_MS);
  });
});

describe('classifyStreamError', () => {
  function error(status: number, code: string): ControlPlaneClientError {
    return new ControlPlaneClientError(status, { error: { code, message: 'x' } });
  }

  it('maps both cursor-loss codes to cursor_lost', () => {
    expect(classifyStreamError(error(409, 'run_event_replay_cursor_unknown'))).toBe('cursor_lost');
    expect(classifyStreamError(error(409, 'run_event_replay_cursor_expired'))).toBe('cursor_lost');
  });

  it('maps 401 to unauthorized and 404 to not_found', () => {
    expect(classifyStreamError(error(401, 'unauthorized'))).toBe('unauthorized');
    expect(classifyStreamError(error(404, 'not_found'))).toBe('not_found');
  });

  it('treats other errors, and a non-cursor 409, as transient', () => {
    expect(classifyStreamError(error(409, 'conflict'))).toBe('transient');
    expect(classifyStreamError(error(500, 'internal'))).toBe('transient');
    expect(classifyStreamError(new Error('network'))).toBe('transient');
  });
});
