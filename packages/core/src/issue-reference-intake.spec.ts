import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@autocatalyst/api-contract';
import { DefaultIssueReferenceIntakeResolver, IssueReferenceIntakeError } from './issue-reference-intake.js';
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

  it('settles feature from feature label', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry({ ...enrichedIssue, labels: ['feature'], title: 'no prefix here' }) });
    const result = await resolver.resolve({
      submission: { kind: 'issue_reference', body: 'issue', issue: { number: 71 } },
      project: baseProject, tenant: 'tenant_abc'
    });
    expect(result.workKind).toBe('feature');
  });

  it('settles bug from fix: title prefix when no work-kind label', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry({ ...enrichedIssue, labels: [], title: 'fix: broken thing' }) });
    const result = await resolver.resolve({
      submission: { kind: 'issue_reference', body: 'issue', issue: { number: 71 } },
      project: baseProject, tenant: 'tenant_abc'
    });
    expect(result.workKind).toBe('bug');
  });

  it('refuses ambiguous labels', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry({ ...enrichedIssue, labels: ['feature', 'bug'] }) });
    await expect(resolver.resolve({
      submission: { kind: 'issue_reference', body: 'issue', issue: { number: 71 } },
      project: baseProject, tenant: 'tenant_abc'
    })).rejects.toMatchObject({ code: 'work_kind_unresolved' });
  });

  it('refuses when no work-kind cue found', async () => {
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry: makeRegistry({ ...enrichedIssue, labels: [], title: 'some random title' }) });
    await expect(resolver.resolve({
      submission: { kind: 'issue_reference', body: 'issue', issue: { number: 71 } },
      project: baseProject, tenant: 'tenant_abc'
    })).rejects.toMatchObject({ code: 'work_kind_unresolved' });
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

  it('wraps IssueTrackerError as tracker_read_failed with safe details', async () => {
    const registry: IssueTrackerRegistry = {
      get: vi.fn().mockReturnValue({
        read: vi.fn().mockRejectedValue(
          new IssueTrackerError('issue_not_found', 'not found', { safeDetails: { provider: 'github' } })
        )
      })
    };
    const resolver = new DefaultIssueReferenceIntakeResolver({ registry });
    try {
      await resolver.resolve({
        submission: { kind: 'issue_reference', body: 'issue', issue: { number: 71 } },
        project: baseProject, tenant: 'tenant_abc'
      });
      expect.fail('should throw');
    } catch (e: unknown) {
      const err = e as IssueReferenceIntakeError;
      expect(err.code).toBe('tracker_read_failed');
      expect(err.safeDetails?.trackerCode).toBe('issue_not_found');
    }
  });
});
