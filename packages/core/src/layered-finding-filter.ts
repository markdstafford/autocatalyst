import type { ConvergenceRoundFinding, ImplementationAltitude } from '@autocatalyst/api-contract';

export interface FilterAltitudeFindingsInput {
  readonly altitude: ImplementationAltitude;
  readonly findings: readonly ConvergenceRoundFinding[];
}

const earlyAllowlist: Record<'layout' | 'public_api' | 'private_api', ReadonlySet<string>> = {
  layout: new Set(['layout', 'contract_violation']),
  public_api: new Set(['public_api', 'contract_violation']),
  private_api: new Set(['private_api', 'contract_violation'])
};

function isDeterministicSource(source: ConvergenceRoundFinding['source']): boolean {
  return source === 'altitude_contract' || source === 'build_drift';
}

function withBlocking(
  finding: ConvergenceRoundFinding,
  blocking: boolean,
  reason?: string
): ConvergenceRoundFinding {
  if (finding.blocking === blocking && (reason === undefined || finding.blockingReason === reason)) {
    return finding;
  }
  return { ...finding, blocking, ...(reason !== undefined ? { blockingReason: reason } : {}) };
}

export function filterAltitudeFindings(input: FilterAltitudeFindingsInput): ConvergenceRoundFinding[] {
  const { altitude, findings } = input;
  return findings.map(finding => {
    // Info severity is never blocking.
    if (finding.severity === 'info') {
      return withBlocking(finding, false, 'info_non_blocking');
    }
    // Build altitude: leave non-info findings blocking as-is.
    if (altitude === 'build') {
      return finding;
    }
    // Deterministic sources retain their original blocking value at early altitudes.
    if (isDeterministicSource(finding.source)) {
      return finding;
    }
    // Reviewer (or unknown-source) findings at early altitudes are scoped by category.
    const allowlist = earlyAllowlist[altitude];
    // No category → conservative: treat as in-scope (reviewer doesn't know better).
    if (finding.category === undefined) {
      return finding;
    }
    // Category explicitly in scope → blocking.
    if (allowlist.has(finding.category)) {
      return finding;
    }
    // Category explicitly outside scope → demote.
    return withBlocking(finding, false, 'outside_altitude_scope');
  });
}
