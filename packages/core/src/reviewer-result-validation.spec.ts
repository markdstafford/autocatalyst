import { describe, expect, it } from 'vitest';

import type { ResultCorrectionRequest } from '@autocatalyst/execution';
import { validateReviewerResult } from './reviewer-result-validation.js';

const baseInput = {
  runId: 'run_1',
  step: 'implementation.build',
  rawResult: { status: 'satisfied', findings: [] }
};

describe('validateReviewerResult', () => {
  it('accepts an already valid reviewer result', async () => {
    const result = await validateReviewerResult(baseInput);

    expect(result).toMatchObject({
      status: 'valid',
      value: { status: 'satisfied', findings: [] },
      normalized: false,
      correctedAttempts: 0
    });
    if (result.status === 'valid') {
      expect(result.events.at(-1)).toMatchObject({ kind: 'accepted' });
    }
  });

  it('rejects an empty object as invalid instead of fabricating a satisfied reviewer result', async () => {
    const result = await validateReviewerResult({
      runId: 'run_1',
      step: 'implementation.build',
      rawResult: {}
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'reviewer_result_invalid' });
  });

  it('normalizes empty findings to a satisfied reviewer result', async () => {
    const result = await validateReviewerResult({
      runId: 'run_1',
      step: 'implementation.build',
      rawResult: { findings: [] }
    });

    expect(result).toMatchObject({
      status: 'valid',
      value: { status: 'satisfied', findings: [] },
      normalized: true
    });
    if (result.status === 'valid') {
      expect(result.events.some((event) => event.kind === 'normalized')).toBe(true);
    }
  });

  it('uses correction for an initially invalid reviewer result', async () => {
    const requests: ResultCorrectionRequest[] = [];
    const result = await validateReviewerResult({
      runId: 'run_1',
      step: 'implementation.build',
      rawResult: { findings: [{ title: 'Missing status', body: 'Ambiguous.', severity: 'blocker' }] },
      maxCorrectionAttempts: 1,
      correctionRequester: {
        async requestCorrection(request) {
          requests.push(request);
          return { status: 'findings', findings: [{ title: 'Real blocker', body: 'Fix it.', severity: 'blocker' }] };
        }
      }
    });

    expect(result).toMatchObject({ status: 'valid', correctedAttempts: 1, normalized: false });
    if (result.status === 'valid') {
      expect(result.events.some((event) => event.kind === 'corrected')).toBe(true);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      runId: 'run_1',
      step: 'implementation.build',
      schemaId: 'autocatalyst.reviewer_result.v1',
      attempt: 1,
      maxAttempts: 1
    });
  });

  it('maps exhausted correction to reviewer_result_invalid without exposing raw details', async () => {
    const result = await validateReviewerResult({
      runId: 'run_1',
      step: 'implementation.build',
      rawResult: { status: 'unknown', secretPath: '/Users/operator/private-output.json' },
      maxCorrectionAttempts: 1,
      correctionRequester: {
        async requestCorrection() {
          return { status: 'unknown', diagnostic: 'provider-token-123' };
        }
      }
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'reviewer_result_invalid' });
    if (result.status === 'failed') {
      expect(result.events.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(result)).not.toContain('/Users/operator/private-output.json');
    expect(JSON.stringify(result)).not.toContain('provider-token-123');
  });

  it('maps invalid output without correction support to reviewer_result_invalid', async () => {
    const result = await validateReviewerResult({
      runId: 'run_1',
      step: 'implementation.build',
      rawResult: { status: 'unknown' }
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'reviewer_result_invalid' });
    if (result.status === 'failed') {
      expect(result.events.length).toBeGreaterThan(0);
    }
  });
});
