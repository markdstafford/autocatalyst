import { describe, expect, it } from 'vitest';

import {
  codePointLength,
  codePointOffsetToUtf16Index,
  sliceByCodePoints,
  utf16IndexToCodePointOffset
} from './code-points.js';

// Representative characters across the Unicode planes the mapping matrix cares about.
const BMP = 'A. Names must be unique within a tenant.';
const ASTRAL = '🚀'; // U+1F680, one code point, two UTF-16 units
const MATH = '𝐀'; // U+1D400 MATHEMATICAL BOLD CAPITAL A, astral
const FLAG = '🇺🇸'; // two regional indicator code points, four UTF-16 units

describe('codePointLength', () => {
  it('counts BMP characters one-for-one', () => {
    expect(codePointLength(BMP)).toBe(BMP.length);
  });

  it('counts an astral emoji as a single code point', () => {
    expect(codePointLength(ASTRAL)).toBe(1);
    expect(ASTRAL.length).toBe(2);
  });

  it('counts a mathematical letter as a single code point', () => {
    expect(codePointLength(MATH)).toBe(1);
  });

  it('counts a flag as two regional-indicator code points', () => {
    expect(codePointLength(FLAG)).toBe(2);
    expect(FLAG.length).toBe(4);
  });

  it('counts CRLF as two code points and a tab as one', () => {
    expect(codePointLength('\r\n')).toBe(2);
    expect(codePointLength('\t')).toBe(1);
  });

  it('is empty for the empty string', () => {
    expect(codePointLength('')).toBe(0);
  });
});

describe('sliceByCodePoints', () => {
  it('slices BMP text like String.prototype.slice', () => {
    expect(sliceByCodePoints(BMP, 0, 2)).toBe('A.');
  });

  it('never splits a surrogate pair', () => {
    const text = `${ASTRAL} ${BMP}`;
    // Code point 0 is the rocket; slicing [1, ...) drops exactly the rocket, not half of it.
    expect(sliceByCodePoints(text, 0, 1)).toBe(ASTRAL);
    expect(sliceByCodePoints(text, 1, 2)).toBe(' ');
    expect(sliceByCodePoints(text, 2, 2 + 2)).toBe('A.');
  });

  it('slices flags without cutting a regional indicator in half', () => {
    expect(sliceByCodePoints(FLAG, 0, 1)).toBe('🇺');
    expect(sliceByCodePoints(FLAG, 1, 2)).toBe('🇸');
  });

  it('clamps out-of-range offsets and returns empty when from >= to', () => {
    expect(sliceByCodePoints(BMP, -5, 2)).toBe('A.');
    expect(sliceByCodePoints(BMP, 0, 10_000)).toBe(BMP);
    expect(sliceByCodePoints(BMP, 3, 3)).toBe('');
    expect(sliceByCodePoints(BMP, 5, 2)).toBe('');
  });
});

describe('utf16IndexToCodePointOffset', () => {
  it('is the identity for pure BMP text', () => {
    expect(utf16IndexToCodePointOffset(BMP, 0)).toBe(0);
    expect(utf16IndexToCodePointOffset(BMP, 5)).toBe(5);
    expect(utf16IndexToCodePointOffset(BMP, BMP.length)).toBe(BMP.length);
  });

  it('counts an astral emoji as one code point', () => {
    const text = `${ASTRAL} x`;
    expect(utf16IndexToCodePointOffset(text, 0)).toBe(0);
    // UTF-16 index 2 is just after the rocket's surrogate pair.
    expect(utf16IndexToCodePointOffset(text, 2)).toBe(1);
    expect(utf16IndexToCodePointOffset(text, 3)).toBe(2);
  });

  it('rounds a mid-surrogate index down to the boundary before the pair', () => {
    const text = ASTRAL;
    // UTF-16 index 1 is between the high and low surrogate halves.
    expect(utf16IndexToCodePointOffset(text, 1)).toBe(0);
    expect(utf16IndexToCodePointOffset(text, 2)).toBe(1);
  });

  it('clamps indexes outside the string', () => {
    expect(utf16IndexToCodePointOffset(BMP, -3)).toBe(0);
    expect(utf16IndexToCodePointOffset(BMP, BMP.length + 10)).toBe(BMP.length);
  });
});

describe('codePointOffsetToUtf16Index', () => {
  it('is the identity for pure BMP text', () => {
    expect(codePointOffsetToUtf16Index(BMP, 0)).toBe(0);
    expect(codePointOffsetToUtf16Index(BMP, 5)).toBe(5);
  });

  it('expands astral code points to two UTF-16 units', () => {
    const text = `${ASTRAL} x`;
    expect(codePointOffsetToUtf16Index(text, 0)).toBe(0);
    expect(codePointOffsetToUtf16Index(text, 1)).toBe(2);
    expect(codePointOffsetToUtf16Index(text, 2)).toBe(3);
  });

  it('round-trips with utf16IndexToCodePointOffset across mixed text', () => {
    const text = `${ASTRAL} ${MATH}\t${FLAG}\r\nend`;
    const total = codePointLength(text);
    for (let offset = 0; offset <= total; offset += 1) {
      const utf16 = codePointOffsetToUtf16Index(text, offset);
      expect(utf16IndexToCodePointOffset(text, utf16)).toBe(offset);
    }
  });

  it('clamps offsets outside the string', () => {
    expect(codePointOffsetToUtf16Index(BMP, -1)).toBe(0);
    expect(codePointOffsetToUtf16Index(ASTRAL, 99)).toBe(ASTRAL.length);
  });
});
