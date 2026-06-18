import { describe, expect, it } from 'vitest';
import { validatePullRequestFinalizeResult } from './pr-finalize-result-validation.js';

describe('validatePullRequestFinalizeResult', () => {
  it('normalizes an empty object to a typed clean advance', async () => {
    const outcome = await validatePullRequestFinalizeResult({ runId: 'run_pr_1', rawResult: {} });
    expect(outcome.status).toBe('valid');
    if (outcome.status !== 'valid') return;
    expect(outcome.value).toEqual({ directive: 'advance', findings: [] });
    expect(outcome.normalized).toBe(true);
  });

  it('accepts a valid advance result without normalization', async () => {
    const outcome = await validatePullRequestFinalizeResult({
      runId: 'run_pr_2',
      rawResult: { directive: 'advance', findings: [] }
    });
    expect(outcome.status).toBe('valid');
    if (outcome.status !== 'valid') return;
    expect(outcome.value).toEqual({ directive: 'advance', findings: [] });
  });

  it('accepts a valid revise result with findings', async () => {
    const outcome = await validatePullRequestFinalizeResult({
      runId: 'run_pr_3',
      rawResult: {
        directive: 'revise',
        findings: [{ severity: 'blocker', summary: 'Fix the secret' }]
      }
    });
    expect(outcome.status).toBe('valid');
    if (outcome.status !== 'valid') return;
    expect(outcome.value.directive).toBe('revise');
    expect(outcome.value.findings[0]?.severity).toBe('blocker');
  });

  it('fails ambiguous invalid candidates safely without leaking secrets', async () => {
    const outcome = await validatePullRequestFinalizeResult({
      runId: 'run_pr_4',
      rawResult: { directive: 'ship', secret: 'do-not-leak' },
      maxCorrectionAttempts: 0
    });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'pr_finalize_invalid_result' });
    expect(JSON.stringify(outcome)).not.toContain('do-not-leak');
  });

  it('fails invalid non-object candidates safely', async () => {
    const outcome = await validatePullRequestFinalizeResult({
      runId: 'run_pr_5',
      rawResult: 'not-an-object',
      maxCorrectionAttempts: 0
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.reason).toBe('pr_finalize_invalid_result');
  });

  it('fails contradictory advance+blocker result safely — ambiguous and must not be guessed', async () => {
    const outcome = await validatePullRequestFinalizeResult({
      runId: 'run_pr_6',
      rawResult: { directive: 'advance', findings: [{ severity: 'blocker', summary: 'Must fix before merge' }] },
      maxCorrectionAttempts: 0
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.reason).toBe('pr_finalize_invalid_result');
  });

  it('does not fail advance result with only warning/info findings', async () => {
    const outcome = await validatePullRequestFinalizeResult({
      runId: 'run_pr_7',
      rawResult: {
        directive: 'advance',
        findings: [{ severity: 'warning', summary: 'Minor style concern' }, { severity: 'info', summary: 'FYI' }]
      }
    });
    expect(outcome.status).toBe('valid');
    if (outcome.status !== 'valid') return;
    expect(outcome.value.directive).toBe('advance');
  });
});
