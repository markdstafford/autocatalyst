import { describe, expect, it, vi } from 'vitest';
import { issueWorkKindSchema, type IssueWorkKindDerivation, type Project } from '@autocatalyst/api-contract';
import { DefaultIssueReferenceIntakeResolver, type ResolveConversationCreateInput } from './issue-reference-intake.js';
import { IssueTrackerError } from './issue-tracker.js';
import type { IssueTrackerRegistry } from './issue-tracker-registry.js';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_abc' };

const baseProject: Project = {
  id: 'proj_123',
  owner,
  tenant: 'tenant_abc',
  displayName: 'Test',
  repoUrl: 'https://github.com/markdstafford/autocatalyst',
  hostRepository: { provider: 'github', owner: 'markdstafford', name: 'autocatalyst' },
  workspaceRootOverride: null,
  issueTrackerSetting: { provider: 'github' },
  codeHostSetting: null,
  credentialRefs: [{ id: 'cred_1', purpose: 'issue_tracker' }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const enrichedIssue = {
  number: 71,
  title: 'feat: Start from issue reference',
  body: 'Issue body',
  labels: ['feature'],
  state: 'open' as const,
  url: 'https://github.com/markdstafford/autocatalyst/issues/71'
};

const issueReferenceInput = {
  submission: { kind: 'issue_reference', body: 'work on issue 71', issue: { number: 71 } },
  project: baseProject,
  tenant: 'tenant_abc'
} satisfies ResolveConversationCreateInput;

function makeRegistry(issue = enrichedIssue): IssueTrackerRegistry {
  return {
    get: vi.fn().mockReturnValue({
      read: vi.fn().mockResolvedValue(issue)
    })
  };
}

describe('DefaultIssueReferenceIntakeResolver', () => {
  // --- Recognition ---

  it('resolves structured issue_reference submission', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    const result = await resolver.resolve({
      submission: { kind: 'issue_reference', body: 'work on issue 71', issue: { number: 71 } },
      project: baseProject,
      tenant: 'tenant_abc'
    });
    expect(result.workKind).toBe('feature');
    expect(result.trackedIssue).toEqual(enrichedIssue);
    expect(result.messageBody).toBe('work on issue 71');
  });

  it('resolves free_form with "issue #71" pattern', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    const result = await resolver.resolve({
      submission: { kind: 'free_form', body: 'work on issue #71' },
      project: baseProject,
      tenant: 'tenant_abc'
    });
    expect(result.workKind).toBe('feature');
    expect(result.trackedIssue).toEqual(enrichedIssue);
  });

  it('resolves free_form with "issue 71" pattern (no hash)', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    const result = await resolver.resolve({
      submission: { kind: 'free_form', body: 'please work on issue 71' },
      project: baseProject,
      tenant: 'tenant_abc'
    });
    expect(result.workKind).toBe('feature');
  });

  it('resolves free_form with "#71" standalone pattern', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    const result = await resolver.resolve({
      submission: { kind: 'free_form', body: 'fix #71' },
      project: baseProject,
      tenant: 'tenant_abc'
    });
    // Work kind comes from the enriched issue labels, not the submission body
    // The enriched issue has labels: ['feature'], so it maps to 'feature'
    expect(result.workKind).toBe('feature');
  });

  it('returns explicit workKind for free_form with no issue reference', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    const result = await resolver.resolve({
      submission: { kind: 'free_form', body: 'Add CSV export', workKind: 'feature' },
      project: baseProject,
      tenant: 'tenant_abc'
    });
    expect(result.workKind).toBe('feature');
    expect(result.trackedIssue).toBeUndefined();
    expect(result.messageBody).toBe('Add CSV export');
  });

  it('refuses free_form with no issue and no workKind', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    await expect(resolver.resolve({
      submission: { kind: 'free_form', body: 'please help me' },
      project: baseProject,
      tenant: 'tenant_abc'
    })).rejects.toMatchObject({ code: 'work_kind_unresolved' });
  });

  it('refuses multiple unique issue numbers', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    await expect(resolver.resolve({
      submission: { kind: 'free_form', body: 'work on issue #71 and issue #72' },
      project: baseProject,
      tenant: 'tenant_abc'
    })).rejects.toMatchObject({ code: 'issue_reference_ambiguous' });
  });

  it('refuses when project has no issueTrackerSetting', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    await expect(resolver.resolve({
      submission: { kind: 'issue_reference', body: 'issue 71', issue: { number: 71 } },
      project: { ...baseProject, issueTrackerSetting: null },
      tenant: 'tenant_abc'
    })).rejects.toMatchObject({ code: 'tracker_not_configured' });
  });

  it('refuses when no adapter found for provider', async () => {
    const registry: IssueTrackerRegistry = { get: vi.fn().mockReturnValue(null) };
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry });
    await expect(resolver.resolve({
      submission: { kind: 'issue_reference', body: 'issue 71', issue: { number: 71 } },
      project: baseProject,
      tenant: 'tenant_abc'
    })).rejects.toMatchObject({ code: 'unsupported_tracker_provider' });
  });

  it('refuses when no issue_tracker credential can be resolved', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    await expect(resolver.resolve({
      submission: { kind: 'issue_reference', body: 'issue 71', issue: { number: 71 } },
      project: { ...baseProject, credentialRefs: [] },
      tenant: 'tenant_abc'
    })).rejects.toMatchObject({ code: 'tracker_credential_missing' });
  });

  // --- Work-kind settlement ---

  it.each<[string[], string, IssueWorkKindDerivation, string?]>([
    [[' ENHANCEMENT ', 'backend'], 'fix: disagrees', { kind: 'enhancement', source: 'label' }],
    [['question'], '  FEAT: add', { kind: 'feature', source: 'title_prefix' }],
    [[], 'FIX: broken', { kind: 'bug', source: 'title_prefix' }],
    [[], '  Chore: tidy', { kind: 'chore', source: 'title_prefix' }],
    [['feature', 'bug'], 'fix: disagrees', { kind: null, source: 'none', reason: 'ambiguous_labels' },
      'Issue has ambiguous work-kind labels: feature, bug.'],
    [[' Feature', 'FEATURE '], 'chore: tidy', { kind: null, source: 'none', reason: 'ambiguous_labels' },
      'Issue has ambiguous work-kind labels: feature, feature.'],
    [[], 'fix this (no literal prefix)', { kind: null, source: 'none', reason: 'no_match' },
      'Issue has no recognized work-kind label or title prefix.']
  ])('derives the same kind for lookup and implicit intake: %j / %s', async (labels, title, workKind, message) => {
    const resolver = new DefaultIssueReferenceIntakeResolver({
      registry: makeRegistry({ ...enrichedIssue, labels, title })
    });
    expect(await resolver.lookup(baseProject, 71)).toEqual({
      issue: { number: 71, title, labels, state: 'open', url: enrichedIssue.url },
      workKind
    });
    if (workKind.kind === null) {
      await expect(resolver.resolve(issueReferenceInput)).rejects.toMatchObject({ code: 'work_kind_unresolved', message });
    } else {
      await expect(resolver.resolve(issueReferenceInput)).resolves.toMatchObject({ workKind: workKind.kind });
    }
  });

  it('checks workflow availability only for implicit intake', async () => {
    const workflowLookup = vi.fn().mockReturnValue(undefined);
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry(), workflowLookup });
    const result = await resolver.lookup(baseProject, 71);
    expect(result.workKind).toEqual({ kind: 'feature', source: 'label' });
    expect(workflowLookup).not.toHaveBeenCalled();
    await expect(resolver.resolve(issueReferenceInput)).rejects.toMatchObject({
      code: 'work_kind_unresolved',
      message: 'No workflow found for work kind: feature.'
    });
    expect(workflowLookup).toHaveBeenCalledWith('feature');
  });

  it.each(issueWorkKindSchema.options)('uses explicit %s despite ambiguity, after sharing the same tracker read as lookup', async workKind => {
    const issue = { ...enrichedIssue, labels: ['feature', 'bug'], state: 'closed' as const };
    const read = vi.fn().mockResolvedValue(issue);
    const workflowLookup = vi.fn();
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: { get: () => ({ read }) }, workflowLookup });
    const credentialRef = { id: 'preferred_credential', purpose: 'issue_tracker' as const };
    const project = { ...baseProject, issueTrackerSetting: { provider: 'github', credentialRef } };
    await resolver.lookup(project, 71);
    expect(await resolver.resolve({
      ...issueReferenceInput, project, submission: { ...issueReferenceInput.submission, workKind }
    })).toEqual({ workKind, trackedIssue: issue, messageBody: issueReferenceInput.submission.body });
    const expectedRead = {
      target: { provider: 'github', repository: { owner: 'markdstafford', name: 'autocatalyst' }, credentialRef },
      issueNumber: 71
    };
    expect(read.mock.calls).toEqual([[expectedRead], [expectedRead]]);
    expect(workflowLookup).not.toHaveBeenCalled();
  });

  // --- Output normalization and safe error wrapping ---

  it('ignores caller-supplied workKind and trackedIssue for free_form issue reference', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry() });
    const result = await resolver.resolve({
      submission: {
        kind: 'free_form',
        body: 'work on issue #71',
        workKind: 'chore',
        trackedIssue: { number: 99, title: 'old', body: '', labels: [], state: 'closed', url: 'https://example.com/99' }
      },
      project: baseProject, tenant: 'tenant_abc'
    });
    // Should use tracker-resolved issue, not the caller-supplied one
    expect(result.trackedIssue?.number).toBe(71);
    expect(result.workKind).toBe('feature'); // from enriched issue labels
  });

  it('still requires a tracker read for explicit intake and retains trusted context for normalization', async () => {
    const registry: IssueTrackerRegistry = {
      get: vi.fn().mockReturnValue({
        read: vi.fn().mockRejectedValue(
          new IssueTrackerError('issue_not_found', 'not found', { safeDetails: { provider: 'github' } })
        )
      })
    };
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry });
    await expect(resolver.resolve({
      ...issueReferenceInput, submission: { ...issueReferenceInput.submission, workKind: 'bug' }
    })).rejects.toMatchObject({
      code: 'tracker_read_failed',
      trackerFailure: {
        error: { code: 'issue_not_found' },
        provider: 'github', repository: 'markdstafford/autocatalyst', issueNumber: 71
      }
    });
  });
});
