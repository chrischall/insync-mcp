import { describe, expect, it } from 'vitest';
import {
  parseSurveyRows,
  registerDocumentTools,
  sanitizeFormRecord,
} from '../src/tools/documents.js';
import { capture, jsonOf, okJson, okText, textOf, type FakeCall } from './_tools.js';

function rig(responder: (c: FakeCall) => ReturnType<typeof okJson>) {
  const { handlers, transport } = capture(registerDocumentTools, responder);
  return { get: (name: string) => handlers.get(name)!, transport };
}

const FORMS = {
  PatientFormcollection: [
    {
      FormName: 'Intake Questionnaire',
      Status: 'Sent',
      SentOn: '10/01/2026',
      ReceivedOn: '',
      LastSubmittedOn: '',
      SubPatientFormID: 'F1',
      TemplateID: 'T1',
      PatientUserPassword: 'HASHVALUE',
      PatientUserName: 'patexample',
      TemplateHTML: '<html>secret</html>',
      PlainHTML: 'secret',
      TemplateScript: 'alert(1)',
      InsyncSiteURl: 'https://example.insynchcs.com/token',
    },
    { FormName: 'Consent', Status: 'Received', SubPatientFormID: 'F2', TemplateID: 'T2' },
  ],
};

describe('sanitizeFormRecord', () => {
  it('drops every credential/markup field and keeps the rest', () => {
    const out = sanitizeFormRecord(FORMS.PatientFormcollection[0]!);
    expect(out).toMatchObject({ FormName: 'Intake Questionnaire', Status: 'Sent', SubPatientFormID: 'F1' });
    for (const k of [
      'PatientUserPassword',
      'PatientUserName',
      'TemplateHTML',
      'PlainHTML',
      'TemplateScript',
      'InsyncSiteURl',
    ]) {
      expect(out).not.toHaveProperty(k);
    }
  });
});

describe('insync_list_forms', () => {
  it('lists only pending (Status "Sent") and never leaks secrets', async () => {
    const { get } = rig(() => okJson(FORMS));
    const res = await get('insync_list_forms')({ status: 'pending' });
    const out = jsonOf(res);
    expect(out.untrusted_content).toBe(true);
    const forms = out.data as Record<string, unknown>[];
    expect(forms).toHaveLength(1);
    expect(forms[0]).toEqual({ name: 'Intake Questionnaire', status: 'Sent', sentOn: '10/01/2026', formId: 'F1', templateId: 'T1' });
    expect(res.content[0]!.text).not.toContain('HASHVALUE');
    expect(res.content[0]!.text).not.toContain('secret');
  });

  it('lists all forms on status=all', async () => {
    const { get } = rig(() => okJson(FORMS));
    const out = jsonOf(await get('insync_list_forms')({ status: 'all' }));
    expect((out.data as unknown[]).length).toBe(2);
  });

  it('full returns the sanitized records (no forbidden field) under the fence', async () => {
    const { get } = rig(() => okJson(FORMS));
    const res = await get('insync_list_forms')({ status: 'all', view: 'full' });
    expect(res.content[0]!.text).not.toContain('TemplateHTML');
    expect(res.content[0]!.text).not.toContain('HASHVALUE');
    const out = jsonOf(res);
    expect((out.data as Record<string, unknown>[])[0]).toHaveProperty('FormName');
  });
});

describe('parseSurveyRows', () => {
  it('reads name and received date from each row, skipping headers and empty names', () => {
    const html =
      '<table>' +
      '<tr><th>Name</th><th>Date</th></tr>' + // header row: no <td>, skipped
      '<tr onclick="go(\'TOKEN123\')"><td>Satisfaction Survey</td><td>10/02/2026</td></tr>' +
      '<tr><td></td><td>10/03/2026</td></tr>' + // empty name, skipped
      '<tr><td>only-one-cell</td></tr>' + // < 2 cells, skipped
      '</table>';
    const rows = parseSurveyRows(html);
    expect(rows).toEqual([{ name: 'Satisfaction Survey', received: '10/02/2026' }]);
    // The onclick token must never be surfaced.
    expect(JSON.stringify(rows)).not.toContain('TOKEN123');
  });

  it('decodes entities exactly once through the parser and collapses whitespace', () => {
    const html =
      '<table><tr>' +
      '<td> Intake &amp; Consent&nbsp;Form \n &lt;v2&gt; &#39;adult&#39; &quot;PHQ&quot; </td>' +
      '<td>10/02/2026</td>' +
      '</tr><tr><td>Fees &amp;amp; Policy</td><td>10/03/2026</td></tr></table>';
    expect(parseSurveyRows(html)).toEqual([
      { name: `Intake & Consent Form <v2> 'adult' "PHQ"`, received: '10/02/2026' },
      // "&amp;amp;" is a literal "&amp;" in the source — decoded once, not twice
      { name: 'Fees &amp; Policy', received: '10/03/2026' },
    ]);
  });
});

describe('insync_list_surveys', () => {
  it('returns the parsed rows wrapped as untrusted', async () => {
    const html = '<table><tr><td>Outcome Survey</td><td>10/05/2026</td></tr></table>';
    const { get } = rig(() => okText(html));
    const out = jsonOf(await get('insync_list_surveys')({}));
    expect(out.untrusted_content).toBe(true);
    expect(out.data).toEqual([{ name: 'Outcome Survey', received: '10/05/2026' }]);
  });
});

describe('insync_list_documents', () => {
  it('projects the Files array on compact', async () => {
    const payload = { Files: [{ Name: 'summary.pdf' }], TreeData: [] };
    const { get } = rig(() => okJson(payload));
    expect(JSON.parse(textOf(await get('insync_list_documents')({})))).toEqual([{ Name: 'summary.pdf' }]);
  });

  it('falls back to raw when Files is absent', async () => {
    const { get } = rig(() => okJson({ TreeData: [] }));
    expect(jsonOf(await get('insync_list_documents')({}))).toEqual({ TreeData: [] });
  });
});
