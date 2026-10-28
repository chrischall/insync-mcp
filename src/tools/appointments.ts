import { z } from 'zod';
import { todayIso } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import { READ, asRecord, asRecordArray, tidy } from './_shared.js';
import { viewArg, viewResponse } from '../view.js';

/** ISO `YYYY-MM-DD` → the portal's `MM/DD/YYYY`. The schema has already validated the shape. */
export function isoToMdy(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${month}/${day}/${year}`;
}

/** First and last day of the month containing `iso` (`YYYY-MM-DD`), as ISO dates. */
export function monthRange(iso: string): { from: string; to: string } {
  const [year, month] = iso.split('-');
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return { from: `${year}-${month}-01`, to: `${year}-${month}-${String(lastDay).padStart(2, '0')}` };
}

const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use an ISO date, YYYY-MM-DD.');

export function registerAppointmentTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_list_appointments',
    {
      description:
        'List the patient’s appointments / visits — upcoming or past — with date, ' +
        'time, provider, facility, visit type, status and expected copay. Covers therapy, ' +
        'psychiatry and any other scheduled visit.',
      annotations: READ,
      inputSchema: z.object({
        when: z
          .enum(['upcoming', 'past'])
          .default('upcoming')
          .describe('Which appointments to list. Default upcoming.'),
        page: z.number().int().min(1).default(1).describe('1-based page number. Default 1.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Appointments per page (1–100). Default 20.'),
        view: viewArg(),
      }),
    },
    async ({ when, page, page_size, view }) => {
      const raw = await client.listAppointments(when, { pageSize: page_size, currentPage: page });
      return viewResponse(view, raw, (data) => {
        const current = asRecord(asRecord(data).currentAppointment);
        if (!Array.isArray(current.Appointment)) return undefined;
        return {
          total: current.TotalRows,
          appointments: asRecordArray(current.Appointment).map((a) =>
            tidy({
              visitId: a.VisitID,
              date: a.VisitDate,
              start: a.StartTime,
              end: a.EndTime,
              provider: a.Provider,
              facility: a.FacilityName,
              type: a.VisitType,
              status: a.VisitStatus,
              expectedCopay: a.ExpectedCopay,
            }),
          ),
        };
      });
    },
  );

  server.registerTool(
    'insync_get_appointment_calendar',
    {
      description:
        'Get the monthly appointment calendar — the day, time slot and label of each ' +
        'scheduled visit in a date range. Defaults to the current month when no range is given.',
      annotations: READ,
      inputSchema: z.object({
        from: ISO_DATE.optional().describe(
          'Range start (ISO YYYY-MM-DD). Defaults to the first day of the current month.',
        ),
        to: ISO_DATE.optional().describe(
          'Range end (ISO YYYY-MM-DD). Defaults to the last day of the current month.',
        ),
        view: viewArg(),
      }),
    },
    async ({ from, to, view }) => {
      const month = monthRange(todayIso());
      const fromIso = from ?? month.from;
      const toIso = to ?? month.to;
      const raw = await client.getAppointmentCalendar(isoToMdy(fromIso), isoToMdy(toIso));
      return viewResponse(view, raw, (data) => {
        const appointments = asRecord(data).appointments;
        if (!Array.isArray(appointments)) return undefined;
        return {
          total: asRecord(data).totalCount,
          appointments: asRecordArray(appointments).map((a) =>
            tidy({
              date: a.VisitDate,
              time: a.TimeSlab,
              label: a.AppText,
              visitId: a.VisitID,
            }),
          ),
        };
      });
    },
  );
}
