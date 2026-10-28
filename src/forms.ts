// Reading the portal's server-rendered form partials. The write flows (reply,
// refill, cancel) take their hidden ids and option lists from HTML the portal
// renders into a modal, exactly as the portal's own jQuery reads them with
// `$('#id').val()` — so these helpers read by element id and decode attribute
// entities the way a browser would.

import { decodeHtmlEntities } from '@chrischall/mcp-utils/scrape';

/** Escape a string for a regex. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `value` attribute of the element with `id`, entity-decoded — or
 * `undefined` when there is no such element or it carries no value. An empty
 * `value=""` is `''`, which callers treat as a real (empty) answer.
 */
export function inputValue(html: string, id: string): string | undefined {
  const tag = new RegExp(`<[a-z]+\\b[^>]*\\bid=["']${escapeRe(id)}["'][^>]*>`, 'i').exec(html)?.[0];
  if (tag === undefined) return undefined;
  const value = /\bvalue=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  if (value === null) return undefined;
  // Exactly one of the two quote-style groups matched.
  return decodeHtmlEntities(value[1] ?? (value[2] as string));
}

/** The `<option>`s of the `<select>` with `id`: value + decoded, trimmed text. */
export function selectOptions(html: string, id: string): { value: string; text: string }[] {
  const body = new RegExp(
    `<select\\b[^>]*\\bid=["']${escapeRe(id)}["'][^>]*>([\\s\\S]*?)</select>`,
    'i',
  ).exec(html)?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(/<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*>([^<]*)/gi)].map((m) => ({
    value: m[1]!,
    text: decodeHtmlEntities(m[2]!).trim(),
  }));
}

/**
 * Re-encode text the way the portal's `$('<div>').text(v).html()` does before
 * it posts a reply's quoted history: `&`, `<` and `>` only (jQuery's `.html()`
 * leaves quotes alone in text content).
 */
export function htmlEscapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
