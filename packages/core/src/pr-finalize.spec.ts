import { describe, expect, it } from 'vitest';

import type { NonModelPrincipal } from '@autocatalyst/api-contract';

import type { CumulativeImplementationSummary } from './implementation-summary.js';
import {
  buildPullRequestFinalizeCheckpoint,
  buildPullRequestFinalizePrompt,
  feedbackInputsFromPullRequestFinalizeFindings,
  parsePullRequestFinalizeResult,
  type PullRequestFinalizeFinding,
  type PullRequestFinalizePromptInput
} from './pr-finalize.js';

function makeSummary(overrides: Partial<CumulativeImplementationSummary> = {}): CumulativeImplementationSummary {
  return {
    kind: 'cumulative_implementation_summary',
    cumulativeSummary: 'Implemented the widget feature with tests.',
    changedFiles: ['packages/core/src/widget.ts'],
    validationSummary: ['vitest run passed'],
    followUps: ['Add docs in a follow-up PR'],
    nonGoals: [],
    sourceRoundCount: 2,
    completedAt: '2026-06-16T00:00:00.000Z',
    ...overrides
  };
}

function makePromptInput(overrides: Partial<PullRequestFinalizePromptInput> = {}): PullRequestFinalizePromptInput {
  return {
    runId: 'run_42',
    workKind: 'feature',
    branch: 'feature/widget',
    workspacePath: '/tmp/ws_run_42',
    specArtifactPath: 'context-human/specs/widget.md',
    cumulativeSummary: makeSummary(),
    ...overrides
  };
}

function owner(): NonModelPrincipal {
  return { id: 'user_1', kind: 'human', tenantId: 'tenant_1' };
}

describe('buildPullRequestFinalizePrompt', () => {
  it('includes run id, work kind, branch, and workspace path', () => {
    const prompt = buildPullRequestFinalizePrompt(makePromptInput());
    expect(prompt).toContain('Run ID: run_42');
    expect(prompt).toContain('Work kind: feature');
    expect(prompt).toContain('Branch: feature/widget');
    expect(prompt).toContain('Workspace: /tmp/ws_run_42');
  });

  it('includes cumulative summary text and round count', () => {
    const prompt = buildPullRequestFinalizePrompt(makePromptInput());
    expect(prompt).toContain('Round count: 2');
    expect(prompt).toContain('Implemented the widget feature with tests.');
  });

  it('contains read-only instructions', () => {
    const prompt = buildPullRequestFinalizePrompt(makePromptInput());
    expect(prompt.toLowerCase()).toContain('read-only');
  });

  it('contains a "Do not write files" instruction', () => {
    const prompt = buildPullRequestFinalizePrompt(makePromptInput());
    expect(prompt).toContain('Do not write files');
  });

  it('contains "Do not commit", "Do not push", and "Do not merge" instructions', () => {
    const prompt = buildPullRequestFinalizePrompt(makePromptInput());
    expect(prompt).toContain('do not commit');
    expect(prompt).toContain('do not push');
    expect(prompt).toContain('do not merge');
  });

  it('omits the spec artifact line when not supplied', () => {
    const prompt = buildPullRequestFinalizePrompt(makePromptInput({ specArtifactPath: null }));
    expect(prompt).not.toContain('Spec artifact:');
  });
});

describe('parsePullRequestFinalizeResult', () => {
  it('accepts a valid advance result', () => {
    const parsed = parsePullRequestFinalizeResult({
      directive: 'advance',
      reconciledSummary: 'Done.',
      titleSubject: 'feat: widget',
      validationSummary: ['vitest'],
      findings: []
    });
    expect(parsed.directive).toBe('advance');
    expect(parsed.titleSubject).toBe('feat: widget');
    expect(parsed.findings).toEqual([]);
  });

  it('accepts a valid revise result with findings', () => {
    const parsed = parsePullRequestFinalizeResult({
      directive: 'revise',
      findings: [
        { severity: 'blocker', summary: 'Secret leaked', target: 'implementation' }
      ]
    });
    expect(parsed.directive).toBe('revise');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.severity).toBe('blocker');
  });

  it('throws for invalid input shape', () => {
    expect(() => parsePullRequestFinalizeResult({ directive: 'nope' })).toThrow(/Invalid pr.finalize result/);
    expect(() => parsePullRequestFinalizeResult({})).toThrow();
    expect(() => parsePullRequestFinalizeResult(null)).toThrow();
  });
});

describe('feedbackInputsFromPullRequestFinalizeFindings', () => {
  it('maps blocker and warning findings to CreateFeedbackInput targeted at implementation', () => {
    const findings: PullRequestFinalizeFinding[] = [
      { severity: 'blocker', summary: 'Secret leaked' },
      { severity: 'warning', summary: 'Validation gap' },
      { severity: 'info', summary: 'Cosmetic note' }
    ];
    const inputs = feedbackInputsFromPullRequestFinalizeFindings('run_42', 'tenant_1', owner(), findings, {
      clock: () => '2026-06-16T00:00:00.000Z'
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.target).toBe('implementation');
    expect(inputs[0]?.status).toBe('open');
    expect(inputs[0]?.title).toBe('Secret leaked');
    expect(inputs[0]?.body).toContain('Severity: blocker');
    expect(inputs[0]?.runId).toBe('run_42');
    expect(inputs[0]?.tenant).toBe('tenant_1');
    expect(inputs[0]?.thread).toHaveLength(1);
    expect(inputs[1]?.title).toBe('Validation gap');
  });

  it('returns an empty array when no blockers or warnings exist', () => {
    const findings: PullRequestFinalizeFinding[] = [{ severity: 'info', summary: 'note' }];
    const inputs = feedbackInputsFromPullRequestFinalizeFindings('r', 't', owner(), findings);
    expect(inputs).toEqual([]);
  });

  it('maps a credential-leak blocker finding to a CreateFeedbackInput with target implementation', () => {
    const findings: PullRequestFinalizeFinding[] = [
      { severity: 'blocker', summary: 'Credential leak detected: API key committed to branch', target: 'implementation' }
    ];
    const inputs = feedbackInputsFromPullRequestFinalizeFindings('run_sec', 'tenant_1', owner(), findings, {
      clock: () => '2026-06-16T00:00:00.000Z'
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.target).toBe('implementation');
    expect(inputs[0]?.status).toBe('open');
    expect(inputs[0]?.title).toBe('Credential leak detected: API key committed to branch');
    expect(inputs[0]?.body).toContain('Severity: blocker');
  });

  it('maps an unauthorized-file blocker finding to a CreateFeedbackInput with target implementation', () => {
    const findings: PullRequestFinalizeFinding[] = [
      { severity: 'blocker', summary: 'Unauthorized file committed: private key found in repository', target: 'implementation' }
    ];
    const inputs = feedbackInputsFromPullRequestFinalizeFindings('run_sec', 'tenant_1', owner(), findings, {
      clock: () => '2026-06-16T00:00:00.000Z'
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.target).toBe('implementation');
    expect(inputs[0]?.title).toBe('Unauthorized file committed: private key found in repository');
    expect(inputs[0]?.body).toContain('Severity: blocker');
    expect(inputs[0]?.runId).toBe('run_sec');
  });
});

describe('parsePullRequestFinalizeResult (deprecated strict parser)', () => {
  it('still rejects {} and unknown fields', () => {
    expect(() => parsePullRequestFinalizeResult({})).toThrow(/Invalid pr\.finalize result/);
    expect(() => parsePullRequestFinalizeResult({ directive: 'advance', unknown: true })).toThrow(/Invalid pr\.finalize result/);
  });
});

describe('buildPullRequestFinalizeCheckpoint', () => {
  it('returns a checkpoint with the expected structure for advance', () => {
    const checkpoint = buildPullRequestFinalizeCheckpoint(
      {
        directive: 'advance',
        reconciledSummary: 'Reconciled.',
        titleSubject: 'feat: widget',
        validationSummary: ['vitest'],
        findings: []
      },
      { clock: () => '2026-06-16T01:02:03.000Z' }
    );
    expect(checkpoint).toMatchObject({
      kind: 'pull_request_finalize',
      directive: 'advance',
      reconciledSummary: 'Reconciled.',
      titleSubject: 'feat: widget',
      validationSummary: ['vitest'],
      findings: [],
      completedAt: '2026-06-16T01:02:03.000Z'
    });
  });

  it('returns a checkpoint with findings for revise', () => {
    const checkpoint = buildPullRequestFinalizeCheckpoint(
      {
        directive: 'revise',
        findings: [{ severity: 'blocker', summary: 'Bad' }]
      },
      { clock: () => '2026-06-16T01:02:03.000Z' }
    ) as Record<string, unknown>;
    expect(checkpoint['directive']).toBe('revise');
    expect(checkpoint['reconciledSummary']).toBeNull();
    expect(checkpoint['titleSubject']).toBeNull();
    expect(checkpoint['findings']).toEqual([
      { severity: 'blocker', summary: 'Bad', target: null }
    ]);
  });
});
