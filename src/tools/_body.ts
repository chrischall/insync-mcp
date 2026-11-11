// A secure message's body, read from the HTML the practice's editor stored.
// Plain text by default (lines, numbered items and link targets kept), or
// Markdown (emphasis, lists, tables and links with their text). Content the
// sender hid (display:none) is dropped either way: it is a classic place to
// hide instructions.

import { htmlToMarkdown, htmlToText, isRichHtml } from '@chrischall/mcp-utils/rich';

export const BODY_FORMATS = ['text', 'markdown'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** `html` (a message body) as text or Markdown. */
export function readMessageBody(html: string, format: BodyFormat = 'text'): string {
  // A body with no formatting reads the same either way, and as text it keeps
  // the raw line breaks a Markdown (HTML) reading would fold together.
  if (format === 'markdown' && isRichHtml(html)) return htmlToMarkdown(html);
  return htmlToText(html, { paragraphs: true });
}
