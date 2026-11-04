// The `view` vocabulary every read tool in this server honours
// (`@chrischall/mcp-utils`' `view`; chrischall/workflows `docs/fleet-conventions.md`,
// "Response shape"). compact is the default and the cheap rung.
//
// Two kits, because the portal's reads split cleanly in two:
//
//   * PASS-THROUGH reads hand back one endpoint's payload, so `raw` can mean
//     "the portal payload untouched" and is worth offering.
//   * ASSEMBLED reads are STITCHED here — parsed out of an HTML fragment, or
//     built from a handful of fields — so there is no untouched upstream object
//     to show and `raw` would alias `full`. Those offer compact + full only.
//
// A third shape, {@link untrustedViewResponse}, is for reads carrying
// practice-authored free text (message subjects/bodies, form and survey names):
// same rung handling, but the result is wrapped in the untrusted-data envelope
// so the model is told the text is data, never instructions.

import {
  UNTRUSTED_CONTENT_RULE,
  createViewKit,
  projectOrRaw,
  resolveView,
  untrustedEnvelope,
  viewResult,
  type View,
} from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';

const LABEL = 'insync-mcp';

const PASSTHROUGH_NOTE =
  'compact projects each record to the fields a caller acts on; "full" keeps every field ' +
  'this server understands; "raw" returns the portal payload untouched.';

const ASSEMBLED_NOTE =
  'compact projects each record to the fields a caller acts on; "full" keeps every field ' +
  'this server understands. (No "raw": the record is assembled here, not passed through from ' +
  'one endpoint.)';

const passthrough = createViewKit(['compact', 'full', 'raw'], { note: PASSTHROUGH_NOTE, label: LABEL });
const assembled = createViewKit(['compact', 'full'], { note: ASSEMBLED_NOTE, label: LABEL });

/** The `view` argument + responder for a pass-through read (compact/full/raw). */
export const viewArg = passthrough.viewArg;
export const viewResponse = passthrough.viewResponse;
export const PASSTHROUGH_VIEWS = passthrough.views;

/** The `view` argument + responder for an assembled read (compact/full). */
export const assembledViewArg = assembled.viewArg;
export const assembledViewResponse = assembled.viewResponse;
export const ASSEMBLED_VIEWS = assembled.views;

/** A tool's own compact-rung field projection. */
export type Projector = (data: unknown) => unknown;

/**
 * Answer a read whose payload carries practice-authored free text. The rung is
 * honoured exactly as {@link viewResponse} honours it (compact projects, full
 * and raw pass through; compact/full minified, raw indented), but the result is
 * first wrapped in the untrusted-data envelope — markers lead, so they precede
 * any third-party text in the serialised result.
 */
export function untrustedViewResponse(opts: {
  view: string | undefined;
  views: readonly View[];
  data: unknown;
  project?: Projector;
  /** Who authored the text, e.g. "Message subjects and bodies are written by your practice." */
  whoWrote: string;
  /** Which call produced `data`, for the stderr line on a projection fallback. */
  context: string;
}): CallToolResult {
  const rung = resolveView(opts.view, opts.views);
  const payload =
    rung === 'compact' && opts.project !== undefined
      ? projectOrRaw(opts.data, opts.project, { label: LABEL, context: opts.context })
      : opts.data;
  return viewResult(rung, untrustedEnvelope(payload, { note: `${opts.whoWrote} ${UNTRUSTED_CONTENT_RULE}` }));
}

// ── view "brief" (the mcp-host context-groups contract) ─────────────────────
//
// A canonical read answers one line per item, at most 120 chars:
// `title — <ISO date | no date> — <status>`. The lines carry practice-authored
// text, so they go inside the untrusted-data envelope as `data: string[]`. A
// line starting with `-- ` is a NOTE, not an item: `-- none` for an empty
// result, `-- N of M shown` / `-- more` for a partial page.

const BRIEF_MAX = 120;
/** The shortest a title is cut to before the status gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s);

/**
 * One brief line, cut to ≤ 120 chars as a WHOLE, title first: the title
 * shortens until the line fits, and only once it is at its floor does the
 * status give way too. A title starting with `-- ` or `\` is escaped with one
 * leading `\`, so a practice-written subject can never read as a note (the
 * gateway strips that one backslash after its note check).
 */
export function briefLine(rawTitle: string, date: string, status: string): string {
  const title = rawTitle.startsWith('-- ') || rawTitle.startsWith('\\') ? `\\${rawTitle}` : rawTitle;
  const tidyStatus = status.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown';
  const sep = ` — ${date} — `;
  const room = BRIEF_MAX - sep.length;
  if (title.length + tidyStatus.length <= room) return `${title}${sep}${tidyStatus}`;
  const shown = cut(title, Math.max(room - tidyStatus.length, Math.min(title.length, TITLE_FLOOR)));
  return `${shown}${sep}${cut(tidyStatus, room - shown.length)}`;
}

const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.*))?$/;
const HM = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i;

/**
 * The portal's `MM/DD/YYYY` (optionally with a `hh:mm AM` time, inline or as
 * `time`) as an ISO date or `YYYY-MM-DDTHH:MM` local time; anything else is
 * `no date`.
 */
export function mdyToIso(text: unknown, time?: unknown): string {
  const m = typeof text === 'string' ? MDY.exec(text.trim()) : null;
  if (m === null) return 'no date';
  const date = `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  const t = HM.exec(typeof time === 'string' ? time.trim() : (m[4] ?? '').trim());
  if (t === null) return date;
  const hour = (Number(t[1]) % 12) + (t[3]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${date}T${String(hour).padStart(2, '0')}:${t[2]}`;
}

/**
 * The note lines a brief answer ends with: `-- none` when there are no items,
 * `-- N of M shown` when the portal's total says more exist, `-- more` when the
 * total is unknown but the page came back full.
 */
export function briefNotes(shown: number, total: unknown, pageSize: number): string[] {
  if (shown === 0) return ['-- none'];
  const all = Number(total);
  if (total !== undefined && total !== null && total !== '' && Number.isFinite(all)) {
    return all > shown ? [`-- ${shown} of ${all} shown`] : [];
  }
  return shown >= pageSize ? ['-- more'] : [];
}

/** Answer brief lines inside the untrusted-data envelope, minified. */
export function untrustedBriefResponse(lines: string[], whoWrote: string): CallToolResult {
  const payload = untrustedEnvelope(lines, { note: `${whoWrote} ${UNTRUSTED_CONTENT_RULE}` });
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
