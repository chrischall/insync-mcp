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
