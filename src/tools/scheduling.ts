// Appointment requests and cancellation requests, plus the slot lookup both
// need. The two writes are confirm-gated (`defineWrite` + `registerWrite`):
// the practice receives each request, and this server has no withdraw.
//
// The lookups (facilities, providers, visit types, slots, the cancellation
// window and the cancel modal) were verified live, read-only. The two saves
// are derived from `_JS_AppointmentBundle` and the cancel partial view, and are
// UNVERIFIED on the wire — see docs/INSYNC-API.md. Both are REQUESTS: the
// practice confirms a requested appointment, and reviews a cancellation.
//
// Scope: a request names one open slot. The portal's "flexible date/time
// window" request is not offered.

import { z } from 'zod';
import {
  IsoDate,
  McpToolError,
  NonEmptyString,
  NumericIdString,
  defineWrite,
  registerWrite,
  resolveUserTimeZone,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import { inputValue } from '../forms.js';
import { isoToMdy } from './appointments.js';
import { READ, asRecord, asRecordArray, sameId, tidy } from './_shared.js';
import { WRITE, compactResult, sendOnce, writeDescription } from './_writes.js';

/**
 * "Now" as the portal's slot lookup takes it (`MM/DD/YYYY hh:mm AM`), so
 * today's past slots are filtered. Read in the user's zone when one is set.
 */
export function portalNow(now: Date = new Date(), timeZone: string | undefined = resolveUserTimeZone()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`;
}

/** `SaveAppointmentReq`'s body for one fixed slot, as the portal's controller builds it. */
export function buildAppointmentRequest(input: {
  facilityId: string;
  provider: Record<string, unknown>;
  date: string;
  slot: Record<string, unknown>;
  visitTypeId: unknown;
  comments: string;
  telemedicine: boolean;
}): Record<string, unknown> {
  return {
    FacilityId: input.facilityId,
    ResourceId: input.provider.ResourceId,
    ScheduleSetupID: input.provider.ScheduleSetupID,
    ResourceType: input.provider.ResourceType,
    IsFlexible: false,
    PrefferedDate: input.date,
    PrefferedTime: input.slot.Time,
    FlexibleDateFrom: '',
    FlexibleDateTo: '',
    FlexibleTimeFrom: '',
    FlexibleTimeTo: '',
    Comments: input.comments,
    IsTelemedicineMeeting: input.telemedicine,
    VisitTypeID: input.visitTypeId,
    Duration: input.slot.Duration,
    ScheduleID: input.slot.ScheduleID,
  };
}

/** Everything the scheduler shows for one date, with the facility/provider defaulted as the portal does. */
interface Schedule {
  facilities: Record<string, unknown>[];
  facility: Record<string, unknown>;
  providers: Record<string, unknown>[];
  provider: Record<string, unknown> | undefined;
  visitTypes: Record<string, unknown>[];
  visitTypeMandatory: boolean;
  slots: Record<string, unknown>[];
  nextAvailable: unknown;
}

async function loadSchedule(
  client: InsyncClient,
  args: { date: string; facilityId?: string; providerId?: string; visitTypeId?: string },
): Promise<Schedule> {
  const practiceId = inputValue(await client.getSchedulerPage(), 'PracticeID');
  if (practiceId === undefined || practiceId === '') {
    throw new McpToolError('The scheduler page did not carry a practice id.', {
      hint: 'The practice may not offer online appointment requests, or the page changed.',
    });
  }
  const facilities = asRecordArray(asRecord(await client.listRequestFacilities(practiceId)).FacilityData);
  const facility =
    args.facilityId !== undefined
      ? facilities.find((f) => sameId(f.FacilityId, args.facilityId))
      : (facilities.find((f) => Number(f.IsPrimaryForPatient) === 1) ?? facilities[0]);
  if (facility === undefined) {
    throw new McpToolError(
      args.facilityId !== undefined
        ? `Facility ${args.facilityId} is not one the practice offers.`
        : 'The practice offers no facility for appointment requests.',
      { hint: 'Use a facility id from insync_find_appointment_slots.' },
    );
  }
  const date = isoToMdy(args.date);
  const facilityId = String(facility.FacilityId);
  const providers = asRecordArray(asRecord(await client.listRequestProviders(facilityId, date)).ProviderData);
  const provider =
    args.providerId !== undefined
      ? providers.find((p) => sameId(p.ResourceId, args.providerId))
      : (providers.find((p) => Number(p.IsPrimaryProvider) === 1) ?? providers[0]);
  if (provider === undefined && args.providerId !== undefined) {
    throw new McpToolError(`Provider ${args.providerId} is not bookable there on ${args.date}.`, {
      hint: 'Use a provider id from insync_find_appointment_slots for that facility and date.',
    });
  }
  if (provider === undefined) {
    return {
      facilities,
      facility,
      providers,
      provider,
      visitTypes: [],
      visitTypeMandatory: false,
      slots: [],
      nextAvailable: undefined,
    };
  }
  const scheduleSetupId = String(provider.ScheduleSetupID);
  const types = asRecord(await client.listRequestVisitTypes({ scheduleSetupId, date, facilityId }));
  const slotData = asRecord(
    await client.listRequestSlots({
      scheduleSetupId,
      date,
      currentTime: portalNow(),
      resourceId: String(provider.ResourceId),
      visitTypeId: args.visitTypeId ?? '',
    }),
  );
  return {
    facilities,
    facility,
    providers,
    provider,
    visitTypes: asRecordArray(types.lst),
    visitTypeMandatory: types.IsAppointmentReqPlotVisitTypeMandatory === true,
    slots: asRecordArray(slotData.ScheduleSlots),
    nextAvailable: asRecord(slotData.NextAvailability).NextAvailablityDate,
  };
}

const facilityView = (f: Record<string, unknown>) => ({ facilityId: String(f.FacilityId), name: f.FacilityName });
const providerView = (p: Record<string, unknown>) =>
  tidy({ providerId: String(p.ResourceId), name: p.ProviderName, primary: Number(p.IsPrimaryProvider) === 1 || undefined });
const visitTypeView = (v: Record<string, unknown>) => ({ visitTypeId: String(v.EncounterTypeID), name: v.EncounterType });
const openSlots = (slots: Record<string, unknown>[]) => slots.filter((s) => Number(s.IsAvailable) === 1);

export function registerSchedulingTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_find_appointment_slots',
    {
      description:
        'Find open appointment-request slots on a date: the practice’s facilities, the providers ' +
        'bookable there, the visit types and the open times for one provider (default: your ' +
        'primary facility and provider). Use the ids and a listed time with ' +
        'insync_request_appointment. Changes nothing.',
      annotations: READ,
      inputSchema: z.object({
        date: IsoDate.describe('The date to look at, YYYY-MM-DD.'),
        facility_id: NumericIdString.optional().describe('Facility id. Default: your primary facility.'),
        provider_id: NumericIdString.optional().describe('Provider id. Default: your primary provider.'),
        visit_type_id: NumericIdString.optional().describe('Narrow the slots to one visit type.'),
      }),
    },
    async ({ date, facility_id, provider_id, visit_type_id }) => {
      const s = await loadSchedule(client, {
        date,
        facilityId: facility_id,
        providerId: provider_id,
        visitTypeId: visit_type_id,
      });
      return compactResult(
        tidy({
          date,
          facility: facilityView(s.facility),
          facilities: s.facilities.map(facilityView),
          provider: s.provider === undefined ? undefined : providerView(s.provider),
          providers: s.providers.map(providerView),
          visitTypes: s.visitTypes.map(visitTypeView),
          visitTypeRequired: s.visitTypeMandatory || undefined,
          slots: openSlots(s.slots).map((x) => ({ time: x.Time, durationMinutes: x.Duration })),
          nextAvailable: s.nextAvailable,
        }),
      );
    },
  );

  registerWrite(
    server,
    defineWrite({
      name: 'insync_request_appointment',
      description: writeDescription(
        'Request an appointment in an open slot (find one with insync_find_appointment_slots). ' +
          'This sends a REQUEST the practice must confirm; it is not a booking, and this server ' +
          'cannot withdraw it.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        date: IsoDate.describe('The slot date, YYYY-MM-DD.'),
        time: NonEmptyString.describe('The slot time exactly as insync_find_appointment_slots lists it, e.g. "09:00 AM".'),
        provider_id: NumericIdString.describe('Provider id, from insync_find_appointment_slots.'),
        facility_id: NumericIdString.optional().describe('Facility id. Default: your primary facility.'),
        visit_type_id: NumericIdString.optional().describe('Visit type id, from insync_find_appointment_slots.'),
        comments: z.string().max(1000).optional().describe('A note for the practice (optional).'),
        telemedicine: z.boolean().default(false).describe('Ask for a telemedicine (video) visit. Default false.'),
      }),
      async plan(args) {
        const s = await loadSchedule(client, {
          date: args.date,
          facilityId: args.facility_id,
          providerId: args.provider_id,
          visitTypeId: args.visit_type_id,
        });
        // loadSchedule throws for an explicit provider it cannot find.
        const provider = s.provider as Record<string, unknown>;
        const visitType =
          args.visit_type_id === undefined
            ? undefined
            : s.visitTypes.find((v) => sameId(v.EncounterTypeID, args.visit_type_id));
        if (args.visit_type_id !== undefined && visitType === undefined) {
          throw new McpToolError(`Visit type ${args.visit_type_id} is not offered by this provider.`, {
            hint: 'Use a visit type id from insync_find_appointment_slots.',
          });
        }
        if (visitType === undefined && s.visitTypeMandatory) {
          throw new McpToolError('This practice requires a visit type on appointment requests.', {
            hint: 'Pass visit_type_id from insync_find_appointment_slots.',
          });
        }
        const slot = openSlots(s.slots).find((x) => x.Time === args.time);
        if (slot === undefined) {
          throw new McpToolError(`${args.time} on ${args.date} is not an open slot for that provider.`, {
            hint: 'Pick a time insync_find_appointment_slots lists for the same date and provider.',
          });
        }
        const body = buildAppointmentRequest({
          facilityId: String(s.facility.FacilityId),
          provider,
          date: isoToMdy(args.date),
          slot,
          visitTypeId: visitType?.EncounterTypeID ?? '',
          comments: args.comments ?? '',
          telemedicine: args.telemedicine === true,
        });
        const summary = {
          date: args.date,
          time: args.time,
          provider: provider.ProviderName,
          facility: s.facility.FacilityName,
          visitType: visitType?.EncounterType,
        };
        return {
          gate: {
            action: 'insync.request_appointment',
            summary: `Request an appointment with ${String(provider.ProviderName)} on ${args.date} at ${args.time}`,
            account: undefined,
            request: { method: 'POST', path: 'PatientScheduler/SaveAppointmentReq', body },
            willSend: tidy({ ...summary, comments: args.comments, telemedicine: args.telemedicine === true }),
            preview: { note: 'This is a request; the practice confirms or declines it.' },
          },
          state: { body, summary },
        };
      },
      async execute({ body, summary }) {
        return sendOnce(
          async () => {
            const data = await client.submitJson('PatientScheduler/SaveAppointmentReq', body);
            const result = asRecord(data.resultModel);
            const status = Number(result.Status);
            if (status === 2) {
              throw new McpToolError('That slot is already booked.', {
                hint: 'Nothing was requested. Pick another slot with insync_find_appointment_slots.',
              });
            }
            if (status === 4) {
              throw new McpToolError(`The practice declined the request: ${String(result.ResponseMsg)}`, {
                hint: 'Nothing was requested.',
              });
            }
            if (status !== 1) {
              throw new McpToolError('InSync did not accept the appointment request.', {
                hint: 'Nothing was requested, or the save flow changed; see docs/INSYNC-API.md.',
              });
            }
            return {
              requested: true,
              requestId: result.PPARID,
              ...summary,
              note: 'The practice still has to confirm this request. Check insync_list_appointments.',
            };
          },
          'appointment request',
          'insync_list_appointments',
        );
      },
      render: compactResult,
    }),
  );

  registerWrite(
    server,
    defineWrite({
      name: 'insync_cancel_appointment',
      description: writeDescription(
        'Ask the practice to cancel an upcoming appointment (visit id from ' +
          'insync_list_appointments), with a reason. This sends a cancellation REQUEST the ' +
          'practice reviews; it cannot be withdrawn through this server. Refused when the ' +
          'practice’s cancellation period has passed.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        visit_id: NumericIdString.describe('The visit id, from insync_list_appointments.'),
        reason: NonEmptyString.max(500).describe('Reason for cancelling (the portal requires one).'),
      }),
      async plan({ visit_id, reason }) {
        const upcoming = asRecord(await client.listAppointments('upcoming', { pageSize: 100 }));
        const current = asRecord(upcoming.currentAppointment);
        const rows = asRecordArray(current.Appointment);
        const visit = rows.find((a) => sameId(a.VisitID, visit_id));
        // One page of 100 is read. When the portal says there are more and the
        // visit was not on that page, "not upcoming" would be a guess — say what
        // was actually checked instead. No numeric TotalRows: the page is the list.
        const total = Number(current.TotalRows);
        if (visit === undefined && Number.isFinite(total) && total > rows.length) {
          throw new McpToolError(
            `Could not find visit ${visit_id}: you have ${total} upcoming appointments and only ` +
              `${rows.length} were checked.`,
            {
              hint:
                'Check the visit id against insync_list_appointments (upcoming), or cancel it in ' +
                'the portal. (This server does not page through the rest of the list.)',
            },
          );
        }
        if (visit === undefined) {
          throw new McpToolError(`Visit ${visit_id} is not one of your upcoming appointments.`, {
            hint: 'Use a visit id from insync_list_appointments (upcoming).',
          });
        }
        if (Number(visit.IsNotCancel) === 1) {
          throw new McpToolError('The practice marks this appointment as one that cannot be cancelled online.', {
            hint: 'Contact the practice directly, or send a message (insync_send_message).',
          });
        }
        if ((await client.checkCancelWindow(visit_id)) === '2') {
          throw new McpToolError('The cancellation period for this appointment has passed.', {
            hint: 'The portal will not take a cancellation now. Contact the practice directly.',
          });
        }
        const form = {
          VisitID: visit_id,
          PPARID: String(visit.PPARID ?? 0),
          Comments: reason.trim(),
          caseID: '3',
        };
        const shown = tidy({
          date: visit.VisitDate,
          time: visit.StartTime,
          provider: visit.Provider,
          type: visit.VisitType,
          status: visit.VisitStatus,
        });
        return {
          gate: {
            action: 'insync.cancel_appointment',
            summary: `Ask the practice to cancel your ${String(visit.VisitDate)} appointment`,
            account: undefined,
            target: visit_id,
            request: { method: 'POST', path: 'Appointment/SaveCancelAppointmentRequest', body: form },
            willSend: { appointment: shown, reason: form.Comments },
          },
          state: { form, shown },
        };
      },
      async execute({ form, shown }) {
        return sendOnce(
          async () => {
            await client.submitForm('Appointment/SaveCancelAppointmentRequest', form);
            return {
              cancellationRequested: true,
              visitId: form.VisitID,
              appointment: shown,
              note: 'The practice reviews cancellation requests. Check insync_list_appointments.',
            };
          },
          'cancellation request',
          'insync_list_appointments',
        );
      },
      render: compactResult,
    }),
  );
}
