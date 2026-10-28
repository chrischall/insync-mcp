import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { parse } from 'node-html-parser';
import type { InsyncClient } from '../client.js';
import { READ, asRecord, asRecordArray, cleanCellText, tidy } from './_shared.js';
import {
  ASSEMBLED_VIEWS,
  PASSTHROUGH_VIEWS,
  assembledViewArg,
  untrustedViewResponse,
  viewArg,
  viewResponse,
} from '../view.js';

/**
 * Fields of a patient-form record that must NEVER leave the server, on ANY
 * rung: a login password hash, the rendered form markup/script, and the portal
 * username + a deep-link site URL. Everything else is safe to project.
 */
const FORM_SECRET_FIELDS = [
  'PatientUserPassword',
  'TemplateHTML',
  'PlainHTML',
  'TemplateScript',
  'PatientUserName',
  'InsyncSiteURl',
] as const;

/** Strip the secret/markup fields from one form record. */
export function sanitizeFormRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!(FORM_SECRET_FIELDS as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Parse the received-surveys HTML fragment into `{ name, received }` rows. Reads
 * cell TEXT only, never attributes — each row's onclick carries a sign-in
 * token that must never be surfaced.
 */
export function parseSurveyRows(html: string): { name: string; received: string }[] {
  const root = parse(html);
  const out: { name: string; received: string }[] = [];
  for (const tr of root.querySelectorAll('tr')) {
    const cells = tr.querySelectorAll('td');
    if (cells.length < 2) continue;
    const name = cleanCellText(cells[0]!.text);
    const received = cleanCellText(cells[cells.length - 1]!.text);
    if (name !== '') out.push({ name, received });
  }
  return out;
}

export function registerDocumentTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_list_forms',
    {
      description:
        'List patient intake / consent forms the practice has sent. "pending" (the default) is ' +
        'what still needs completing; "all" includes submitted ones. Form names are shown; the ' +
        'form markup and the login credentials the portal embeds are never returned.',
      annotations: READ,
      inputSchema: z.object({
        status: z
          .enum(['pending', 'all'])
          .default('pending')
          .describe('"pending" = awaiting the patient (Status "Sent"); "all" = every form. Default pending.'),
        view: viewArg(
          'compact projects each form to name, status and dates; "full" and "raw" return every ' +
            'OTHER field the portal sends for a form — never its embedded credentials or markup.',
        ),
      }),
    },
    async ({ status, view }) => {
      const raw = await client.listForms();
      const all = asRecordArray(asRecord(raw).PatientFormcollection).map(sanitizeFormRecord);
      const forms = status === 'pending' ? all.filter((f) => f.Status === 'Sent') : all;
      return untrustedViewResponse({
        view,
        views: PASSTHROUGH_VIEWS,
        data: forms,
        whoWrote: 'Form names are written by your practice.',
        context: 'PatientDocument/GetPatientFromList',
        project: (data) =>
          (data as Record<string, unknown>[]).map((f) =>
            tidy({
              name: f.FormName,
              status: f.Status,
              sentOn: f.SentOn,
              receivedOn: f.ReceivedOn,
              lastSubmittedOn: f.LastSubmittedOn,
              formId: f.SubPatientFormID,
              templateId: f.TemplateID,
            }),
          ),
      });
    },
  );

  server.registerTool(
    'insync_list_surveys',
    {
      description:
        'List patient satisfaction / outcome surveys the practice has sent, with each survey’s ' +
        'name and the date it was received.',
      annotations: READ,
      inputSchema: z.object({ view: assembledViewArg() }),
    },
    async ({ view }) => {
      const html = await client.listSurveys();
      return untrustedViewResponse({
        view,
        views: ASSEMBLED_VIEWS,
        data: parseSurveyRows(html),
        whoWrote: 'Survey names are written by your practice.',
        context: 'SurveyForms/GetReceivedSurveyForms',
      });
    },
  );

  server.registerTool(
    'insync_list_documents',
    {
      description:
        'List documents filed to the patient’s portal account. Use the download tools to ' +
        'retrieve a document’s contents.',
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.listDocuments();
      return viewResponse(view, raw, (data) => {
        const files = asRecord(data).Files;
        if (!Array.isArray(files)) return undefined;
        return files;
      });
    },
  );
}
