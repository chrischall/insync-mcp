import { describe, expect, it } from 'vitest';
import { buildAppointmentRequest, portalNow, registerSchedulingTools } from '../src/tools/scheduling.js';
import { capture, gated, jsonOf, okJson, okText, type FakeCall } from './_tools.js';
import type { FetchResult } from '../src/transport.js';

// Synthetic portal answers in the verified shapes — no PHI.
const SCHED_PAGE = '<input id="PracticeID" name="PracticeID" type="hidden" value="77" />';
const FACILITIES = {
  FacilityData: [
    { FacilityId: 1, FacilityName: 'Main Office', IsPrimaryForPatient: 0 },
    { FacilityId: 2, FacilityName: 'Uptown', IsPrimaryForPatient: 1 },
  ],
};
const PROVIDERS = {
  ProviderData: [
    { ResourceId: 50, ProviderName: 'Dr. One', IsPrimaryProvider: 0, ScheduleSetupID: 500, ResourceType: 1, DayOfTheWeek: '1,3', ScheduleID: 9, ResourceImagePath: '/img' },
    { ResourceId: 51, ProviderName: 'Dr. Two', IsPrimaryProvider: 1, ScheduleSetupID: 510, ResourceType: 1, DayOfTheWeek: '2', ScheduleID: 9, ResourceImagePath: '' },
  ],
};
const VISIT_TYPES = {
  lst: [
    { EncounterTypeID: 890, EncounterType: 'Virtual Follow-up' },
    { EncounterTypeID: 891, EncounterType: 'Follow-up' },
  ],
};
const SLOTS = {
  ScheduleSlots: [
    { Time: '08:00 AM', Duration: 30, IsAvailable: 0, ScheduleID: 834 },
    { Time: '09:00 AM', Duration: 30, IsAvailable: 1, ScheduleID: 834 },
  ],
  NextAvailability: { IsAvailableWithinCertainDays: true, NextAvailablityDate: '11/21/2026' },
};
const FUTURE = {
  currentAppointment: {
    TotalRows: 2,
    Appointment: [
      { VisitID: 900, VisitDate: '11/13/2026', StartTime: '09:00 AM', Provider: 'Dr. Two', VisitType: 'Follow-up', VisitStatus: 'Pending', IsNotCancel: 0, PPARID: 0 },
      { VisitID: 901, VisitDate: '11/20/2026', StartTime: '10:00 AM', Provider: 'Dr. Two', VisitType: 'Follow-up', VisitStatus: 'Pending', IsNotCancel: 1, PPARID: 12 },
    ],
  },
};

function rig(over: Partial<Record<string, FetchResult>> = {}) {
  const { handlers, transport } = capture(registerSchedulingTools as never, (call: FakeCall) => {
    const key = call.path.split('?')[0]!;
    if (over[key] !== undefined) return over[key]!;
    switch (key) {
      case 'PatientScheduler':
        return okText(SCHED_PAGE);
      case 'PatientScheduler/BindFacilities':
        return okJson(FACILITIES);
      case 'PatientScheduler/BindProviders':
        return okJson(PROVIDERS);
      case 'PatientScheduler/GetSchedulerVisitTypeSlots':
        return okJson(VISIT_TYPES);
      case 'PatientScheduler/BindSchedulerSlots':
        return okJson(SLOTS);
      case 'PatientScheduler/FutureAppiontmentDetails':
        return okJson(FUTURE);
      case 'Appointment/CheckCancelAppointmentRequestTimeDuration':
        return okText('0');
      case 'ClinicalSummary/GetAntiForgeryToken':
        return okJson({ formToken: 'tok' });
      case 'PatientScheduler/SaveAppointmentReq':
        return okJson({ resultModel: { Status: 1, PPARID: 4242 }, requestDate: '11/20/2026' });
      case 'Appointment/SaveCancelAppointmentRequest':
        return okText('');
      default:
        throw new Error(`unexpected ${call.verb} ${call.path}`);
    }
  });
  return {
    transport,
    find: handlers.get('insync_find_appointment_slots')!,
    request: gated(handlers.get('insync_request_appointment')!, transport),
    cancel: gated(handlers.get('insync_cancel_appointment')!, transport),
  };
}

const pathOf = (calls: FakeCall[], prefix: string) => calls.find((c) => c.path.startsWith(prefix))!;

describe('pure helpers', () => {
  it('formats now as the portal’s MM/DD/YYYY hh:mm AM in a given zone', () => {
    const at = new Date('2026-10-28T20:05:00Z');
    expect(portalNow(at, 'America/New_York')).toBe('10/28/2026 04:05 PM');
    expect(portalNow(new Date('2026-10-28T04:05:00Z'), 'UTC')).toBe('10/28/2026 04:05 AM');
  });

  it('builds SaveAppointmentReq exactly as the portal’s Angular controller does for a fixed slot', () => {
    expect(
      buildAppointmentRequest({
        facilityId: '2',
        provider: { ResourceId: 51, ScheduleSetupID: 510, ResourceType: 1 },
        date: '11/20/2026',
        slot: { Time: '09:00 AM', Duration: 30, ScheduleID: 834 },
        visitTypeId: 891,
        comments: 'c',
        telemedicine: true,
      }),
    ).toEqual({
      FacilityId: '2',
      ResourceId: 51,
      ScheduleSetupID: 510,
      ResourceType: 1,
      IsFlexible: false,
      PrefferedDate: '11/20/2026',
      PrefferedTime: '09:00 AM',
      FlexibleDateFrom: '',
      FlexibleDateTo: '',
      FlexibleTimeFrom: '',
      FlexibleTimeTo: '',
      Comments: 'c',
      IsTelemedicineMeeting: true,
      VisitTypeID: 891,
      Duration: 30,
      ScheduleID: 834,
    });
  });
});

describe('insync_find_appointment_slots', () => {
  it('defaults to the primary facility and provider and lists open slots only', async () => {
    const r = rig();
    const out = jsonOf(await r.find({ date: '2026-11-20' }));
    expect(out).toMatchObject({
      date: '2026-11-20',
      facility: { facilityId: '2', name: 'Uptown' },
      provider: { providerId: '51', name: 'Dr. Two' },
      visitTypes: [
        { visitTypeId: '890', name: 'Virtual Follow-up' },
        { visitTypeId: '891', name: 'Follow-up' },
      ],
      slots: [{ time: '09:00 AM', durationMinutes: 30 }],
      nextAvailable: '11/21/2026',
    });
    expect(out.providers).toHaveLength(2);
    expect(out.facilities).toHaveLength(2);
    expect(pathOf(r.transport.calls, 'PatientScheduler/BindFacilities').path).toContain('practiceId=77');
    expect(pathOf(r.transport.calls, 'PatientScheduler/BindProviders').path).toContain(
      'facilityId=2&date=11%2F20%2F2026',
    );
    expect(pathOf(r.transport.calls, 'PatientScheduler/BindSchedulerSlots').path).toContain(
      'providerId=510&date=11%2F20%2F2026',
    );
  });

  it('honours an explicit facility, provider and visit type', async () => {
    const r = rig();
    const out = jsonOf(await r.find({ date: '2026-11-20', facility_id: '1', provider_id: '50', visit_type_id: '890' }));
    expect(out).toMatchObject({ facility: { facilityId: '1' }, provider: { providerId: '50' } });
    expect(pathOf(r.transport.calls, 'PatientScheduler/BindSchedulerSlots').path).toContain(
      'ResourceId=50&EncounterTypeID=890',
    );
  });

  it('refuses an unknown facility or provider, and reports a date with no providers', async () => {
    await expect(rig().find({ date: '2026-11-20', facility_id: '9' })).rejects.toThrow(/facility 9/i);
    await expect(rig().find({ date: '2026-11-20', provider_id: '9' })).rejects.toThrow(/provider 9/i);
    const none = jsonOf(
      await rig({ 'PatientScheduler/BindProviders': okJson({ ProviderData: [] }) }).find({ date: '2026-11-20' }),
    );
    expect(none).toMatchObject({ providers: [], slots: [] });
    expect(none.provider).toBeUndefined();
  });

  it('falls back to the first facility/provider and tolerates sparse answers', async () => {
    const r = rig({
      'PatientScheduler/BindFacilities': okJson({ FacilityData: [{ FacilityId: 1, FacilityName: 'Main Office' }] }),
      'PatientScheduler/BindProviders': okJson({ ProviderData: [{ ResourceId: 50, ProviderName: 'Dr. One', ScheduleSetupID: 500 }] }),
      'PatientScheduler/GetSchedulerVisitTypeSlots': okJson({}),
      'PatientScheduler/BindSchedulerSlots': okJson({}),
    });
    const out = jsonOf(await r.find({ date: '2026-11-20' }));
    expect(out).toMatchObject({ facility: { facilityId: '1' }, provider: { providerId: '50' }, visitTypes: [], slots: [] });
  });

  it('refuses when the practice offers no facility or the page has no practice id', async () => {
    await expect(rig({ 'PatientScheduler/BindFacilities': okJson({}) }).find({ date: '2026-11-20' })).rejects.toThrow(
      /no facility/i,
    );
    await expect(rig({ PatientScheduler: okText('<div></div>') }).find({ date: '2026-11-20' })).rejects.toThrow(
      /practice/i,
    );
  });
});

describe('insync_request_appointment', () => {
  const args = { date: '2026-11-20', time: '09:00 AM', provider_id: '51', visit_type_id: '891' };

  it('previews the slot with names and sends nothing', async () => {
    const r = rig();
    const preview = await r.request.preview(args);
    expect(preview.confirmToken).toEqual(expect.any(String));
    const text = JSON.stringify(preview);
    expect(text).toContain('Dr. Two');
    expect(text).toContain('Uptown');
    expect(text).toContain('Follow-up');
    expect(r.transport.calls.some((c) => c.path.includes('SaveAppointmentReq'))).toBe(false);
  });

  it('refuses a time that is not an open slot, and an unknown visit type', async () => {
    await expect(rig().request.raw({ ...args, time: '08:00 AM' })).rejects.toThrow(/not an open slot/);
    await expect(rig().request.raw({ ...args, visit_type_id: '1' })).rejects.toThrow(/visit type 1/i);
  });

  it('requires a visit type when the practice marks it mandatory', async () => {
    const mandatory = okJson({ ...VISIT_TYPES, IsAppointmentReqPlotVisitTypeMandatory: true });
    const r = rig({ 'PatientScheduler/GetSchedulerVisitTypeSlots': mandatory });
    await expect(r.request.raw({ date: args.date, time: args.time, provider_id: '51' })).rejects.toThrow(
      /requires a visit type/,
    );
  });

  it('on confirm posts the JSON request once, never replayed, and returns the request id', async () => {
    const r = rig();
    const out = jsonOf(await r.request.confirmed({ ...args, comments: 'First visit', telemedicine: true }));
    const post = pathOf(r.transport.calls, 'PatientScheduler/SaveAppointmentReq');
    expect(post.verb).toBe('postJson');
    expect(post.opts?.replay).toBe(false);
    expect(post.body).toMatchObject({
      FacilityId: '2',
      ResourceId: 51,
      ScheduleSetupID: 510,
      PrefferedDate: '11/20/2026',
      PrefferedTime: '09:00 AM',
      VisitTypeID: 891,
      Duration: 30,
      ScheduleID: 834,
      Comments: 'First visit',
      IsTelemedicineMeeting: true,
    });
    expect(out).toMatchObject({ requested: true, requestId: 4242, provider: 'Dr. Two' });
  });

  it('sends an empty visit type and no comments when none are given', async () => {
    const r = rig();
    await r.request.confirmed({ date: args.date, time: args.time, provider_id: '51' });
    expect(pathOf(r.transport.calls, 'PatientScheduler/SaveAppointmentReq').body).toMatchObject({
      VisitTypeID: '',
      Comments: '',
      IsTelemedicineMeeting: false,
    });
  });

  it('surfaces already-booked and practice messages as refusals', async () => {
    const booked = rig({ 'PatientScheduler/SaveAppointmentReq': okJson({ resultModel: { Status: 2 } }) });
    await expect(booked.request.confirmed(args)).rejects.toThrow(/already/i);
    const msg = rig({
      'PatientScheduler/SaveAppointmentReq': okJson({ resultModel: { Status: 4, ResponseMsg: 'Balance due' } }),
    });
    await expect(msg.request.confirmed(args)).rejects.toThrow(/Balance due/);
    const odd = rig({ 'PatientScheduler/SaveAppointmentReq': okJson({}) });
    await expect(odd.request.confirmed(args)).rejects.toThrow(/did not accept/);
  });
});

describe('insync_cancel_appointment', () => {
  const args = { visit_id: '900', reason: 'Schedule conflict' };

  it('previews the visit being cancelled and sends nothing', async () => {
    const r = rig();
    const preview = await r.cancel.preview(args);
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).toContain('11/13/2026');
    expect(r.transport.calls.map((c) => c.path.split('?')[0])).toEqual([
      'PatientScheduler/FutureAppiontmentDetails',
      'Appointment/CheckCancelAppointmentRequestTimeDuration',
    ]);
  });

  it('refuses an unknown visit, a non-cancellable one, and a passed cancellation window', async () => {
    await expect(rig().cancel.raw({ ...args, visit_id: '1' })).rejects.toThrow(/upcoming/);
    await expect(rig().cancel.raw({ ...args, visit_id: '901' })).rejects.toThrow(/cannot be cancelled/);
    const late = rig({ 'Appointment/CheckCancelAppointmentRequestTimeDuration': okText('2') });
    await expect(late.cancel.raw(args)).rejects.toThrow(/cancellation period .*has passed/);
  });

  it('says the list was cut short, not that the visit is not upcoming, when TotalRows exceeds the rows', async () => {
    const big = { currentAppointment: { ...FUTURE.currentAppointment, TotalRows: '150' } };
    const r = rig({ 'PatientScheduler/FutureAppiontmentDetails': okJson(big) });
    await expect(r.cancel.raw({ ...args, visit_id: '1' })).rejects.toThrow(
      'Could not find visit 1: you have 150 upcoming appointments and only 2 were checked.',
    );
    // A complete page (TotalRows equal to the rows) keeps the plain "not upcoming" answer.
    await expect(rig().cancel.raw({ ...args, visit_id: '1' })).rejects.toThrow(/not one of your upcoming/);
  });

  it('on confirm posts the cancellation request once with the reason', async () => {
    const r = rig();
    const out = jsonOf(await r.cancel.confirmed(args));
    const post = pathOf(r.transport.calls, 'Appointment/SaveCancelAppointmentRequest');
    expect(post.opts?.replay).toBe(false);
    expect(post.body).toMatchObject({ VisitID: '900', PPARID: '0', Comments: 'Schedule conflict', caseID: '3' });
    expect(out).toMatchObject({ cancellationRequested: true, visitId: '900' });
  });

  it('sends PPARID 0 for a visit row that carries none', async () => {
    const bare = { currentAppointment: { Appointment: [{ VisitID: 900, VisitDate: '11/13/2026' }] } };
    const r = rig({ 'PatientScheduler/FutureAppiontmentDetails': okJson(bare) });
    await r.cancel.confirmed(args);
    expect(pathOf(r.transport.calls, 'Appointment/SaveCancelAppointmentRequest').body).toMatchObject({ PPARID: '0' });
  });

  it('reports an unknown outcome on a 5xx', async () => {
    const r = rig({ 'Appointment/SaveCancelAppointmentRequest': { status: 503, body: '' } });
    expect(jsonOf(await r.cancel.confirmed(args))).toMatchObject({ status: 'unknown' });
  });
});
