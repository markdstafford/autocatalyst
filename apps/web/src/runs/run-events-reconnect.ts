/**
 * Reconnect policy for the selected-run event stream: the backoff constants and the
 * pure classifier the subscription lifecycle uses to decide how to react to a stream
 * that ended or threw.
 *
 * Kept React-free so the delay progression and error classification are unit-tested in
 * isolation. The lifecycle hook (`use-run-detail`) owns the timers and the SDK calls;
 * this module owns the arithmetic and the error taxonomy.
 */
import { ControlPlaneClientError } from '@autocatalyst/sdk';

/** First reconnect delay after a stream ends or fails with a transient error. */
export const RUN_EVENTS_RECONNECT_DELAY_MS = 1_000;

/** Ceiling the exponential backoff doubles up to. */
export const RUN_EVENTS_RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * The next backoff delay. The first retry (no current delay) uses the base; each
 * subsequent retry doubles the previous delay up to the maximum. A valid frame resets
 * the caller's delay back to undefined, so the next failure starts from the base again.
 */
export function nextReconnectDelay(currentDelayMs: number | undefined): number {
  if (currentDelayMs === undefined) {
    return RUN_EVENTS_RECONNECT_DELAY_MS;
  }
  return Math.min(currentDelayMs * 2, RUN_EVENTS_RECONNECT_MAX_DELAY_MS);
}

/** The error codes the control plane returns (as a 409) when a replay cursor is gone. */
export const REPLAY_CURSOR_LOST_CODES = ['run_event_replay_cursor_unknown', 'run_event_replay_cursor_expired'] as const;

/**
 * How the lifecycle should react to a stream open failure or mid-stream error:
 * - `cursor_lost`: resubscribe without an id, wait for attachment, then refresh facts.
 * - `unauthorized`: stop and navigate to the connection page.
 * - `not_found`: stop and show that the run is gone.
 * - `transient`: reconnect with backoff (resuming from the last frame id).
 */
export type StreamErrorReaction = 'cursor_lost' | 'unauthorized' | 'not_found' | 'transient';

export function classifyStreamError(error: unknown): StreamErrorReaction {
  if (error instanceof ControlPlaneClientError) {
    if (error.status === 409 && (REPLAY_CURSOR_LOST_CODES as readonly string[]).includes(error.response.error.code)) {
      return 'cursor_lost';
    }
    if (error.status === 401) {
      return 'unauthorized';
    }
    if (error.status === 404) {
      return 'not_found';
    }
  }
  return 'transient';
}
