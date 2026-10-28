import { describe, expect, it } from 'vitest';
import { asRecord, asRecordArray, cleanCellText, sameId, stripUrlishKeys } from '../src/tools/_shared.js';

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
  it('decodes common entities and collapses whitespace', () => {
    expect(cleanCellText('  A &amp; B\n  &nbsp; C  ')).toBe('A & B C');
    expect(cleanCellText('&lt;x&gt; &#39;q&#39; &quot;d&quot;')).toBe("<x> 'q' \"d\"");
  });
});

describe('stripUrlishKeys', () => {
  it('drops URL/path/token/key-shaped keys and keeps the rest', () => {
    expect(
      stripUrlishKeys({
        FileName: 'a.pdf',
        FilePath: '/x',
        DownloadUrl: 'http://x',
        AccessKeyID: 'k',
        Token: 't',
        Size: 10,
      }),
    ).toEqual({ FileName: 'a.pdf', Size: 10 });
  });
});
