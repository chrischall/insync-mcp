// Reading the portal's server-rendered form partials. The write flows (reply,
// refill, cancel) take their hidden ids and option lists from HTML the portal
// renders into a modal, exactly as the portal's own jQuery reads them with
// `$('#id').val()` — so these helpers parse the partial with a real HTML parser
// (node-html-parser), look the element up by id, and let the parser decode
// attribute entities and text the way a browser would. A parser, not a regex:
// the partials are jQuery/Bootstrap-era and full of `data-*` attributes, and a
// `\bid=` / `\bvalue=` regex matches inside `data-id=` / `data-value=`.

import { parse } from 'node-html-parser';

/**
 * The `value` attribute of the element with `id`, entity-decoded — or
 * `undefined` when there is no such element or it carries no value. An empty
 * `value=""` is `''`, which callers treat as a real (empty) answer.
 */
export function inputValue(html: string, id: string): string | undefined {
  return parse(html).getElementById(id)?.getAttribute('value');
}

/** The `<option>`s of the `<select>` with `id`: value + decoded, trimmed text. */
export function selectOptions(html: string, id: string): { value: string; text: string }[] {
  const select = parse(html).getElementById(id);
  if (select?.tagName !== 'SELECT') return [];
  return select.querySelectorAll('option').flatMap((option) => {
    const value = option.getAttribute('value');
    // An option with no value attribute is a placeholder ("-- choose --"),
    // never a real choice — skip it, as the regex reader always did.
    return value === undefined ? [] : [{ value, text: option.text.trim() }];
  });
}

/**
 * Re-encode text the way the portal's `$('<div>').text(v).html()` does before
 * it posts a reply's quoted history: `&`, `<` and `>` only (jQuery's `.html()`
 * leaves quotes alone in text content).
 */
export function htmlEscapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
