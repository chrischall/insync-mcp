import { describe, expect, it } from 'vitest';
import { buildRefillForm, parseRefillOptions, registerRefillTools } from '../src/tools/refills.js';
import { capture, gated, jsonOf, okJson, okText, type FakeCall } from './_tools.js';
import type { FetchResult } from '../src/transport.js';

// Synthetic refill page in the verified shape — no PHI.
const PAGE = (providers: string) => `
  <input type="hidden" value="Test Practice" id="PracticeName" />
  <select class="form-control input-sm sumoselect" id="ddlSearchPrimaryProvider" multiple="multiple" name="PrimaryProvider">${providers}</select>
  <select class="form-control input-sm sumoselect" id="ddlRefillDrug" multiple="multiple" name="RefillDrugName"><option value="101">Drug A 10mg Tablet</option><option value="102">Drug B 5mg Tablet</option></select>`;
const ONE_PROVIDER = PAGE('<option value="402">Clinical Team</option>');
const TWO_PROVIDERS = PAGE('<option value="402">Clinical Team</option><option value="404">Nursing</option>');

function rig(page = ONE_PROVIDER, save: FetchResult = okText('')) {
  const { handlers, transport } = capture(registerRefillTools as never, (call: FakeCall) => {
    if (call.path === 'RefillPrescription/RefillPrescription') return okText(page);
    if (call.path === 'ClinicalSummary/GetAntiForgeryToken') return okJson({ formToken: 'tok' });
    if (call.path === 'RefillPrescription/SaveRefillRequest') return save;
    throw new Error(`unexpected ${call.path}`);
  });
  return {
    transport,
    options: handlers.get('insync_get_refill_options')!,
    request: gated(handlers.get('insync_request_refill')!, transport),
  };
}

const args = {
  medication_ids: ['101', '102'],
  refills: 1,
  pharmacy_name: 'Corner Pharmacy',
  pharmacy_phone: '555-0100',
};

describe('pure helpers', () => {
  it('reads the medications, providers and practice off the refill page', () => {
    expect(parseRefillOptions(TWO_PROVIDERS)).toEqual({
      practice: 'Test Practice',
      medications: [
        { medicationId: '101', name: 'Drug A 10mg Tablet' },
        { medicationId: '102', name: 'Drug B 5mg Tablet' },
      ],
      providers: [
        { providerId: '402', name: 'Clinical Team' },
        { providerId: '404', name: 'Nursing' },
      ],
    });
  });

  it('builds the jQuery-serialized refillPrescripationList[0] form, in the script’s key order', () => {
    const form = buildRefillForm({
      drugNames: ['Drug A', 'Drug B'],
      medicationIds: ['101', '102'],
      refills: 2,
      reason: '',
      pharmacyName: 'P',
      pharmacyAddress: '',
      pharmacyPhone: '555',
      providerId: '402',
    });
    expect([...form]).toEqual([
      ['refillPrescripationList[0][DrugName]', 'Drug A, Drug B'],
      ['refillPrescripationList[0][NoOfRefills]', '2'],
      ['refillPrescripationList[0][ReasonForRefill]', ''],
      ['refillPrescripationList[0][PharmacyName]', 'P'],
      ['refillPrescripationList[0][PharmacyAddress]', ''],
      ['refillPrescripationList[0][PharmacyPhone]', '555'],
      ['refillPrescripationList[0][ResourceId]', '402'],
      ['refillPrescripationList[0][MedicationIDs]', '101,102'],
    ]);
  });
});

describe('insync_get_refill_options', () => {
  it('lists what a refill request can name', async () => {
    const out = jsonOf(await rig().options({}));
    expect(out.medications).toHaveLength(2);
    expect(out.providers).toEqual([{ providerId: '402', name: 'Clinical Team' }]);
  });
});

describe('insync_request_refill', () => {
  it('previews with resolved names and the only provider, and sends nothing', async () => {
    const r = rig();
    const preview = await r.request.preview(args);
    expect(preview.confirmToken).toEqual(expect.any(String));
    const text = JSON.stringify(preview);
    expect(text).toContain('Drug A 10mg Tablet');
    expect(text).toContain('Clinical Team');
    expect(r.transport.calls.map((c) => c.path)).toEqual(['RefillPrescription/RefillPrescription']);
  });

  it('refuses a medication not on the refill list', async () => {
    await expect(rig().request.raw({ ...args, medication_ids: ['999'] })).rejects.toThrow(/999/);
  });

  it('needs provider_id when the practice offers several, and checks it', async () => {
    const r = rig(TWO_PROVIDERS);
    await expect(r.request.raw(args)).rejects.toMatchObject({ hint: expect.stringMatching(/402.*404/) });
    await expect(r.request.raw({ ...args, provider_id: '1' })).rejects.toThrow(/provider 1/i);
    const preview = await r.request.preview({ ...args, provider_id: '404' });
    expect(JSON.stringify(preview)).toContain('Nursing');
  });

  it('refuses when the practice offers no provider at all', async () => {
    await expect(rig(PAGE('')).request.raw(args)).rejects.toThrow(/no provider/i);
    await expect(rig(PAGE('')).request.raw({ ...args, provider_id: '402' })).rejects.toMatchObject({
      hint: 'Offered: none.',
    });
  });

  it('on confirm posts the form once, never replayed, and points at the history to verify', async () => {
    const r = rig();
    const out = jsonOf(await r.request.confirmed({ ...args, reason: 'Running low', pharmacy_address: '1 Main' }));
    const post = r.transport.calls.find((c) => c.path === 'RefillPrescription/SaveRefillRequest')!;
    expect(post.opts?.replay).toBe(false);
    const body = post.body as URLSearchParams;
    expect(body.get('refillPrescripationList[0][MedicationIDs]')).toBe('101,102');
    expect(body.get('refillPrescripationList[0][ReasonForRefill]')).toBe('Running low');
    expect(body.get('refillPrescripationList[0][PharmacyAddress]')).toBe('1 Main');
    expect(body.get('__RequestVerificationToken')).toBe('tok');
    expect(out).toMatchObject({ requested: true, practice: 'Test Practice' });
    expect(String(out.note)).toMatch(/insync_list_refill_requests/);
  });

  it('reports an unknown outcome on a 5xx', async () => {
    const out = jsonOf(await rig(ONE_PROVIDER, { status: 500, body: '' }).request.confirmed(args));
    expect(out).toMatchObject({ status: 'unknown' });
  });
});
