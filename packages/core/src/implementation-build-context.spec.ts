import { describe, expect, it } from 'vitest';
import type { Run } from '@autocatalyst/api-contract';

import {
  buildImplementationBuildContext,
  buildImplementationBuildPrompt,
  buildImplementationBuildTaskInputs
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
  });

  it('always includes a step-result.json output instruction in the implementer prompt even when no dispositions are required', () => {
    const prompt = buildImplementationBuildPrompt({
      ...baseInput,
      role: 'implementer',
      reviewContext: {
        altitudeContext: { altitude: 'build', altitudeRound: 1 }
      }
    });

    expect(prompt).toContain('step-result.json');
    expect(prompt).toContain('{}');
  });

  it('builds a read-only reviewer prompt with exact reviewerResultSchema examples', () => {
    const prompt = buildImplementationBuildPrompt(baseInput);

    expect(prompt).not.toContain('Complete the implementation.build step.');
    expect(prompt).toContain('You are the reviewer for `implementation.build`');
    expect(prompt).toContain('read-only');
    expect(prompt).toContain('Write `step-result.json`');
    expect(prompt).toContain('"status": "satisfied"');
    expect(prompt).toContain('"status": "findings"');
    expect(prompt).toContain('Do not emit a feature_spec');
    expect(prompt).toContain('Do not write patches');
  });

  it('builds reviewer task inputs with the reviewer result contract id', () => {
    const inputs = buildImplementationBuildTaskInputs(baseInput);

    expect(inputs.role).toBe('reviewer');
    expect(inputs.round).toBe(1);
    expect(inputs.outputContract).toEqual({
      schemaId: 'autocatalyst.reviewer_result.v1',
      resultFile: 'step-result.json',
      statusValues: ['satisfied', 'findings']
    });
    expect(inputs.reviewMode).toEqual({ accessMode: 'read_only', mayModifyWorkspace: false });
    expect(inputs.approvedSpec?.relativePath).toBe('context-human/specs/feature-real-prompts.md');
  });

  it('builds implementer task inputs without a reviewer output contract', () => {
    const inputs = buildImplementationBuildTaskInputs({ ...baseInput, role: 'implementer' });

    expect(inputs.role).toBe('implementer');
    expect(inputs.outputContract).toBeUndefined();
    expect(inputs.reviewMode).toBeUndefined();
  });

  it('returns prompt and task inputs together', () => {
    const context = buildImplementationBuildContext(baseInput);
    expect(context.prompt).toBe(buildImplementationBuildPrompt(baseInput));
    expect(context.taskInputs).toEqual(buildImplementationBuildTaskInputs(baseInput));
  });
});
