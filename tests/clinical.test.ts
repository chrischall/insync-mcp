import { describe, expect, it } from 'vitest';
import { parseRefillGrid, registerClinicalTools } from '../src/tools/clinical.js';
import { capture, jsonOf, okJson, okText, type FakeCall } from './_tools.js';

function rig(responder: (c: FakeCall) => ReturnType<typeof okJson>) {
  const { handlers, transport } = capture(registerClinicalTools, responder);
  return { get: (name: string) => handlers.get(name)!, transport };
}

const MEDS = {
  recordsTotal: 1,
  data: [
    {
      DrugName: 'Example 10 mg tablet',
      Dispense: '30',
      DrugQuantity: '30',
      Refills: '2',
      DaysSupply: '30',
      PrescriptionDatetxt: '10/01/2026 09:00 AM',
      PrescriptionDate: '2026-10-01',
      PhysicianName: 'Dr. Test Provider',
      Rxcui: '123456',
    },
  ],
};

describe('insync_list_medications', () => {
  it('projects the medication rows, preferring the display date', async () => {
    const { get } = rig(() => okJson(MEDS));
    const out = jsonOf(await get('insync_list_medications')({ status: 'current' }));
    expect(out.total).toBe(1);
    expect((out.medications as unknown[])[0]).toEqual({
      name: 'Example 10 mg tablet',
      dispense: '30',
      quantity: '30',
      refills: '2',
      daysSupply: '30',
      prescribed: '10/01/2026 09:00 AM',
      prescriber: 'Dr. Test Provider',
      rxcui: '123456',
    });
  });

  it('requests the discontinued type code', async () => {
    const { get, transport } = rig(() => okJson(MEDS));
    await get('insync_list_medications')({ status: 'discontinued' });
    expect(transport.calls[0]!.path).toContain('%2268%22');
  });

  it('falls back to the wire date when the display date is absent', async () => {
    const { get } = rig(() =>
      okJson({ recordsTotal: 1, data: [{ DrugName: 'Example', PrescriptionDate: '2026-10-01' }] }),
    );
    const out = jsonOf(await get('insync_list_medications')({}));
    expect((out.medications as Record<string, unknown>[])[0]).toEqual({
      name: 'Example',
      prescribed: '2026-10-01',
    });
  });

  it('falls back to raw when data is missing', async () => {
    const { get } = rig(() => okJson({ recordsTotal: 0 }));
    expect(jsonOf(await get('insync_list_medications')({}))).toEqual({ recordsTotal: 0 });
  });
});

describe('insync_list_allergies', () => {
  it('returns the allergy rows with a total', async () => {
    const data = { recordsTotal: 1, data: [{ AllergyName: 'Penicillin', Reaction: 'Rash' }] };
    const { get } = rig(() => okJson(data));
    const out = jsonOf(await get('insync_list_allergies')({}));
    expect(out).toEqual({ total: 1, allergies: [{ AllergyName: 'Penicillin', Reaction: 'Rash' }] });
  });

  it('falls back to raw when data is not an array', async () => {
    const { get } = rig(() => okJson({ recordsTotal: 0, data: {} }));
    expect(jsonOf(await get('insync_list_allergies')({}))).toEqual({ recordsTotal: 0, data: {} });
  });
});

describe('parseRefillGrid', () => {
  it('keys rows by the header row when counts match', () => {
    const html =
      '<table><thead><tr><th>Drug</th><th>Status</th></tr></thead>' +
      '<tbody><tr><td>Example</td><td>Requested</td></tr></tbody></table>';
    expect(parseRefillGrid(html)).toEqual([{ Drug: 'Example', Status: 'Requested' }]);
  });

  it('returns cell arrays when there is no header, and skips header/empty rows', () => {
    const html =
      '<table><tr><th>ignored</th></tr>' +
      '<tr><td>A &amp; B</td><td>2026</td></tr></table>';
    // The th-only row has no <td> and is skipped; the data row has no matching
    // header count, so it comes back as an array (entities decoded, ws collapsed).
    expect(parseRefillGrid(html)).toEqual([['A & B', '2026']]);
  });

  it('decodes every entity the grid emits through the parser, once', () => {
    const html =
      '<table><thead><tr><th>Drug</th><th>Note</th></tr></thead>' +
      '<tbody><tr><td>Drug&nbsp;&lt;10mg&gt;</td><td>&#39;as needed&#39; &quot;PRN&quot; &amp;amp;</td></tr></tbody></table>';
    expect(parseRefillGrid(html)).toEqual([{ Drug: 'Drug <10mg>', Note: `'as needed' "PRN" &amp;` }]);
  });
});

describe('insync_list_refill_requests', () => {
  it('parses the grid into rows', async () => {
    const html = '<table><tbody><tr><td>Example</td><td>Requested</td></tr></tbody></table>';
    const { get } = rig(() => okText(html));
    const out = jsonOf(await get('insync_list_refill_requests')({}));
    expect(out).toEqual({ requests: [['Example', 'Requested']] });
  });
});
