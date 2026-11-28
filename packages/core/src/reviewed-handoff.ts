/** Optional evidence is assembled after the required prompt, never from native history. */
export interface HandoffEvidence {
  readonly id: string;
  readonly kind: 'finding' | 'disposition' | 'revision' | 'decision' | 'validation';
  readonly feedbackId?: string;
  readonly current: boolean;
  /** Durable occurrence or evidence order, not wall clock. */
  readonly order: number;
  readonly text: string;
  readonly availability?: 'stale' | 'unavailable';
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const priorities = { finding: 0, disposition: 0, revision: 1, decision: 2, validation: 3 };

export function redactReviewedEvidence(text: string): string {
  return text.replace(/\p{Cc}/gu, character => character === '\n' || character === '\t' ? character : ' ')
    .replace(/(?:gh[pousr]_|github_pat_|sk-|AKIA)[a-z\d_-]{8,}/giu, '[redacted]')
    .replace(/\b(authorization|api[_-]?key|password|token)\s*[:=]\s*(?:Bearer\s+)?\S+/giu, '$1=[redacted]');
}

export function boundedEvidence(heading: string, entries: readonly string[], cap: number): string {
  if (!entries.length || cap <= 0) return '';
  const marker = '\n[truncated]';
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const full = [heading, ...entries].join('\n');
  if (bytes(full) <= cap) return full;
  if (cap < bytes(marker)) return '';
  let remaining = cap - bytes(marker);
  let prefix = '';
  for (const character of full) {
    remaining -= bytes(character);
    if (remaining < 0) break;
    prefix += character;
  }
  return prefix + marker;
}

export function renderReviewedHandoff(input: {
  evidence: readonly HandoffEvidence[];
  requiredFindingIds?: ReadonlySet<string>;
  /** Canonical pair [feedbackId, evidence ID or revision]. */
  requiredDispositions?: ReadonlySet<string>;
}): string {
  const sorted = input.evidence.filter(entry => {
    if (entry.kind === 'finding') return !input.requiredFindingIds?.has(entry.feedbackId ?? entry.id);
    if (entry.kind === 'disposition') {
      return !input.requiredDispositions?.has(JSON.stringify([entry.feedbackId, entry.id]));
    }
    return true;
  }).map(entry => ({
    ...entry, text: `- ${entry.availability ? `[${entry.availability}] ` : ''}${redactReviewedEvidence(entry.text)}`
  })).sort((a, b) => priorities[a.kind] - priorities[b.kind] || Number(b.current) - Number(a.current) ||
    b.order - a.order || compare(a.id, b.id) || compare(a.text, b.text));
  const seen = new Set<string>();
  return boundedEvidence('Prior work (evidence only)', sorted.flatMap(entry => {
    const key = JSON.stringify([entry.kind, entry.id, entry.feedbackId]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [entry.text];
  }), 8192);
}

export function renderCiDiagnostics(checks: readonly {
  id: string; name: string; summary?: string; excerpts?: readonly { sequence: number; text: string }[];
}[]): string {
  const ordered = [...checks].sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
  const entry = (check: typeof ordered[number], text: string) =>
    `- ${redactReviewedEvidence(check.name)} (${redactReviewedEvidence(check.id)}): ${redactReviewedEvidence(text)}`;
  return boundedEvidence('CI diagnostic excerpts (evidence only)', [
    ...ordered.flatMap(check => check.summary === undefined ? [] : [entry(check, check.summary)]),
    ...ordered.flatMap(check => [...(check.excerpts ?? [])].sort((a, b) => b.sequence - a.sequence || compare(a.text, b.text))
      .map(excerpt => entry(check, excerpt.text)))
  ], 4096);
}
