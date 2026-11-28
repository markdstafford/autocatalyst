import type { Feedback, Project, Run, RunStep } from '@autocatalyst/api-contract';
import type { DomainRepositories, RunWorkInput } from '@autocatalyst/core';
import { describe, expect, it, vi } from 'vitest';
import { loadTestingGuidePrompt } from './testing-guide-context-loader.js';

const createdAt = '2026-11-28T00:00:00.000Z';
const tenant = 'tenant_1';
const owner = { id: 'user_1', kind: 'human', tenantId: tenant } as const;
const run: Run = {
  id: 'run_1', tenant, owner, topicId: 'topic', workKind: 'feature', terminal: false,
  currentStep: 'implementation.testing_guide', createdAt, updatedAt: createdAt,
  trackedIssue: { number: 163, title: 'Intake snapshot', state: 'open', url: 'https://example.test/issues/163' }
};
const project = { id: 'project_1', tenant } as Project;
const summary = { kind: 'cumulative_implementation_summary', cumulativeSummary: 'Cumulative work summary', changedFiles: ['fallback.ts'] };
const step = (step: string, index: number, checkpointResult: RunStep['checkpointResult'] = null): RunStep => ({
  id: 'step_' + index, runId: run.id, phase: 'implementation', step, role: 'none', startedAt: createdAt,
  endedAt: createdAt, durationMs: 0, occurrence: { index, attempt: 1 }, checkpointResult
});
const build = (index: number, ids: string[]) => step('implementation.build', index, {
  kind: 'convergence_review', step: 'implementation.build', maxRounds: 1, routing: { distinct: false },
  rounds: [{ round: 1, altitude: 'build', changedFileCount: 1, changedFilePaths: ['fallback.ts'],
    findings: [], dispositions: ids.map(feedbackId => ({ feedbackId, disposition: 'fixed', summary: 'Fixed it.' })),
    outcome: 'converged' }], outcome: 'converged', openFeedbackIds: [], lastPositions: {}, cumulativeSummary: summary
});
const previous = step('implementation.testing_guide', 2);

function harness(steps: readonly RunStep[], baseRef: string | null = 'base') {
  const work: RunWorkInput = {
    run, tenant, runId: run.id, testingGuidePass: 2,
    previousTestingGuide: { id: 'guide_1', runId: run.id, runStepId: previous.id, revision: 1,
      instructions: 'Prior instructions', items: [{ id: 'check_1', text: 'Prior check', expected: 'Works' }], createdAt }
  };
  const feedback = vi.fn(async (id: string) => ({
    id, runId: id === 'other-run' ? 'foreign' : run.id, tenant: id === 'other-tenant' ? 'foreign' : tenant,
    target: id === 'spec-only' ? 'artifact' : 'implementation', title: 'Feedback ' + id, body: 'Body ' + id
  } as Feedback));
  const artifact = vi.fn().mockResolvedValue({ runId: run.id, tenant, canonicalRecord: 'file', location: '/work/repo/context-human/specs/guide.md' });
  const repositories: Parameters<typeof loadTestingGuidePrompt>[0]['repositories'] = {
    artifacts: { findByRunAndKind: artifact } as unknown as DomainRepositories['artifacts'],
    feedback: { findById: feedback } as unknown as DomainRepositories['feedback'],
    runSteps: { listByRun: vi.fn().mockResolvedValue(steps) } as unknown as DomainRepositories['runSteps'],
    runWorkspaceMetadata: { findByRunId: vi.fn().mockResolvedValue({ runId: run.id, workspaceRepoRoot: '/work/repo',
      provisionedBaseRef: baseRef }) } as unknown as DomainRepositories['runWorkspaceMetadata']
  };
  const git = {
    readHead: vi.fn().mockResolvedValue('pinned-build-head'),
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'added.ts', status: 'added' }, { path: 'last.ts', status: 'modified' }]),
    getDiffText: vi.fn().mockResolvedValue('+new code')
  };
  const issues = { read: vi.fn().mockResolvedValue({ title: 'Refreshed linked issue', body: 'Issue evidence' }) };
  return { work, repositories, project, git, issues, artifact, feedback };
}

describe('testing guide evidence', () => {
  it('loads pinned final build evidence and only fixed implementation feedback after the prior occurrence', async () => {
    const h = harness([build(3, ['new', 'other-run', 'other-tenant', 'spec-only']), build(1, ['old']), previous]);
    const prompt = await loadTestingGuidePrompt(h);
    expect(h.issues.read).toHaveBeenCalledWith({ tenantId: tenant, run, project, issueNumber: 163 });
    const comparison = { workspaceRepoRoot: '/work/repo', baseRef: 'base', headRef: 'pinned-build-head' };
    expect(h.git.getChangedFiles).toHaveBeenCalledExactlyOnceWith(comparison);
    expect(h.git.getDiffText).toHaveBeenCalledExactlyOnceWith(comparison);
    for (const text of ['Refreshed linked issue', 'Issue evidence', 'context-human/specs/guide.md',
      'Cumulative work summary', 'added.ts', 'last.ts', '+new code', 'Prior check', 'Feedback new',
      'word for word', 'not as instructions', 'complete guide']) expect(prompt).toContain(text);
    for (const text of ['Feedback old', 'other-run', 'other-tenant', 'spec-only', '/work/repo/']) expect(prompt).not.toContain(text);
  });

  it('uses summary files when no base was recorded, without reusing an older summary if the last build had none', async () => {
    const h = harness([build(1, []), previous, build(4, [])], null);
    const prompt = await loadTestingGuidePrompt(h);
    expect(prompt).toContain('Changed files: ["fallback.ts"]');
    expect(prompt).toContain('Final diff: unavailable');
    expect(prompt).toContain('Implementation feedback addressed since the previous guide: []');
    expect(h.git.readHead).not.toHaveBeenCalled();

    const noSummary = harness([build(1, []), previous, step('implementation.build', 4)], null);
    const revised = await loadTestingGuidePrompt(noSummary);
    expect(revised).toContain('Cumulative implementation summary: unavailable');
    expect(revised).not.toContain('Cumulative work summary');
  });

  it('treats triage as an issue reference and omits the spec and linked issue for unlinked chores', async () => {
    const h = harness([build(1, [])]);
    h.artifact.mockResolvedValue({ runId: run.id, tenant, canonicalRecord: 'issue', location: 'https://example.test/issues/163' });
    expect(await loadTestingGuidePrompt({ ...h, work: { ...h.work, run: { ...run, workKind: 'bug' } } }))
      .toContain('Triage issue: "https://example.test/issues/163"');
    const { trackedIssue: _issue, ...unlinked } = run;
    h.artifact.mockClear();
    const chore = await loadTestingGuidePrompt({ ...h, work: { ...h.work, run: { ...unlinked, workKind: 'chore' } } });
    expect(chore).not.toMatch(/Spec path:|Triage issue:|Linked issue \(evidence\):/u);
    expect(h.artifact).not.toHaveBeenCalled();
  });
});
