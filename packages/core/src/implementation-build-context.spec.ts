import { describe, expect, it } from 'vitest';
import type { Run } from '@autocatalyst/api-contract';

import {
  buildImplementationBuildContext,
  buildImplementationBuildPrompt,
  buildImplementationBuildTaskInputs,
  implementationBuildResultFile
} from './implementation-build-context.js';
import type { ImplementationBuildPromptInput } from './implementation-build-context.js';

const owner = { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_dev' };

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_feature_12345678',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_dev',
    workKind: 'feature',
    currentStep: 'implementation.build',
    terminal: false,
    trackedIssue: { number: 66, title: 'Fix implementation prompts', state: 'open', url: 'https://github.com/acme/widgets/issues/66' },
    createdAt: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
    ...overrides
  } as Run;
}

const baseInput: ImplementationBuildPromptInput = {
  run: makeRun(),
  role: 'reviewer',
  round: 1,
  approvedSpec: {
    kind: 'feature_spec',
    relativePath: 'context-human/specs/feature-real-prompts.md',
    cachedStatus: 'approved'
  },
  reviewContext: {
    altitudeContext: {
      altitude: 'build',
      altitudeRound: 1,
      allowedWork: 'Build and test the approved implementation.'
    }
  }
};

describe('implementation-build context builders', () => {
  it('builds a concrete implementer prompt with spec path, round, altitude, and disposition instructions', () => {
    const prompt = buildImplementationBuildPrompt({
      ...baseInput,
      role: 'implementer',
      reviewContext: {
        previousFindings: [{ feedbackId: 'fb_1', title: 'Missing test', body: 'Add coverage.', severity: 'blocker' }],
        requiredDispositions: [{ feedbackId: 'fb_1', title: 'Missing test', body: 'Add coverage.', severity: 'blocker' }],
        altitudeContext: {
          altitude: 'public_api',
          altitudeRound: 2,
          allowedWork: 'Change exported types only.'
        }
      }
    });

    expect(prompt).not.toContain('Complete the implementation.build step.');
    expect(prompt).toContain('You are the implementer for `implementation.build`');
    expect(prompt).toContain('Round: 1');
    expect(prompt).toContain('Altitude: public_api');
    expect(prompt).toContain('context-human/specs/feature-real-prompts.md');
    expect(prompt).toContain('Read the approved spec before editing code');
    expect(prompt).toContain('Required dispositions');
    expect(prompt).toContain('"dispositions"');
    expect(prompt).toContain('Do not create branches');
    expect(prompt).toContain('Do not push, merge, or open PRs');
    // The implementer writes its own per-round result file, not the shared step-result.json.
    expect(prompt).toContain('implementation-build-round-1-implementer-result.json');
    expect(prompt).not.toContain('step-result.json');
  });

  it('names the implementer per-round result file and keeps the no-disposition instruction', () => {
    const prompt = buildImplementationBuildPrompt({
      ...baseInput,
      role: 'implementer',
      round: 2,
      reviewContext: {
        altitudeContext: { altitude: 'build', altitudeRound: 1 }
      }
    });

    expect(prompt).toContain('implementation-build-round-2-implementer-result.json');
    expect(prompt).toContain('{}');
  });

  it('builds a read-only reviewer prompt that records the verdict from the final message', () => {
    const prompt = buildImplementationBuildPrompt(baseInput);

    expect(prompt).not.toContain('Complete the implementation.build step.');
    expect(prompt).toContain('You are the reviewer for `implementation.build`');
    expect(prompt).toContain('read-only');
    // The reviewer cannot write files; it must not be told to write one.
    expect(prompt).not.toContain('step-result.json');
    expect(prompt).toContain('final message');
    expect(prompt).toContain('"status": "satisfied"');
    expect(prompt).toContain('"status": "findings"');
    expect(prompt).toContain('Do not emit a feature_spec');
    expect(prompt).toContain('Do not write patches');
  });

  it('builds reviewer task inputs with the reviewer result contract id and per-round result file', () => {
    const inputs = buildImplementationBuildTaskInputs(baseInput);

    expect(inputs.role).toBe('reviewer');
    expect(inputs.round).toBe(1);
    expect(inputs.outputContract).toEqual({
      schemaId: 'autocatalyst.reviewer_result.v1',
      resultFile: 'implementation-build-round-1-reviewer-result.json',
      statusValues: ['satisfied', 'findings']
    });
    expect(inputs.reviewMode).toEqual({ accessMode: 'read_only', mayModifyWorkspace: false });
    expect(inputs.approvedSpec?.relativePath).toBe('context-human/specs/feature-real-prompts.md');
  });

  it('builds implementer task inputs with the disposition contract and per-round result file', () => {
    const inputs = buildImplementationBuildTaskInputs({ ...baseInput, role: 'implementer' });

    expect(inputs.role).toBe('implementer');
    expect(inputs.outputContract).toEqual({
      schemaId: 'autocatalyst.implementer_dispositions.v1',
      resultFile: 'implementation-build-round-1-implementer-result.json'
    });
    expect(inputs.reviewMode).toBeUndefined();
  });

  it('gives every (round, role) a distinct result file name, ordered step then round then role', () => {
    expect(implementationBuildResultFile('implementer', 1)).toBe('implementation-build-round-1-implementer-result.json');
    expect(implementationBuildResultFile('reviewer', 1)).toBe('implementation-build-round-1-reviewer-result.json');
    expect(implementationBuildResultFile('implementer', 2)).toBe('implementation-build-round-2-implementer-result.json');

    const names = new Set([
      implementationBuildResultFile('implementer', 1),
      implementationBuildResultFile('reviewer', 1),
      implementationBuildResultFile('implementer', 2),
      implementationBuildResultFile('reviewer', 2)
    ]);
    expect(names.size).toBe(4);
  });

  it('returns prompt and task inputs together', () => {
    const context = buildImplementationBuildContext(baseInput);
    expect(context.prompt).toBe(buildImplementationBuildPrompt(baseInput));
    expect(context.taskInputs).toEqual(buildImplementationBuildTaskInputs(baseInput));
  });
});
