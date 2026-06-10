import type {
  ClaudeNativeEvent,
  ClaudeSessionLaunch,
  ClaudeSessionLaunchOptions
} from '@autocatalyst/claude-agent-adapter';

/**
 * Records every set of `launch()` options that the Claude agent adapter
 * forwarded to its session-launch seam during a test. Used to assert
 * environment-variable shaping and secret handling.
 */
export interface FakeLaunchRecord {
  readonly env: Record<string, string>;
  readonly prompt: string;
  readonly cwd?: string;
  readonly allowedTools: readonly string[];
  readonly options: Record<string, unknown>;
}

export interface FakeLaunchHarness {
  /**
   * Build a `ClaudeSessionLaunch` that records its options into
   * `records` and then yields the supplied native events.
   */
  createLaunch(events: readonly ClaudeNativeEvent[]): ClaudeSessionLaunch;
  /**
   * Build a `ClaudeSessionLaunch` whose async iterator throws the
   * supplied error before yielding anything. Useful for failure-path
   * tests where the SDK itself fails immediately.
   */
  createFailingLaunch(error: Error): ClaudeSessionLaunch;
  /**
   * Build a `ClaudeSessionLaunch` that simulates retry exhaustion —
   * i.e. the SDK process exited with a non-zero status after all
   * retries were consumed.
   */
  createRetryExhaustedLaunch(): ClaudeSessionLaunch;
  /**
   * Build a `ClaudeSessionLaunch` that simulates a provider protocol
   * failure — i.e. the SDK yielded an unexpected event sequence.
   */
  createProtocolFailureLaunch(): ClaudeSessionLaunch;
  readonly records: FakeLaunchRecord[];
  lastRecord(): FakeLaunchRecord;
}

function snapshotOptions(options: ClaudeSessionLaunchOptions): FakeLaunchRecord {
  return {
    env: { ...(options.env ?? {}) },
    prompt: options.prompt,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    allowedTools: [...(options.allowedTools ?? [])],
    options: { ...(options.options ?? {}) }
  };
}

export function createFakeLaunchHarness(): FakeLaunchHarness {
  const records: FakeLaunchRecord[] = [];

  return {
    records,
    lastRecord(): FakeLaunchRecord {
      const last = records[records.length - 1];
      if (last === undefined) {
        throw new Error('FakeLaunchHarness: no launch records captured yet.');
      }
      return last;
    },
    createLaunch(events: readonly ClaudeNativeEvent[]): ClaudeSessionLaunch {
      return (options) => {
        records.push(snapshotOptions(options));
        async function* iterate(): AsyncIterable<ClaudeNativeEvent> {
          for (const event of events) {
            yield event;
          }
        }
        return iterate();
      };
    },
    createFailingLaunch(error: Error): ClaudeSessionLaunch {
      return (options) => {
        records.push(snapshotOptions(options));
        async function* iterate(): AsyncIterable<ClaudeNativeEvent> {
          throw error;
          // eslint-disable-next-line no-unreachable
          yield {} as ClaudeNativeEvent;
        }
        return iterate();
      };
    },
    createRetryExhaustedLaunch(): ClaudeSessionLaunch {
      return (options) => {
        records.push(snapshotOptions(options));
        async function* iterate(): AsyncIterable<ClaudeNativeEvent> {
          throw new Error('claude process exited with non-zero status after retries');
          // eslint-disable-next-line no-unreachable
          yield {} as ClaudeNativeEvent;
        }
        return iterate();
      };
    },
    createProtocolFailureLaunch(): ClaudeSessionLaunch {
      return (options) => {
        records.push(snapshotOptions(options));
        async function* iterate(): AsyncIterable<ClaudeNativeEvent> {
          throw new Error('Unexpected session event sequence');
          // eslint-disable-next-line no-unreachable
          yield {} as ClaudeNativeEvent;
        }
        return iterate();
      };
    }
  };
}
