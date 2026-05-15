import { describe, expect, it } from 'vitest';
import { extractIssueReference, buildEnrichedClassificationMessage } from '../../src/core/issue-reference.js';
import type { TrackedIssue } from '../../src/types/issue-tracker.js';

describe('extractIssueReference', () => {
  it("extracts issue number from \"let's work on issue 42\"", () => {
    const result = extractIssueReference("let's work on issue 42");
    expect(result).toEqual({ number: 42, raw: 'issue 42' });
  });

  it('extracts from "please pick up issue #42"', () => {
    const result = extractIssueReference('please pick up issue #42');
    expect(result).toEqual({ number: 42, raw: 'issue #42' });
  });

  it('extracts from standalone "#42" token', () => {
    const result = extractIssueReference('work on #42');
    expect(result).toEqual({ number: 42, raw: '#42' });
  });

  it('extracts from "GH-42"', () => {
    const result = extractIssueReference('pick up GH-42');
    expect(result).toEqual({ number: 42, raw: 'GH-42' });
  });

  it('is case-insensitive for "issue" prefix', () => {
    const result = extractIssueReference('Work on ISSUE 99');
    expect(result).toEqual({ number: 99, raw: 'ISSUE 99' });
  });

  it('returns undefined when no issue reference present', () => {
    expect(extractIssueReference('add a setup wizard')).toBeUndefined();
  });

  it('returns undefined for issue 0', () => {
    expect(extractIssueReference('issue 0')).toBeUndefined();
  });

  it('returns undefined for negative numbers', () => {
    expect(extractIssueReference('issue -5')).toBeUndefined();
  });

  it('returns the first reference when multiple are present', () => {
    const result = extractIssueReference('work on issue 10 and issue 20');
    expect(result?.number).toBe(10);
  });

  it('returns undefined for messages with no valid issue number', () => {
    expect(extractIssueReference('no issue here')).toBeUndefined();
  });
});

describe('buildEnrichedClassificationMessage', () => {
  const mockIssue: TrackedIssue = {
    number: 42,
    title: "Intent classifier misidentifies \"let's work on issue N\"",
    body: 'Steps to reproduce...',
    labels: ['bug', 'P2: medium'],
    state: 'OPEN',
    url: 'https://github.com/org/repo/issues/42',
  };

  it('includes the original user request', () => {
    const msg = buildEnrichedClassificationMessage("let's work on issue 42", mockIssue);
    expect(msg).toContain("let's work on issue 42");
  });

  it('includes the issue number, state, labels, and title', () => {
    const msg = buildEnrichedClassificationMessage("let's work on issue 42", mockIssue);
    expect(msg).toContain('42');
    expect(msg).toContain('OPEN');
    expect(msg).toContain('bug');
    expect(msg).toContain('P2: medium');
    expect(msg).toContain('Intent classifier misidentifies');
  });

  it('includes the issue body', () => {
    const msg = buildEnrichedClassificationMessage("let's work on issue 42", mockIssue);
    expect(msg).toContain('Steps to reproduce...');
  });

  it('includes an instruction not to classify as issue filing', () => {
    const msg = buildEnrichedClassificationMessage("let's work on issue 42", mockIssue);
    expect(msg.toLowerCase()).toContain('issue filing');
  });
});
