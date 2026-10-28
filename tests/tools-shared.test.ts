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

  it('strips each URL/secret-shaped name, whole, as a case segment, or in a single case', () => {
    const stripped = [
      'FilePath',
      'FileUrl',
      'Url',
      'URL',
      'Uri',
      'Src',
      'Source',
      'Link',
      'Href',
      'Token',
      'Secret',
      'Key',
      'AccessKey',
      'SasToken',
      'Signature',
      'DownloadUrl',
      'url',
      'file_path',
      'S3URL',
      // Names a word-segmenter cannot split: one case throughout, or a lowercase
      // second word. A filter that keeps these fails open on a fetch URL.
      'FILEPATH',
      'filepath',
      'Thumbnailurl',
      'TOKENVALUE',
      'srcset',
    ];
    for (const k of stripped) expect(stripUrlishKeys({ [k]: 'x' }), k).toEqual({});
  });

  it('keeps names that carry no URL/secret token at all', () => {
    const kept = { Description: 2, FileName: 3, FileNotExit: 4, Index: 5, Size: 6, Thumbnail: 7 };
    expect(stripUrlishKeys(kept)).toEqual(kept);
  });

  it('errs on the side of stripping: a token inside an ordinary word still drops the key', () => {
    // `Monkey` contains "key". Dropping a harmless field is the accepted cost of
    // never letting a session-authorized URL through on an unsplittable name.
    expect(stripUrlishKeys({ Monkey: 1, Keyboard: 2, Pathway: 3 })).toEqual({});
  });
});
