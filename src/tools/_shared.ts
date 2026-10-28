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

/** The words that mark a key name as a URL, path, token or secret. */
const URLISH = /path|url|uri|src|source|link|href|token|secret|key|sas|signature/i;

/**
 * Drop any key whose NAME looks like a URL, path, token or secret. Used on
 * message-attachment metadata so a session-authorized fetch URL never lands in
 * the transcript — the attachment bytes are the download tools' job, not a
 * read's.
 *
 * Deliberately a SUBSTRING match, not a word match. Splitting a name into
 * words reads `DownloadUrl` and `AccessKeyID` fine but has nothing to split in
 * `FILEPATH`, `filepath` or `Thumbnailurl`, and a filter that keeps those
 * fails open on exactly the thing it exists to hide. The cost is that an
 * ordinary word containing a token (`Monkey`) is dropped too, which is harmless.
 */
export function stripUrlishKeys(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(asRecord(value))) {
    if (!URLISH.test(k)) out[k] = v;
  }
  return out;
}
