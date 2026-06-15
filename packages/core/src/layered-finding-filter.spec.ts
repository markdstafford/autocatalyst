import { describe, it, expect } from 'vitest';
import type { ConvergenceRoundFinding } from '@autocatalyst/api-contract';
import { filterAltitudeFindings } from './layered-finding-filter.js';

function f(over: Partial<ConvergenceRoundFinding>): ConvergenceRoundFinding {
  return {
    feedbackId: over.feedbackId ?? 'fb_1',
    title: over.title ?? 't',
    body: over.body ?? 'b',
    severity: over.severity ?? 'blocker',
    blocking: over.blocking ?? true,
    signature: over.signature ?? 'sig_1',
    ...over
  };
}

describe('filterAltitudeFindings', () => {
  it('always demotes info severity to non-blocking', () => {
    const result = filterAltitudeFindings({
      altitude: 'build',
      findings: [f({ severity: 'info', blocking: true, category: 'build' })]
    });
    expect(result[0].blocking).toBe(false);
    expect(result[0].blockingReason).toBe('info_non_blocking');
  });

  it('leaves all non-info findings blocking at build altitude', () => {
    const result = filterAltitudeFindings({
      altitude: 'build',
      findings: [
        f({ severity: 'blocker', category: 'public_api', blocking: true }),
        f({ severity: 'warning', category: 'private_api', blocking: true })
      ]
    });
    expect(result[0].blocking).toBe(true);
    expect(result[1].blocking).toBe(true);
  });

  it('keeps layout-category finding blocking at layout altitude', () => {
    const result = filterAltitudeFindings({
      altitude: 'layout',
      findings: [f({ severity: 'blocker', category: 'layout', blocking: true })]
    });
    expect(result[0].blocking).toBe(true);
  });

  it('demotes public_api-category finding at layout altitude as outside scope', () => {
    const result = filterAltitudeFindings({
      altitude: 'layout',
      findings: [f({ severity: 'blocker', category: 'public_api', blocking: true })]
    });
    expect(result[0].blocking).toBe(false);
    expect(result[0].blockingReason).toBe('outside_altitude_scope');
  });

  it('keeps contract_violation blocking across all early altitudes', () => {
    for (const altitude of ['layout', 'public_api', 'private_api'] as const) {
      const result = filterAltitudeFindings({
        altitude,
        findings: [f({ severity: 'blocker', category: 'contract_violation', blocking: true })]
      });
      expect(result[0].blocking).toBe(true);
    }
  });

  it('keeps deterministic altitude_contract findings blocking regardless of altitude category match', () => {
    const result = filterAltitudeFindings({
      altitude: 'layout',
      findings: [f({ severity: 'blocker', source: 'altitude_contract', category: 'contract_violation', blocking: true })]
    });
    expect(result[0].blocking).toBe(true);
  });

  it('preserves deterministic finding blocking value (cannot be demoted by filter)', () => {
    // Even if category looks out-of-scope, source: altitude_contract keeps the original blocking flag.
    const result = filterAltitudeFindings({
      altitude: 'public_api',
      findings: [f({ severity: 'blocker', source: 'build_drift', blocking: true })]
    });
    expect(result[0].blocking).toBe(true);
  });

  it('treats uncategorized reviewer blocker as in-scope (blocking) at layout altitude', () => {
    const result = filterAltitudeFindings({
      altitude: 'layout',
      findings: [f({ severity: 'blocker', source: 'reviewer', blocking: true })]
    });
    expect(result[0].blocking).toBe(true);
  });

  it('treats uncategorized reviewer warning as in-scope (blocking) at public_api altitude', () => {
    const result = filterAltitudeFindings({
      altitude: 'public_api',
      findings: [f({ severity: 'warning', source: 'reviewer', blocking: true })]
    });
    expect(result[0].blocking).toBe(true);
  });

  it('keeps categorized reviewer blocker blocking when category is in altitude allowlist', () => {
    const result = filterAltitudeFindings({
      altitude: 'layout',
      findings: [f({ severity: 'blocker', source: 'reviewer', category: 'layout', blocking: true })]
    });
    expect(result[0].blocking).toBe(true);
  });

  it('demotes categorized reviewer blocker when category is outside altitude allowlist', () => {
    const result = filterAltitudeFindings({
      altitude: 'layout',
      findings: [f({ severity: 'blocker', source: 'reviewer', category: 'build', blocking: true })]
    });
    expect(result[0].blocking).toBe(false);
    expect(result[0].blockingReason).toBe('outside_altitude_scope');
  });

  it('returns an empty array for empty input', () => {
    expect(filterAltitudeFindings({ altitude: 'build', findings: [] })).toEqual([]);
  });
});
