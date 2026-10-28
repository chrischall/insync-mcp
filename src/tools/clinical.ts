import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { parse } from 'node-html-parser';
import type { InsyncClient, MedicationStatus } from '../client.js';
import { READ, asRecord, asRecordArray, cleanCellText, tidy } from './_shared.js';
import { assembledViewArg, assembledViewResponse, viewArg, viewResponse } from '../view.js';

/**
 * Parse the refill-history grid HTML into rows. Column headers (when the grid
 * renders a `<thead>`) key each row; otherwise a row is the list of its cell
 * texts. Reads cell TEXT only, never attributes, so no onclick/href is surfaced.
 */
export function parseRefillGrid(html: string): (Record<string, string> | string[])[] {
  const root = parse(html);
  const headers = root
    .querySelectorAll('thead th')
    .map((th) => cleanCellText(th.text))
    .filter((h) => h !== '');
  const bodyRows = root.querySelectorAll('tbody tr');
  const trs = bodyRows.length > 0 ? bodyRows : root.querySelectorAll('tr');
  const rows: (Record<string, string> | string[])[] = [];
  for (const tr of trs) {
    const cells = tr.querySelectorAll('td');
    if (cells.length === 0) continue;
    const texts = cells.map((td) => cleanCellText(td.text));
    if (headers.length === texts.length) {
      rows.push(Object.fromEntries(headers.map((h, i) => [h, texts[i]])));
    } else {
      rows.push(texts);
    }
  }
  return rows;
}

export function registerClinicalTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_list_medications',
    {
      description:
        'List prescriptions / medications on file — drug name, dispense, quantity, ' +
        'refills remaining, days supply, prescription date and prescriber. Choose current, ' +
        'discontinued or cancelled.',
      annotations: READ,
      inputSchema: z.object({
        status: z
          .enum(['current', 'discontinued', 'cancelled'])
          .default('current')
          .describe('Which medications to list. Default current.'),
        view: viewArg(),
      }),
    },
    async ({ status, view }) => {
      const raw = await client.listMedications(status as MedicationStatus);
      return viewResponse(view, raw, (data) => {
        const rows = asRecord(data).data;
        if (!Array.isArray(rows)) return undefined;
        return {
          total: asRecord(data).recordsTotal,
          medications: asRecordArray(rows).map((m) =>
            tidy({
              name: m.DrugName,
              dispense: m.Dispense,
              quantity: m.DrugQuantity,
              refills: m.Refills,
              daysSupply: m.DaysSupply,
              prescribed: m.PrescriptionDatetxt ?? m.PrescriptionDate,
              prescriber: m.PhysicianName,
              rxcui: m.Rxcui,
            }),
          ),
        };
      });
    },
  );

  server.registerTool(
    'insync_list_allergies',
    {
      description: 'List the patient’s recorded allergies and their reactions.',
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.listAllergies();
      return viewResponse(view, raw, (data) => {
        const rows = asRecord(data).data;
        if (!Array.isArray(rows)) return undefined;
        return { total: asRecord(data).recordsTotal, allergies: rows };
      });
    },
  );

  server.registerTool(
    'insync_list_refill_requests',
    {
      description:
        'List the patient’s prescription refill-request history — the rows of the ' +
        'refill grid (status and dates per request). Does NOT submit a refill request.',
      annotations: READ,
      inputSchema: z.object({ view: assembledViewArg() }),
    },
    async ({ view }) => {
      const html = await client.listRefillRequests();
      return assembledViewResponse(view, { requests: parseRefillGrid(html) });
    },
  );
}
