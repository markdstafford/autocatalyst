import { createHash } from 'node:crypto';
import type { ReviewerFinding, ConvergenceRoundRecord } from '@autocatalyst/api-contract';

export function findingSignature(finding: ReviewerFinding): string {
  const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const bodyHash = createHash('sha256')
    .update(normalized(finding.body))
    .digest('hex')
    .slice(0, 16);
  const anchor = finding.anchor !== undefined ? JSON.stringify(finding.anchor) : '';
  return `${finding.severity}:${normalized(finding.title)}:${bodyHash}:${anchor}`;
}

export function isBlockingFinding(finding: ReviewerFinding, declinedSignatures: readonly string[]): boolean {
  if (finding.severity === 'info') return false;
  const sig = findingSignature(finding);
  return !declinedSignatures.includes(sig);
}

export function computeCurrentBlockingSet(
  findings: readonly ReviewerFinding[],
  declinedSignatures: readonly string[]
): readonly string[] {
  return findings
    .filter(f => isBlockingFinding(f, declinedSignatures))
    .map(f => findingSignature(f));
}

export function detectOscillation(
  previousRounds: readonly ConvergenceRoundRecord[],
  currentBlockingSignatures: readonly string[]
): boolean {
  if (previousRounds.length === 0) return false;

  const lastRound = previousRounds[previousRounds.length - 1];
  if (lastRound === undefined) return false;

  const previousBlockingSignatures = lastRound.findings
    .filter(f => f.blocking)
    .map(f => f.signature);

  const repeatedSignature = currentBlockingSignatures.some(sig => previousBlockingSignatures.includes(sig));
  if (repeatedSignature) return true;

  if (currentBlockingSignatures.length >= previousBlockingSignatures.length && previousBlockingSignatures.length > 0) {
    return true;
  }

  return false;
}
