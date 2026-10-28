import { describe, expect, it } from 'vitest';
import {
  isoToMdy,
  monthRange,
  registerAppointmentTools,
} from '../src/tools/appointments.js';
import { capture, jsonOf, okJson, type FakeCall } from './_tools.js';

function rig(responder: (c: FakeCall) => ReturnType<typeof okJson>) {
  const { handlers, transport } = capture(registerAppointmentTools, responder);
  return { get: (name: string) => handlers.get(name)!, transport };
}

const APPTS = {
  currentAppointment: {
    TotalRows: 1,
    Appointment: [
      {
        VisitID: 'V1',
        VisitDate: '11/03/2026',
        StartTime: '10:00 AM',
        EndTime: '10:45 AM',
        Provider: 'Dr. Test Provider',
        FacilityName: 'Example Clinic',
        VisitType: 'Therapy',
        VisitStatus: 'Check In',
        ExpectedCopay: '25',
        STime: { Ticks: 123, TotalMinutes: 600 },
      },
    ],
  },
  Result: true,
};

const CALENDAR = {
  totalCount: 1,
  appointments: [
    { VisitDate: '11/03/2026', TimeSlab: '10:00 AM', AppText: 'Therapy — Dr. Test', VisitID: 'V1', ColorCode: '#abc' },
  ],
};

describe('date helpers', () => {
  it('isoToMdy reorders to MM/DD/YYYY', () => {
    expect(isoToMdy('2026-11-03')).toBe('11/03/2026');
  });

  it('monthRange spans the whole month', () => {
    expect(monthRange('2026-11-15')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('insync_list_appointments', () => {
  it('projects the key visit fields and drops the STime noise', async () => {
    const { get } = rig(() => okJson(APPTS));
    const out = jsonOf(await get('insync_list_appointments')({ when: 'upcoming' }));
    expect(out.total).toBe(1);
    expect((out.appointments as unknown[])[0]).toEqual({
      visitId: 'V1',
      date: '11/03/2026',
      start: '10:00 AM',
      end: '10:45 AM',
      provider: 'Dr. Test Provider',
      facility: 'Example Clinic',
      type: 'Therapy',
      status: 'Check In',
      expectedCopay: '25',
    });
  });

  it('asks the client for the past endpoint when when=past, and pages', async () => {
    const { get, transport } = rig(() => okJson(APPTS));
    await get('insync_list_appointments')({ when: 'past', page: 2, page_size: 10 });
    const call = transport.calls[0]!;
    expect(call.path).toContain('PastAppiontmentDetails');
    expect(call.body).toMatchObject({ pageOptions: { PageSize: 10, CurrentPage: 2 } });
  });

  it('keeps the full payload on raw', async () => {
    const { get } = rig(() => okJson(APPTS));
    expect(jsonOf(await get('insync_list_appointments')({ view: 'raw' }))).toEqual(APPTS);
  });

  it('falls back to raw when the appointment list is missing', async () => {
    const { get } = rig(() => okJson({ currentAppointment: {} }));
    expect(jsonOf(await get('insync_list_appointments')({}))).toEqual({ currentAppointment: {} });
  });
});

describe('insync_get_appointment_calendar', () => {
  /** The tool's registered input schema, for asserting what the SDK would reject. */
  function calendarSchema(): { safeParse: (v: unknown) => { success: boolean } } {
    let schema: unknown;
    const server = {
      registerTool: (name: string, def: { inputSchema: unknown }) => {
        if (name === 'insync_get_appointment_calendar') schema = def.inputSchema;
      },
    };
    registerAppointmentTools(server as never, {} as never);
    return schema as { safeParse: (v: unknown) => { success: boolean } };
  }

  it('rejects a date that is not a real calendar date', () => {
    const schema = calendarSchema();
    // A bare digit-shape check let 2026-13-45 through, and monthRange then sent
    // 2026-13-01..2026-13-31 to the portal.
    expect(schema.safeParse({ from: '2026-13-45' }).success).toBe(false);
    expect(schema.safeParse({ to: '2026-02-30' }).success).toBe(false);
    expect(schema.safeParse({ from: '11/01/2026' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-11-01', to: '2026-11-30' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('projects each day entry and totals', async () => {
    const { get } = rig(() => okJson(CALENDAR));
    const out = jsonOf(await get('insync_get_appointment_calendar')({ from: '2026-11-01', to: '2026-11-30' }));
    expect(out.total).toBe(1);
    expect((out.appointments as unknown[])[0]).toEqual({
      date: '11/03/2026',
      time: '10:00 AM',
      label: 'Therapy — Dr. Test',
      visitId: 'V1',
    });
  });

  it('defaults to the current month and sends MM/DD/YYYY', async () => {
    const { get, transport } = rig(() => okJson(CALENDAR));
    await get('insync_get_appointment_calendar')({});
    const body = transport.calls[0]!.body as { FromDate: string; ToDate: string };
    expect(body.FromDate).toMatch(/^\d{2}\/01\/\d{4}$/);
    expect(body.ToDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('falls back to raw when appointments is not an array', async () => {
    const { get } = rig(() => okJson({ totalCount: 0, appointments: null }));
    expect(jsonOf(await get('insync_get_appointment_calendar')({ from: '2026-11-01', to: '2026-11-30' }))).toEqual({
      totalCount: 0,
      appointments: null,
    });
  });
});
