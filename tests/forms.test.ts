import { describe, expect, it } from 'vitest';
import { htmlEscapeText, inputValue, selectOptions } from '../src/forms.js';

// Synthetic markup in the shape the portal's partial views render — no PHI.
const FORM = `
  <input type="hidden" id="todoChildId" value="111" />
  <input type="hidden" id="todoMasterId" value='222' />
  <input type="hidden" id="emailhistory" value="--- From: Front Office &amp; Co &lt;b&gt;hi&lt;/b&gt; &quot;q&quot; &#39;s&#39;" />
  <input type="hidden" id="hdnGroupName" value="" />
  <input type="hidden" id="Fstore" />
  <input type="text" class="x" id="txtSubject" value="Re: Hello" />
  <select class="form-control input-sm sumoselect" id="ddlRefillDrug" multiple="multiple" name="RefillDrugName"><option value="101">Drug A 10mg Tablet</option>
    <option value="102">Drug &amp; B</option></select>
  <select id="ddlEmpty"></select>
`;

describe('inputValue', () => {
  it('reads a value by id, with either quote style', () => {
    expect(inputValue(FORM, 'todoChildId')).toBe('111');
    expect(inputValue(FORM, 'todoMasterId')).toBe('222');
    expect(inputValue(FORM, 'txtSubject')).toBe('Re: Hello');
  });

  it('decodes attribute entities, as jQuery .val() would', () => {
    expect(inputValue(FORM, 'emailhistory')).toBe(`--- From: Front Office & Co <b>hi</b> "q" 's'`);
  });

  it('distinguishes an empty value from a missing input or a missing value', () => {
    expect(inputValue(FORM, 'hdnGroupName')).toBe('');
    expect(inputValue(FORM, 'Fstore')).toBeUndefined();
    expect(inputValue(FORM, 'nope')).toBeUndefined();
  });

  it('does not match an id that merely starts with the one asked for', () => {
    expect(inputValue('<input id="todoChildIdX" value="9">', 'todoChildId')).toBeUndefined();
  });

  it('is not fooled by a data-id / data-value on an unrelated element', () => {
    // `\bid=` used to match inside `data-id=`, and `\bvalue=` inside
    // `data-value=` — jQuery/Bootstrap partials carry data-* attributes freely.
    const html = '<div data-id="todoMasterId" data-value="WRONG"></div><input id="todoMasterId" value="RIGHT">';
    expect(inputValue(html, 'todoMasterId')).toBe('RIGHT');
    expect(inputValue('<input id="x" data-value="WRONG">', 'x')).toBeUndefined();
    expect(inputValue('<input data-id="x" value="WRONG">', 'x')).toBeUndefined();
  });

  it('reads the element carrying the id even when it is not an <input>', () => {
    // jQuery's $('#id').val() reads whatever element has the id; a non-input
    // without a value attribute has no value to give.
    expect(inputValue('<span id="todoChildId">111</span><input name="todoChildId" value="9">', 'todoChildId')).toBeUndefined();
    expect(inputValue('<button id="btn" value="go">Go</button>', 'btn')).toBe('go');
  });
});

describe('selectOptions', () => {
  it('lists value + decoded text of each option', () => {
    expect(selectOptions(FORM, 'ddlRefillDrug')).toEqual([
      { value: '101', text: 'Drug A 10mg Tablet' },
      { value: '102', text: 'Drug & B' },
    ]);
  });

  it('is empty for an empty or missing select', () => {
    expect(selectOptions(FORM, 'ddlEmpty')).toEqual([]);
    expect(selectOptions(FORM, 'nope')).toEqual([]);
  });

  it('is not fooled by a data-id on another select', () => {
    const html =
      '<select data-id="ddl"><option value="1">Wrong</option></select>' +
      '<select id="ddl"><option value="2">Right</option></select>';
    expect(selectOptions(html, 'ddl')).toEqual([{ value: '2', text: 'Right' }]);
  });

  it('is empty when the id belongs to something other than a <select>', () => {
    expect(selectOptions('<div id="ddl"><option value="1">x</option></div>', 'ddl')).toEqual([]);
  });

  it('skips an option without a value attribute (a data-value is not one)', () => {
    const html =
      '<select id="ddl"><option>-- choose --</option><option data-value="9">Fake</option>' +
      '<option value="3"> Three &lt;3mg&gt; </option></select>';
    expect(selectOptions(html, 'ddl')).toEqual([{ value: '3', text: 'Three <3mg>' }]);
  });
});

describe('htmlEscapeText', () => {
  it("re-encodes text the way $('<div>').text(v).html() does", () => {
    expect(htmlEscapeText(`a & <b> "q" 's'`)).toBe(`a &amp; &lt;b&gt; "q" 's'`);
  });
});
