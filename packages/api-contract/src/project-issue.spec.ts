import { describe, expect, it } from 'vitest';

import {
  intakeRoutingErrorDetailsSchema,
  intakeRoutingErrorResponseSchema,
  issueReferenceSubmissionSchema,
  projectIssueLookupResponseSchema,
  projectIssueNotFoundResponseSchema,
  projectIssueParamsSchema
} from './index.js';

const issue = { number: 27, title: 'A closed issue', url: 'https://example.test/issues/27', labels: [], state: 'closed' };

describe('project issue lookup contract', () => {
  it.each([['27', 27], ['00027', 27], ['9007199254740991', Number.MAX_SAFE_INTEGER]])('parses %s as decimal', (raw, number) => {
    expect(projectIssueParamsSchema.parse({ id: 'project', number: raw })).toEqual({ id: 'project', number });
  });

  it.each(['', '0', '-1', '+1', '1.5', '1e2', 'abc', '0x10', ' 27 ', '27\n', '9007199254740992'])('rejects path number %j', raw => {
    expect(projectIssueParamsSchema.safeParse({ id: 'project', number: raw }).success).toBe(false);
  });

  it('requires a non-empty project ID', () => {
    expect(projectIssueParamsSchema.safeParse({ id: '', number: '27' }).success).toBe(false);
  });

  it.each([
    { kind: 'enhancement', source: 'label' },
    { kind: 'bug', source: 'title_prefix' },
    { kind: null, source: 'none', reason: 'no_match' },
    { kind: null, source: 'none', reason: 'ambiguous_labels' }
  ])('accepts a strict summary and %j derivation', workKind => {
    expect(projectIssueLookupResponseSchema.parse({ issue, workKind })).toEqual({ issue, workKind });
  });

  it.each([
    { kind: 'feature', source: 'label', reason: 'no_match' },
    { kind: 'feature', source: 'none' },
    { kind: 'question', source: 'title_prefix' },
    { kind: null, source: 'label' },
    { kind: null, source: 'none' },
    { kind: null, source: 'none', reason: 'other', matchedLabels: ['bug'] }
  ])('rejects inconsistent derivation %j', workKind => {
    expect(projectIssueLookupResponseSchema.safeParse({ issue, workKind }).success).toBe(false);
  });

  it('requires all summary fields and rejects body and extra fields', () => {
    const workKind = { kind: null, source: 'none', reason: 'no_match' };
    for (const key of Object.keys(issue)) {
      const incomplete = Object.fromEntries(Object.entries(issue).filter(([name]) => name !== key));
      expect(projectIssueLookupResponseSchema.safeParse({ issue: incomplete, workKind }).success).toBe(false);
    }
    expect(projectIssueLookupResponseSchema.safeParse({ issue: { ...issue, body: 'private' }, workKind }).success).toBe(false);
    expect(projectIssueLookupResponseSchema.safeParse({ issue, workKind, extra: true }).success).toBe(false);
  });
});

describe('issue-reference workKind', () => {
  const submission = { kind: 'issue_reference', body: 'Read #27', issue: { number: 27 } };
  it('accepts omission and the four issue kinds', () => {
    expect(issueReferenceSubmissionSchema.parse(submission)).toEqual(submission);
    for (const workKind of ['feature', 'enhancement', 'bug', 'chore']) {
      expect(issueReferenceSubmissionSchema.parse({ ...submission, workKind }).workKind).toBe(workKind);
    }
  });

  it.each([null, 'question', 'file_issue', 'unknown'])('rejects %j', workKind => {
    expect(issueReferenceSubmissionSchema.safeParse({ ...submission, workKind }).success).toBe(false);
  });
});

describe('intake error details', () => {
  it('accepts resolver and typed adapter errors in the shared envelope', () => {
    for (const details of [
      { code: 'tracker_credential_missing' },
      { code: 'tracker_read_failed' },
      { code: 'tracker_auth_failed', trackerCode: 'tracker_auth_failed', provider: 'github', repository: 'acme/demo', issueNumber: 27 }
    ]) {
      const response = { error: { code: 'intake_routing_error', message: 'Issue read failed.', details } };
      expect(intakeRoutingErrorResponseSchema.parse(response)).toEqual(response);
    }
    expect(intakeRoutingErrorResponseSchema.safeParse({ error: { code: 'intake_routing_error', message: 'error' } }).success).toBe(false);
  });

  it.each([
    {},
    { code: 'other' },
    { code: 'tracker_read_failed', provider: 'github' },
    { code: 'tracker_auth_failed' },
    { code: 'tracker_auth_failed', trackerCode: 'tracker_credential_missing' },
    { code: 'tracker_auth_failed', trackerCode: 'tracker_auth_failed', rawOutput: 'private' },
    { code: 'tracker_auth_failed', trackerCode: 'tracker_auth_failed', issueNumber: '27' },
    { code: 'work_kind_unresolved', reason: 'no_match' }
  ])('rejects invalid details %j', details => {
    expect(intakeRoutingErrorDetailsSchema.safeParse(details).success).toBe(false);
  });

  it('limits lookup 404 details to project or issue without tracker metadata', () => {
    const error = { code: 'not_found', message: 'Not found.' };
    for (const resource of ['project', 'issue']) {
      expect(projectIssueNotFoundResponseSchema.safeParse({ error: { ...error, details: { resource } } }).success).toBe(true);
    }
    expect(projectIssueNotFoundResponseSchema.safeParse({
      error: { ...error, details: { resource: 'issue', trackerCode: 'issue_not_found' } }
    }).success).toBe(false);
  });
});
