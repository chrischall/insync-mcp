// Small shared helpers for the read tools: safe coercions for the loosely typed
// portal payloads, and HTML-cell whitespace cleanup for the two reads that come
// back as table fragments. Kept deliberately tiny — anything a single tool needs
// lives beside that tool.

import { toolAnnotations } from '@chrischall/mcp-utils';

/**
 * The annotation every READ tool in this server shares: it reads the live
 * portal and changes nothing. `destructive: false` is passed explicitly so the
 * hint is a BOOLEAN rather than omitted — `destructiveHint` defaults to true
 * for any non-read tool, and a client cannot tell a considered read from one
 * that forgot to say.
 */
export const READ = toolAnnotations({ readOnly: true, destructive: false, openWorld: true });

/** A value as a plain object, or `{}` — never an array, never null. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A value as an array of plain objects, dropping anything that is not one. */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v),
  );
}

/** Whether two id-ish values name the same record, compared as strings. */
export function sameId(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && String(a) === String(b);
}

/**
 * Drop null, undefined and empty-string values so a compact record stays
 * compact. `false` and `0` are kept — they are answers, not absences.
 */
export function tidy(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Collapse a table cell's whitespace runs to single spaces and trim. Callers
 * pass node-html-parser's `.text`, which is ALREADY entity-decoded — decoding
 * again here would turn a practice's literal "&amp;" (sent as `&amp;amp;`) into
 * "&", so this deliberately does whitespace only.
 */
export function cleanCellText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The name segments that mark a key as a URL, path, token or secret. */
const URLISH_SEGMENTS = new Set([
  'path',
  'url',
  'uri',
  'src',
  'source',
  'link',
  'href',
  'token',
  'secret',
  'key',
  'sas',
  'signature',
]);

/**
 * A key name split into its lower-cased words: on `_`/`-`/space, on a
 * lower-or-digit → upper boundary (`FilePath` → file, path), and at the end of
 * an acronym (`AccessKeyID` → access, key, id; `S3URL` → s3, url).
 */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/);
}

/**
 * Drop any key whose NAME looks like a URL, path, token or secret. Used on
 * message-attachment metadata so a session-authorized fetch URL never lands in
 * the transcript — the attachment bytes are the download tools' job, not a
 * read's. A key matches only when one of its WORDS is a URL/secret token, so
 * `DownloadUrl` and `AccessKeyID` go but `Monkey` (which merely contains the
 * letters "key") stays.
 */
export function stripUrlishKeys(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(asRecord(value))) {
    if (!keySegments(k).some((seg) => URLISH_SEGMENTS.has(seg))) out[k] = v;
  }
  return out;
}
