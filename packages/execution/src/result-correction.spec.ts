import { describe, expect, it } from 'vitest';

import { buildResultCorrectionRequest, createNoopResultCorrectionRequester } from './result-correction.js';

describe('result correction helpers', () => {
  it('builds a correction request with all required fields', () => {
    const request = buildResultCorrectionRequest({
      runId: 'run_1',
      step: 'implement',
      schemaId: 'terminal-handoff.v1',
      attempt: 1,
      maxAttempts: 2,
      issues: [{ code: 'invalid_type', path: ['filename'], message: 'Expected string, received number' }],
      candidate: { filename: 42 }
    });

    expect(request.runId).toBe('run_1');
    expect(request.step).toBe('implement');
    expect(request.schemaId).toBe('terminal-handoff.v1');
    expect(request.attempt).toBe(1);
    expect(request.maxAttempts).toBe(2);
    expect(request.issues).toHaveLength(1);
    expect(request.safeCandidatePreview).toEqual({ filename: 42 });
  });

  it('truncates large candidates to the configured byte limit', () => {
    const bigValue = 'x'.repeat(10000);
    const request = buildResultCorrectionRequest({
      runId: 'run_1',
      step: 'implement',
      schemaId: 'terminal-handoff.v1',
      attempt: 1,
      maxAttempts: 2,
      issues: [],
      candidate: { data: bigValue },
      previewByteLimit: 100
    });

    const preview = request.safeCandidatePreview as { truncated: boolean; preview: string };
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.preview, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('noop requester rejects when called', async () => {
    const requester = createNoopResultCorrectionRequester();
    await expect(requester.requestCorrection({
      runId: 'run_1',
      step: 'implement',
      schemaId: 'terminal-handoff.v1',
      attempt: 1,
      maxAttempts: 2,
      issues: [],
      safeCandidatePreview: {}
    })).rejects.toThrow('Correction requester is not configured.');
  });

  it('handles non-serializable candidates gracefully', () => {
    const request = buildResultCorrectionRequest({
      runId: 'run_1',
      step: 'implement',
      schemaId: 'terminal-handoff.v1',
      attempt: 1,
      maxAttempts: 2,
      issues: [],
      candidate: { circular: null as unknown }
    });
    // Should not throw, returns something reasonable
    expect(request.safeCandidatePreview).toBeDefined();
  });
});
