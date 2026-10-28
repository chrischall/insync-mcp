import { describe, expect, it } from 'vitest';
import { SecretScrubber } from '../src/secrets.js';

describe('SecretScrubber', () => {
  it('redacts registered values, raw and JSON-escaped', () => {
    const s = new SecretScrubber();
    s.add('AKIAVERYSECRETKEY', 'bucket-name-xyz');
    expect(s.scrub('key=AKIAVERYSECRETKEY end')).toBe('key=[REDACTED] end');
    expect(s.scrub(JSON.stringify({ b: 'bucket-name-xyz' }))).not.toContain('bucket-name-xyz');
  });

  it('ignores undefined, null and values shorter than three characters', () => {
    const s = new SecretScrubber();
    s.add(undefined, null, '', 'ab', 'abc');
    expect(s.size).toBe(1);
    expect(s.has('abc')).toBe(true);
    expect(s.has('ab')).toBe(false);
  });

  it('is a no-op when nothing is registered', () => {
    const s = new SecretScrubber();
    expect(s.scrub('nothing to hide')).toBe('nothing to hide');
    expect(s.size).toBe(0);
  });
});
