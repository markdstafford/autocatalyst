import { usageTokenClasses, type Session, type SessionCostTotal } from '@autocatalyst/api-contract';

const labels = { freshInput: 'Fresh input', cacheRead: 'Cache reads', cacheWrite: 'Cache writes', output: 'Output' } as const;

export function summaryDuration(sessions: readonly Session[]): number | null {
  return sessions.length === 0 ? null : sessions.reduce((ms, session) => ms + (session.durationMs ?? 0), 0);
}

export function summaryTokens(sessions: readonly Session[]): { text: string; detail: string } {
  const recorded = sessions.flatMap(({ usage }) => usage === undefined ? [] : [usage]);
  const legacy = sessions.filter(({ usage }) => usage === undefined);
  const legacySum = legacy.reduce((sum, { tokens }) =>
    sum + Object.values(tokens).reduce((subtotal, count) => subtotal + BigInt(count), 0n), 0n);
  const missingWork = legacy.length > 0 || recorded.some(({ coverage }) => coverage !== 'complete');
  let incomplete = missingWork;
  let sum: bigint | null = null;
  const classes = usageTokenClasses.map((key) => {
    let known: bigint | null = null;
    let missing = missingWork;
    let allNotApplicable = !missingWork && recorded.length > 0;
    for (const { groups } of recorded) {
      for (const { tokens } of groups) {
        const count = tokens[key];
        allNotApplicable &&= count === 'not_applicable';
        if (typeof count === 'number') known = (known ?? 0n) + BigInt(count);
        if (count === null) {
          missing = true;
          if (key === 'cacheWrite') {
            for (const bucket of Object.values(tokens.cacheWriteByRetention ?? {})) known = (known ?? 0n) + BigInt(bucket);
          }
        }
      }
    }
    if (known !== null) sum = (sum ?? 0n) + known;
    incomplete ||= missing;
    return labels[key] + ': ' + (known === null ? allNotApplicable ? 'Not applicable' : 'Unknown' :
      known.toLocaleString('en-US') + (missing ? ' (incomplete)' : ''));
  });
  const legacyDetail = legacy.length > 0
    ? ' Legacy: ' + legacySum.toLocaleString('en-US') + ' tokens in ' + legacy.length +
      ' ' + (legacy.length === 1 ? 'session' : 'sessions') + '. Counts may overlap or contain placeholders.'
    : '';
  return {
    text: recorded.length === 0 ? formatCompactTokens(legacySum) + ' · Legacy' :
      (sum === null ? 'Unknown' : formatCompactTokens(sum)) + (incomplete || sum === null ? ' · Incomplete' : ''),
    detail: classes.join(' · ') + '.' + legacyDetail
  };
}

const gapCopy: Record<SessionCostTotal['gaps'][number]['code'], string> = {
  legacy_cache_detail: 'Legacy counts do not establish the cache split',
  missing_usage: 'Usage counts were not reported',
  partial_usage: 'Some work may not have been recorded',
  missing_model: 'Served model is unknown',
  missing_rate: 'No matching rate',
  missing_cache_retention: 'Cache write retention was not reported',
  incompatible_rate: 'Reported usage is incompatible with the rate',
  missing_request_size: 'These tokens could not be priced in any feasible band',
  estimated_request_size: 'Long-context pricing band estimated',
  amount_overflow: 'Amount exceeds the displayable range'
};

export function describeRunCost(total: SessionCostTotal): string {
  const lines = ['Recorded sessions only. API list price is not a subscription charge.'];
  if (!total.complete && total.knownSubtotalUsd !== null) lines.push('This is the known subtotal.');
  for (const gap of total.gaps) {
    const key = [gap.provider, gap.model].filter(Boolean).join('/');
    const details = [
      gap.sessionCount === 0 ? 'run subtotal' : gap.sessionCount + (gap.sessionCount === 1 ? ' session' : ' sessions'),
      ...(gap.tokenClass === undefined ? [] : [labels[gap.tokenClass]]),
      ...(gap.tokenCount === null ? [] : [BigInt(gap.tokenCount).toLocaleString('en-US') + ' tokens'])
    ];
    lines.push(gapCopy[gap.code] + (key === '' ? '' : ' (' + key + ')') + ': ' + details.join(', ') + '.');
    if (gap.hasUnknownTokenCount) lines.push('Additional affected tokens cannot be counted.');
    if (gap.code === 'estimated_request_size') {
      lines.push(gap.method === 'lowest_feasible'
        ? 'Used the lowest feasible band; the true amount may be higher.'
        : 'Used a request-size sample; the true amount may differ in either direction.');
    }
  }
  return lines.join(' ');
}

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

export function formatCompactTokens(total: bigint): string {
  if (total < 1_000n) return String(total);
  const unit = total < 1_000_000n ? 1_000n : 1_000_000n;
  const tenths = (total * 10n + unit / 2n) / unit;
  const fraction = tenths % 10n;
  return String(tenths / 10n) + (fraction === 0n ? '' : '.' + fraction) + (unit === 1_000n ? 'K' : 'M');
}

export function formatNanoUsd(nanoUsd: number): string {
  const amount = BigInt(nanoUsd);
  const unit = 1_000_000_000n;
  const digits = String(amount % unit).padStart(9, '0').replace(/0+$/u, '').padEnd(2, '0');
  return '$' + (amount / unit).toLocaleString('en-US') + '.' + digits;
}
