import { describe, expect, it } from 'vitest';

import {
  SPEC_EMOJI,
  SPEC_LINKS_PARAGRAPH,
  SPEC_OPEN_QUESTIONS_HEADING,
  SPEC_PASSAGE_A,
  SPEC_PASSAGE_B,
  SPEC_PASSAGE_C,
  SPEC_PASSAGE_D,
  SPEC_REVISION_INSERT,
  SPEC_SAFE_LINK_URL,
  SPEC_UNSAFE_LINK_URL,
  buildFirstSpecBody,
  buildRevisedSpecBody,
  buildSpecBodyForPass
} from './constants.js';
import { buildScriptedSessionEvents, selectScriptedResult } from './scripted-results.js';

function codepointIndex(haystack: string, needle: string): number {
  const chars = Array.from(haystack);
  const needleChars = Array.from(needle);
  for (let i = 0; i <= chars.length - needleChars.length; i += 1) {
    if (chars.slice(i, i + needleChars.length).join('') === needle) {
      return i;
    }
  }
  return -1;
}

describe('scripted spec content', () => {
  const title = 'Fixture spec';

  it('uses an astral (non-BMP) emoji so the offset proof exercises code points vs UTF-16', () => {
    // A rocket (U+1F680) is one code point but two UTF-16 units. If this regressed to a BMP
    // glyph like ✨ (U+2728), passage A's code-point and UTF-16 offsets would coincide and the
    // end-to-end anchor proof would stop testing the distinction it exists to test.
    const firstCodePoint = SPEC_EMOJI.codePointAt(0);
    expect(firstCodePoint).toBeDefined();
    expect(firstCodePoint as number).toBeGreaterThan(0xffff);
  });

  it('first spec includes the table, bullet list, code block, emoji, and passages A-D', () => {
    const body = buildFirstSpecBody(title);
    expect(body).toContain('| Field | Type |');
    expect(body).toContain('- First requirement bullet.');
    expect(body).toContain('```ts');
    expect(body).toContain(`${SPEC_EMOJI} ${SPEC_PASSAGE_A}`);
    expect(body).toContain(SPEC_PASSAGE_B);
    expect(body).toContain(SPEC_PASSAGE_C);
    expect(body).toContain(SPEC_PASSAGE_D);
    expect(body).toContain(SPEC_OPEN_QUESTIONS_HEADING);
    expect(body.trimEnd().endsWith('Pass 1.')).toBe(true);
  });

  it('includes a safe https link and an unsafe-scheme link so link rendering is checkable', () => {
    const first = buildFirstSpecBody(title);
    const revised = buildRevisedSpecBody(title);
    for (const body of [first, revised]) {
      expect(body).toContain(SPEC_LINKS_PARAGRAPH);
      expect(body).toContain(`(${SPEC_SAFE_LINK_URL})`);
      expect(body).toContain(`(${SPEC_UNSAFE_LINK_URL})`);
    }
  });

  it('revision removes passage B and its heading while keeping C and D', () => {
    const body = buildRevisedSpecBody(title);
    expect(body).not.toContain(SPEC_PASSAGE_B);
    expect(body).not.toContain(SPEC_OPEN_QUESTIONS_HEADING);
    expect(body).toContain(SPEC_PASSAGE_C);
    expect(body).toContain(SPEC_PASSAGE_D);
    expect(body).toContain(SPEC_REVISION_INSERT.trimEnd());
  });

  it('revision shifts passage A by the inserted source length in code points and leaves C and D in place', () => {
    const first = buildFirstSpecBody(title);
    const revised = buildRevisedSpecBody(title);
    const insertedLength = Array.from(SPEC_REVISION_INSERT).length;

    expect(codepointIndex(revised, SPEC_PASSAGE_A) - codepointIndex(first, SPEC_PASSAGE_A)).toBe(insertedLength);
    expect(codepointIndex(revised, SPEC_PASSAGE_C)).toBe(codepointIndex(first, SPEC_PASSAGE_C));
    expect(codepointIndex(revised, SPEC_PASSAGE_D)).toBe(codepointIndex(first, SPEC_PASSAGE_D));
  });

  it('later passes change only the final pass-number line', () => {
    const pass3 = buildSpecBodyForPass(title, 3);
    const revised = buildRevisedSpecBody(title);
    expect(pass3).toBe(revised.replace(/Pass 2\.$/u, 'Pass 3.'));
    expect(pass3.trimEnd().endsWith('Pass 3.')).toBe(true);
  });
});

describe('selectScriptedResult', () => {
  it('returns a spec author result for feature spec.author', () => {
    const result = selectScriptedResult({ step: 'spec.author', workKind: 'feature', resultSchemaId: 'autocatalyst.spec_author.v1', issueNumber: 1, specAuthorPass: 1 });
    expect(result['kind']).toBe('feature_spec');
    expect(result['relativePath']).toBe('context-human/specs/feature-fixture-issue-1.md');
  });

  it('returns an enhancement spec author result for enhancement spec.author', () => {
    const result = selectScriptedResult({ step: 'spec.author', workKind: 'enhancement', resultSchemaId: 'autocatalyst.spec_author.v1', issueNumber: 2, specAuthorPass: 1 });
    expect(result['kind']).toBe('enhancement_spec');
    expect(result['relativePath']).toBe('context-human/specs/enhancement-fixture-issue-2.md');
  });

  it('returns a satisfied reviewer result', () => {
    expect(selectScriptedResult({ step: 'implementation.build', workKind: 'feature', role: 'reviewer' })).toEqual({ status: 'satisfied' });
  });

  it('returns an empty implementer dispositions result', () => {
    expect(selectScriptedResult({ step: 'implementation.build', workKind: 'feature', role: 'implementer' })).toEqual({});
  });

  it('returns an advance pr finalize result', () => {
    const result = selectScriptedResult({ step: 'pr.finalize', workKind: 'feature' });
    expect(result['directive']).toBe('advance');
  });

  it('returns a generic advance result for bug spec.author (legacy any contract)', () => {
    expect(selectScriptedResult({ step: 'spec.author', workKind: 'bug', resultSchemaId: 'any', issueNumber: 3 })).toEqual({ directive: 'advance' });
  });
});

describe('buildScriptedSessionEvents', () => {
  it('emits a structured result event for structured captures', () => {
    const events = buildScriptedSessionEvents({ step: 'implementation.build', workKind: 'feature', role: 'reviewer', resultSchemaId: 'autocatalyst.reviewer_result.v1' });
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent?.structuredOutput).toEqual({ status: 'satisfied' });
  });

  it('emits a legacy result.output event for the any contract', () => {
    const events = buildScriptedSessionEvents({ step: 'spec.author', workKind: 'bug', resultSchemaId: 'any', issueNumber: 3 });
    const resultEvent = events.find((event) => event.type === 'result');
    expect(resultEvent?.structuredOutput).toBeUndefined();
    expect(JSON.parse(resultEvent?.result?.output ?? '{}')).toEqual({ directive: 'advance' });
  });
});
