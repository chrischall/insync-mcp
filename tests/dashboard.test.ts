import { describe, expect, it } from 'vitest';
import { registerDashboardTools } from '../src/tools/dashboard.js';
import { capture, jsonOf, okJson, type FakeCall } from './_tools.js';

function rig(responder: (c: FakeCall) => ReturnType<typeof okJson>) {
  const { handlers } = capture(registerDashboardTools, responder);
  return (name: string) => handlers.get(name)!;
}

const COUNTS = {
  Dashboard: [
    {
      UnreadMessage: 2,
      Medications: 5,
      Allergies: 1,
      Problems: 3,
      LabResults: 0,
      Immunizations: 4,
      PendingPatientFormCount: 1,
      PendingPatientSurveyFormCount: 0,
      PatientID: 999,
      PracticeId: 7,
    },
  ],
};

const BALANCE = { Dashboard: { PaymentSummaryModel: [{ NetDue: 42.5, CreditBalance: 0 }] } };

describe('insync_get_counts', () => {
  const get = rig((c) => okJson(c.path.includes('Balance') ? BALANCE : COUNTS));

  it('projects the badge counts and drops the internal ids', async () => {
    const out = jsonOf(await get('insync_get_counts')({}));
    expect(out).toMatchObject({ unreadMessages: 2, medications: 5, pendingForms: 1 });
    expect(out).not.toHaveProperty('PatientID');
    expect(out).not.toHaveProperty('PracticeId');
  });

  it('returns the portal payload untouched on raw', async () => {
    const out = jsonOf(await get('insync_get_counts')({ view: 'raw' }));
    expect(out).toEqual(COUNTS);
  });

  it('falls back to the raw payload when the shape is unexpected', async () => {
    const get2 = rig(() => okJson({ Dashboard: 'nope' }));
    const out = jsonOf(await get2('insync_get_counts')({}));
    expect(out).toEqual({ Dashboard: 'nope' });
  });
});

describe('insync_get_balance', () => {
  const get = rig((c) => okJson(c.path.includes('Balance') ? BALANCE : COUNTS));

  it('projects net due and credit balance', async () => {
    const out = jsonOf(await get('insync_get_balance')({}));
    expect(out).toEqual({ netDue: 42.5, creditBalance: 0 });
  });

  it('falls back to raw when PaymentSummaryModel is missing', async () => {
    const get2 = rig(() => okJson({ Dashboard: {} }));
    const out = jsonOf(await get2('insync_get_balance')({}));
    expect(out).toEqual({ Dashboard: {} });
  });
});
