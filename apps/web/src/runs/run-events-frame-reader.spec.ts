/**
 * Frame-reader tests: split chunks, comment lines, CRLF endings, a final frame without
 * a trailing blank line, schema rejection, and log-once behavior.
 */
import { describe, expect, it, vi } from 'vitest';

import { makeRun, makeTransitionEvent } from './run-fixtures.js';
import { readRunEventFrames, type FrameDropCategory, type RunEventFrame } from './run-events-frame-reader.js';

/** A ReadableStream that emits the given string chunks as UTF-8 bytes, in order. */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index] ?? ''));
        index += 1;
      } else {
        controller.close();
      }
    }
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  log?: (c: FrameDropCategory, d: { eventName?: string }) => void
): Promise<RunEventFrame[]> {
  const frames: RunEventFrame[] = [];
  for await (const frame of readRunEventFrames(stream, log === undefined ? {} : { log })) {
    frames.push(frame);
  }
  return frames;
}

/** A valid run_state_transition SSE data payload for run `runId`. */
function transitionData(runId: string, id: string): string {
  return JSON.stringify(makeTransitionEvent({ id, run: makeRun({ id: runId }) }));
}

describe('readRunEventFrames', () => {
  it('parses a frame whose fields are split across chunks', async () => {
    const data = transitionData('run-1', 'evt-1');
    const whole = `id: evt-1\nevent: run_state_transition\ndata: ${data}\n\n`;
    const mid = Math.floor(whole.length / 2);
    const frames = await collect(streamOf([whole.slice(0, mid), whole.slice(mid)]));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe('evt-1');
    expect(frames[0]?.eventName).toBe('run_state_transition');
    expect(frames[0]?.event.type).toBe('run_state_transition');
  });

  it('ignores comment lines and handles CRLF endings', async () => {
    const data = transitionData('run-2', 'evt-2');
    const payload = `: connected\r\nid: evt-2\r\nevent: run_state_transition\r\ndata: ${data}\r\n\r\n`;
    const frames = await collect(streamOf([payload]));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event.runId).toBe('run-2');
  });

  it('emits a final frame that has no trailing blank line', async () => {
    const data = transitionData('run-3', 'evt-3');
    const payload = `id: evt-3\nevent: run_state_transition\ndata: ${data}`;
    const frames = await collect(streamOf([payload]));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe('evt-3');
  });

  it('carries the persistent id forward as the replay cursor', async () => {
    const payload =
      `id: evt-10\nevent: run_state_transition\ndata: ${transitionData('run-4', 'a')}\n\n` +
      // A second frame with no id of its own keeps the last id.
      `event: run_state_transition\ndata: ${transitionData('run-4', 'b')}\n\n`;
    const frames = await collect(streamOf([payload]));
    expect(frames.map((frame) => frame.id)).toEqual(['evt-10', 'evt-10']);
  });

  it('drops an invalid frame, logs its category once, and keeps reading', async () => {
    const log = vi.fn();
    const good = transitionData('run-5', 'ok');
    const payload =
      'event: run_state_transition\ndata: {not json\n\n' + // JSON parse failure
      'event: run_state_transition\ndata: {"type":"nope"}\n\n' + // schema failure
      'event: run_state_transition\ndata: {"type":"also_bad"}\n\n' + // schema failure again (not re-logged)
      `event: run_state_transition\ndata: ${good}\n\n`; // valid
    const frames = await collect(streamOf([payload]), log);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event.runId).toBe('run-5');
    const categories = log.mock.calls.map((call) => call[0]);
    expect(categories).toEqual(['json_parse', 'schema_validation']);
  });
});
