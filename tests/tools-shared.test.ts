import { describe, expect, it } from 'vitest';
import { asRecord, asRecordArray, cleanCellText, sameId } from '../src/tools/_shared.js';

describe('asRecord', () => {
  it('returns a plain object as-is and anything else as {}', () => {
    const o = { a: 1 };
    expect(asRecord(o)).toBe(o);
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
    expect(asRecord('x')).toEqual({});
  });
});

describe('asRecordArray', () => {
  it('keeps only the plain-object elements', () => {
    expect(asRecordArray([{ a: 1 }, 2, null, ['x'], { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(asRecordArray('nope')).toEqual([]);
  });
});

describe('sameId', () => {
  it('compares as strings and rejects null/undefined', () => {
    expect(sameId(5, '5')).toBe(true);
    expect(sameId('A', 'A')).toBe(true);
    expect(sameId(undefined, 'A')).toBe(false);
    expect(sameId(null, 'A')).toBe(false);
    expect(sameId('A', 'B')).toBe(false);
  });
});

describe('cleanCellText', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(cleanCellText('  A & B\n  \u00a0 C  ')).toBe('A & B C');
    expect(cleanCellText('\t\n')).toBe('');
  });

  it('leaves entity-looking text alone — the parser has already decoded the cell', () => {
    // Both callers pass node-html-parser's `.text`, which is decoded once. A
    // literal "&amp;" surviving in that text was "&amp;amp;" in the HTML, so
    // decoding it again would corrupt what the practice actually wrote.
    expect(cleanCellText('a &amp; b')).toBe('a &amp; b');
  });
});
