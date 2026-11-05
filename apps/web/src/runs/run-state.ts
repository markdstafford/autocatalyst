/**
 * The one shared run-state mapping: the single place that turns a run's `status` and
 * `waitingOn` into the status chip shown in the run list and the detail pane header.
 *
 * This is deliberately free of React and the SDK so the vocabulary and tone mapping are
 * unit-tested in isolation and reused by {@link StatusChip} and its callers without
 * duplication. The complete mapping (the design spec's status chip table):
 *
 * | `status`      | `waitingOn`        | label          | tone              |
 * | ------------- | ------------------ | -------------- | ----------------- |
 * | `in_progress` | `human`            | `Needs review` | `primary` (filled)|
 * | `in_progress` | `ai` / `system`    | `Working`      | `muted`           |
 * | `in_progress` | `none` / missing   | `Paused`       | `muted`           |
 * | `done`        | any                | `Done`         | `green`           |
 * | `failed`      | any                | `Failed`       | `red`             |
 * | `canceled`    | any                | `Canceled`     | `muted`           |
 * | absent        | any                | (no chip)      | —                 |
 *
 * `Needs review` is the only filled primary chip, preserving the design-system rule that
 * the primary fill means "this needs you". `Paused` is a defensive mapping for impossible
 * or malformed client input (an in-progress run with `waitingOn: none` or missing): the
 * control plane sets `waitingOn` for non-terminal runs, so `Paused` is unit-tested only
 * and is not expected in fake-mode demos or real run data.
 */
import type { Run } from '@autocatalyst/api-contract';

import type { ChipTone } from '../ui/chip.js';

/** The derived status chip descriptor, or `null` when a run has no status. */
export interface RunStateChip {
  /** The display label shown inside the chip. */
  readonly label: string;
  /** The design-system chip tone. */
  readonly tone: ChipTone;
  /** Whether the chip is primary-filled. Only `Needs review` is filled. */
  readonly filled: boolean;
}

/**
 * Derive the status chip descriptor for a run, or `null` when `status` is absent so the
 * caller renders the dash placeholder. Terminal statuses ignore `waitingOn`.
 */
export function runStateChip(run: Run): RunStateChip | null {
  const { status } = run;
  if (status === undefined) {
    return null;
  }
  switch (status) {
    case 'done':
      return { label: 'Done', tone: 'green', filled: false };
    case 'failed':
      return { label: 'Failed', tone: 'red', filled: false };
    case 'canceled':
      return { label: 'Canceled', tone: 'muted', filled: false };
    case 'in_progress': {
      if (run.waitingOn === 'human') {
        return { label: 'Needs review', tone: 'primary', filled: true };
      }
      if (run.waitingOn === 'ai' || run.waitingOn === 'system') {
        return { label: 'Working', tone: 'muted', filled: false };
      }
      // `none` or missing `waitingOn`: a defensive, unit-tested-only state.
      return { label: 'Paused', tone: 'muted', filled: false };
    }
  }
}
