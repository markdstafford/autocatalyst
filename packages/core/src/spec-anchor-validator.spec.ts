import { describe, expect, it } from 'vitest';

import type { FeedbackAnchor } from '@autocatalyst/api-contract';

import { SpecAnchorValidationError, validateSpecAnchor } from './spec-anchor-validator.js';

const markdown = '# Scope\n\nThe scope section is ambiguous.';

function artifactRange(partial: Partial<Extract<FeedbackAnchor, { kind: 'artifact_range' }>>): FeedbackAnchor {
  return {
    kind: 'artifact_range',
    artifactId: 'art_1',
    from: 2,
    to: 7,
    quotedText: 'Scope',
    ...partial
  } as FeedbackAnchor;
}

function reason(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpecAnchorValidationError) return error.reason;
    throw error;
  }
  throw new Error('Expected validateSpecAnchor to throw.');
}

describe('validateSpecAnchor', () => {
  const currentSpec = { artifactId: 'art_1', markdown };

  it('accepts an anchor whose offsets reproduce the quote', () => {
    expect(() => validateSpecAnchor({ anchor: artifactRange({ from: 2, to: 7, quotedText: 'Scope' }), currentSpec })).not.toThrow();
  });

  it('rejects a non-artifact_range anchor as wrong_kind', () => {
    expect(reason(() => validateSpecAnchor({ anchor: { kind: 'artifact', artifactId: 'art_1' }, currentSpec }))).toBe('wrong_kind');
    expect(reason(() => validateSpecAnchor({ anchor: { kind: 'file_range', path: 'spec.md', startLine: 1, endLine: 2 }, currentSpec }))).toBe('wrong_kind');
  });

  it('rejects an anchor targeting another artifact as wrong_artifact', () => {
    expect(reason(() => validateSpecAnchor({ anchor: artifactRange({ artifactId: 'art_other' }), currentSpec }))).toBe('wrong_artifact');
  });

  it('rejects an anchor with no quotedText as missing_quoted_text', () => {
    expect(reason(() => validateSpecAnchor({ anchor: artifactRange({ quotedText: undefined }), currentSpec }))).toBe('missing_quoted_text');
  });

  it('rejects out-of-range offsets', () => {
    expect(reason(() => validateSpecAnchor({ anchor: artifactRange({ from: 0, to: 9999, quotedText: 'Scope' }), currentSpec }))).toBe('out_of_range');
  });

  it('rejects offsets whose slice does not reproduce quotedText as text_mismatch', () => {
    expect(reason(() => validateSpecAnchor({ anchor: artifactRange({ from: 0, to: 1, quotedText: 'Scope' }), currentSpec }))).toBe('text_mismatch');
  });

  it('counts offsets in Unicode code points, not UTF-16 code units (emoji guard)', () => {
    // '🙂' is a single code point but two UTF-16 code units. 'Hello' begins at code point index 2.
    const emojiSpec = { artifactId: 'art_1', markdown: '🙂 Hello World' };
    expect(() => validateSpecAnchor({
      anchor: artifactRange({ from: 2, to: 7, quotedText: 'Hello' }),
      currentSpec: emojiSpec
    })).not.toThrow();
    // Using UTF-16 offsets (3..8) would misalign and fail with text_mismatch.
    expect(reason(() => validateSpecAnchor({
      anchor: artifactRange({ from: 3, to: 8, quotedText: 'Hello' }),
      currentSpec: emojiSpec
    }))).toBe('text_mismatch');
  });
});
