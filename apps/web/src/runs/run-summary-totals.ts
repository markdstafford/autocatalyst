/**
 * Pure, integer-exact Summary totals for the detail pane: completed-session time, a
 * compact token total with breakdown, and a nano-dollar cost total.
 *
 * React- and SDK-free so the arithmetic is unit-tested in isolation. The sums stay on
 * integers and never touch floating point: durations are integer milliseconds, tokens
 * are integer counts, and cost is summed as integer nano-dollars and converted to a
 * dollar string only for display. Summing the integer nano-dollars first is what keeps
 * a total like $0.10 + $0.20 exactly $0.30 instead of the $0.30000000000000004 a
 * float sum of dollar amounts would produce.
 */
import type { Session } from '@autocatalyst/api-contract';

/** Nano-dollars (1e-9 USD) per whole dollar. `cost.usd` is an integer nano-dollar value. */
export const NANO_DOLLARS_PER_USD = 1_000_000_000;

export interface TokenBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type TimeTotal = { readonly kind: 'dash' } | { readonly kind: 'value'; readonly ms: number };

export type TokenTotal =
  | { readonly kind: 'dash' }
  | { readonly kind: 'value'; readonly total: number; readonly breakdown: TokenBreakdown };

/**
 * Cost total. `dash` when there are no sessions, `unknown` when at least one session
 * has no priced cost (so no misleading partial sum is shown), otherwise the summed
 * integer nano-dollars.
 */
export type CostTotal =
  | { readonly kind: 'dash' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'value'; readonly nanoUsd: number };

export interface SummaryTotals {
  readonly time: TimeTotal;
  readonly tokens: TokenTotal;
  readonly cost: CostTotal;
}

/** Whether a session's cost is priced: a defined, non-null integer nano-dollar `usd`. */
function isPriced(session: Session): boolean {
  return session.cost.usd !== null && session.cost.usd !== undefined;
}

/**
 * Compute all three totals from the run's durable sessions. One pass; every branch is
 * integer-only.
 */
export function computeSummaryTotals(sessions: readonly Session[]): SummaryTotals {
  if (sessions.length === 0) {
    return { time: { kind: 'dash' }, tokens: { kind: 'dash' }, cost: { kind: 'dash' } };
  }

  // Time: sum only completed sessions (non-null durationMs). Running sessions have a
  // null durationMs and do not contribute.
  let timeMs = 0;
  for (const session of sessions) {
    if (session.durationMs !== null) {
      timeMs += session.durationMs;
    }
  }

  // Tokens: sum all four classes across every session.
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const session of sessions) {
    input += session.tokens.input;
    output += session.tokens.output;
    cacheRead += session.tokens.cacheRead;
    cacheWrite += session.tokens.cacheWrite;
  }
  const tokenBreakdown: TokenBreakdown = { input, output, cacheRead, cacheWrite };
  const tokenTotal = input + output + cacheRead + cacheWrite;

  // Cost: unknown if any session lacks a priced cost; otherwise sum integer nano-dollars.
  let cost: CostTotal;
  if (sessions.some((session) => !isPriced(session))) {
    cost = { kind: 'unknown' };
  } else {
    let nanoUsd = 0;
    for (const session of sessions) {
      // Priced above, so `usd` is a defined integer here.
      nanoUsd += session.cost.usd as number;
    }
    cost = { kind: 'value', nanoUsd };
  }

  return {
    time: { kind: 'value', ms: timeMs },
    tokens: { kind: 'value', total: tokenTotal, breakdown: tokenBreakdown },
    cost
  };
}

// ---------------------------------------------------------------------------
// Display formatting (string output only; no arithmetic that affects the sums)
// ---------------------------------------------------------------------------

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A compact duration from integer milliseconds using the two largest non-zero units
 * among hours, minutes, and seconds. Zero renders as `0s`.
 */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) {
    return '0s';
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((ms % MINUTE_MS) / SECOND_MS);
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/** A compact token count: `1.2K`, `3.4M`, or the plain number below 1,000. */
export function formatCompactTokens(total: number): string {
  if (total < 1_000) {
    return String(total);
  }
  if (total < 1_000_000) {
    return `${trimTenth(total / 1_000)}K`;
  }
  return `${trimTenth(total / 1_000_000)}M`;
}

/** One decimal place, with a trailing `.0` trimmed. */
function trimTenth(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** The token breakdown as tooltip text, each class labeled. */
export function formatTokenBreakdown(breakdown: TokenBreakdown): string {
  return [
    `Input ${breakdown.input.toLocaleString('en-US')}`,
    `Output ${breakdown.output.toLocaleString('en-US')}`,
    `Cache read ${breakdown.cacheRead.toLocaleString('en-US')}`,
    `Cache write ${breakdown.cacheWrite.toLocaleString('en-US')}`
  ].join(' · ');
}

/**
 * Format an integer nano-dollar amount as a dollar string, computed digit-by-digit
 * from the integer so no floating-point division is used. At least two fraction
 * digits; trailing zeros beyond the second are trimmed.
 */
export function formatNanoUsd(nanoUsd: number): string {
  const whole = Math.trunc(nanoUsd / NANO_DOLLARS_PER_USD);
  const fraction = nanoUsd % NANO_DOLLARS_PER_USD;
  let fractionDigits = String(fraction).padStart(9, '0').replace(/0+$/u, '');
  if (fractionDigits.length < 2) {
    fractionDigits = fractionDigits.padEnd(2, '0');
  }
  return `$${whole.toLocaleString('en-US')}.${fractionDigits}`;
}
