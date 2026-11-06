// Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
// asserted against the SERVED tool list — what a host reads — plus the brief
// view the three canonical reads answer.
//
// Every fixture is synthetic: invented names, ids and dates.
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { InsyncClient } from '../src/client.js';
import { registerAppointmentTools } from '../src/tools/appointments.js';
import { registerClinicalTools } from '../src/tools/clinical.js';
import { registerComposeTools } from '../src/tools/compose.js';
import { registerDashboardTools } from '../src/tools/dashboard.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerDownloadTools } from '../src/tools/downloads.js';
import { registerInsyncHealthcheckTool } from '../src/tools/healthcheck.js';
import { withToolMeta } from '../src/tools/hints.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerProfileTools } from '../src/tools/profile.js';
import { registerRefillTools } from '../src/tools/refills.js';
import { registerSchedulingTools } from '../src/tools/scheduling.js';
import { registerUploadTools } from '../src/tools/uploads.js';
import { briefLine, briefNotes, mdyToIso } from '../src/view.js';
import { formBrief } from '../src/tools/documents.js';
import { FakeTransport, okJson, stubDownloadIO, stubTransport, type FakeCall } from './_tools.js';

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, Record<string, unknown>> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const WHATS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  insync_get_counts: 'whats-new',
  insync_get_balance: 'whats-due',
  insync_list_appointments: 'whats-on',
  insync_get_appointment_calendar: 'whats-on',
  insync_list_medications: 'lookup',
  insync_list_allergies: 'lookup',
  insync_list_refill_requests: 'lookup',
  insync_list_messages: 'whats-new',
  insync_get_message: 'lookup',
  insync_list_forms: 'whats-due',
  insync_list_surveys: 'whats-due',
  insync_list_documents: 'lookup',
  insync_get_profile: 'lookup',
  insync_list_attachments: 'lookup',
  insync_download_attachment: 'other',
  insync_download_document: 'other',
  insync_upload_insurance_card: 'send',
  insync_upload_slots: 'other',
  insync_list_message_recipients: 'lookup',
  insync_send_message: 'send',
  insync_reply_message: 'send',
  insync_get_refill_options: 'lookup',
  insync_request_refill: 'send',
  insync_find_appointment_slots: 'lookup',
  insync_request_appointment: 'change',
  insync_cancel_appointment: 'change',
};

const CANONICAL: Record<string, string> = {
  'whats-on': 'insync_list_appointments',
  'whats-new': 'insync_list_messages',
  'whats-due': 'insync_list_forms',
};

const BRIEF_LINE = /^.+ — (?:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?|no date) — [a-z][a-z ]*$/;

async function served(): Promise<Listed[]> {
  const client = new InsyncClient({ transport: stubTransport });
  const h = await createTestHarness((server) => {
    registerDashboardTools(server, client);
    registerAppointmentTools(server, client);
    registerClinicalTools(server, client);
    registerMessageTools(server, client);
    registerDocumentTools(server, client);
    registerProfileTools(server, client);
    registerDownloadTools(server, client, stubDownloadIO);
    registerUploadTools(server, client, { allowedRoots: 'unconfined' });
    registerComposeTools(server, client);
    registerRefillTools(server, client);
    registerSchedulingTools(server, client);
    registerInsyncHealthcheckTool(server, client, 'example.insynchcs.com', {
      bridge: undefined,
      credentialsConfigured: true,
    });
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

describe('_meta.mint on tools/list', () => {
  it('every tool except the healthcheck declares domain health and the intent in the table', async () => {
    const tools = await served();
    const named = tools.filter((t) => t.name !== 'insync_healthcheck').map((t) => t.name).sort();
    expect(named).toEqual(Object.keys(EXPECTED_INTENT).sort());
    for (const t of tools) {
      if (t.name === 'insync_healthcheck') continue; // registered by mcp-utils, which takes no _meta
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).every((k) => KEYS.includes(k)), t.name).toBe(true);
      expect(DOMAINS).toContain(m!.domain);
      expect(m!.domain, t.name).toBe('health');
      expect(INTENTS).toContain(m!.intent);
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('canonical only on read-only whats-* reads, at most one per intent, and exactly the chosen three', async () => {
    const tools = await served();
    const canonical = tools.filter((t) => t._meta?.mint?.canonical !== undefined);
    for (const t of canonical) {
      expect(t._meta!.mint!.canonical, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(WHATS, t.name).toContain(t._meta!.mint!.intent);
    }
    for (const intent of WHATS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).map((t) => t.name)).toEqual([CANONICAL[intent]]);
    }
  });

  it('aliases are ≤ 8 lowercase words ≤ 40 chars; subject and when name real arguments', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      if (m === undefined) continue;
      const aliases = m.aliases as string[] | undefined;
      if (aliases !== undefined) {
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^insync_/);
        }
      }
      if (m.subject !== undefined) expect(t.inputSchema.properties, t.name).toHaveProperty(m.subject as string);
      if (m.when !== undefined) {
        const w = m.when as { start: string; end: string };
        expect(t.inputSchema.properties, t.name).toHaveProperty(w.start);
        expect(t.inputSchema.properties, t.name).toHaveProperty(w.end);
      }
    }
  });

  it('declares no subject: one portal login is one patient, with nothing to list at start', async () => {
    for (const t of await served()) expect(t._meta?.mint?.subject, t.name).toBeUndefined();
  });

  it('each canonical read offers view "brief"', async () => {
    const tools = await served();
    for (const name of Object.values(CANONICAL)) {
      const view = tools.find((t) => t.name === name)!.inputSchema.properties!.view as { enum?: string[] };
      expect(view.enum, name).toContain('brief');
    }
  });
});

describe('withToolMeta', () => {
  it('restores registerTool even when the registration throws', () => {
    const own = () => undefined;
    const server = { registerTool: own };
    expect(() =>
      withToolMeta(server as never, { mint: {} }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(server.registerTool).toBe(own);
  });

  it('removes the patch when registerTool came from the prototype', () => {
    class S {
      registerTool(): void {}
    }
    const server = new S();
    withToolMeta(server as never, { mint: {} }, () => undefined);
    expect(Object.prototype.hasOwnProperty.call(server, 'registerTool')).toBe(false);
  });
});

describe('brief helpers', () => {
  it('mdyToIso turns the portal’s US dates into ISO, with or without a time', () => {
    expect(mdyToIso('11/03/2026')).toBe('2026-11-03');
    expect(mdyToIso('11/03/2026', '10:00 AM')).toBe('2026-11-03T10:00');
    expect(mdyToIso('11/03/2026', '12:15 AM')).toBe('2026-11-03T00:15');
    expect(mdyToIso('11/03/2026', '12:15 PM')).toBe('2026-11-03T12:15');
    expect(mdyToIso('10/20/2026 09:30 PM')).toBe('2026-10-20T21:30');
    expect(mdyToIso('1/2/2026')).toBe('2026-01-02');
    expect(mdyToIso('11/03/2026', 'soon')).toBe('2026-11-03');
    expect(mdyToIso('Oct 20, 2026')).toBe('no date');
    expect(mdyToIso(undefined)).toBe('no date');
    expect(mdyToIso('')).toBe('no date');
  });

  it('briefLine keeps the line within 120 chars and the status lowercase', () => {
    const line = briefLine('x'.repeat(300), '2026-11-03', 'Check In');
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(BRIEF_LINE);
    expect(line.endsWith(' — 2026-11-03 — check in')).toBe(true);
    expect(briefLine('A', 'no date', '')).toBe('A — no date — unknown');
    expect(briefLine('A', 'no date', '!!')).toBe('A — no date — unknown');
  });

  it('briefLine cuts the WHOLE line to 120 chars, title first, even when the status alone would overflow', () => {
    const status = 'awaiting '.repeat(30);
    const line = briefLine('Intake packet', '2026-11-03', status);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith('Intake packet — 2026-11-03 — awaiting')).toBe(true);
    const both = briefLine('t'.repeat(300), '2026-11-03T10:00', status);
    expect(both.length).toBeLessThanOrEqual(120);
    expect(both).toContain(' — 2026-11-03T10:00 — awaiting');
    expect(both.startsWith('t')).toBe(true);
  });

  it('briefLine escapes a title that starts with "-- " or "\\" with one leading backslash', () => {
    expect(briefLine('-- none', 'no date', 'sent')).toBe('\\-- none — no date — sent');
    expect(briefLine('\\share', 'no date', 'sent')).toBe('\\\\share — no date — sent');
    expect(briefLine('--none', 'no date', 'sent')).toBe('--none — no date — sent');
    const long = briefLine(`-- ${'x'.repeat(300)}`, 'no date', 'sent');
    expect(long.startsWith('\\-- x')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(120);
  });
});

describe('briefNotes', () => {
  it('says none, N of M, more, or nothing', () => {
    expect(briefNotes(0, 0, 20)).toEqual(['-- none']);
    expect(briefNotes(1, '3', 5)).toEqual(['-- 1 of 3 shown']);
    expect(briefNotes(2, 2, 2)).toEqual([]);
    expect(briefNotes(1, undefined, 5)).toEqual([]);
    expect(briefNotes(1, null, 1)).toEqual(['-- more']);
    expect(briefNotes(1, '', 1)).toEqual(['-- more']);
    expect(briefNotes(1, 'many', 1)).toEqual(['-- more']);
  });
});

describe('formBrief', () => {
  it('reads a non-string status as unknown', () => {
    expect(formBrief({ FormName: 'Consent', Status: 3 })).toBe('Consent — no date — unknown');
  });
});

// ── the brief view on each canonical read ───────────────────────────────────

type Envelope = { untrusted_content: boolean; note: string; data: string[] };

/** Call one tool THROUGH the served schema (so defaults apply) with view "brief". */
async function brief(
  register: (server: never, client: InsyncClient) => void,
  name: string,
  args: Record<string, unknown>,
  responder: (c: FakeCall) => ReturnType<typeof okJson>,
): Promise<Envelope> {
  const client = new InsyncClient({ transport: new FakeTransport(responder) });
  const h = await createTestHarness((server) => register(server as never, client));
  const res = (await h.client.callTool({ name, arguments: { ...args, view: 'brief' } })) as {
    content: { text: string }[];
  };
  await h.close();
  return JSON.parse(res.content[0]!.text) as Envelope;
}

function expectBriefLines(env: Envelope) {
  expect(env.untrusted_content).toBe(true);
  expect(env.note).toMatch(/practice/);
  expect(Array.isArray(env.data)).toBe(true);
  for (const line of env.data) {
    expect(line.length).toBeLessThanOrEqual(120);
    if (!line.startsWith('-- ')) expect(line).toMatch(BRIEF_LINE);
  }
}

const VISIT = {
  VisitID: 'V1',
  VisitDate: '11/03/2026',
  StartTime: '10:00 AM',
  Provider: 'Dr. Test Provider',
  FacilityName: 'Example Clinic',
  VisitType: 'Therapy',
  VisitStatus: 'Check In',
};

describe('insync_list_appointments view brief', () => {
  it('answers one enveloped line per visit', async () => {
    const env = await brief(registerAppointmentTools, 'insync_list_appointments', {}, () =>
      okJson({ currentAppointment: { TotalRows: 2, Appointment: [VISIT, { VisitID: 'V2' }] } }),
    );
    expectBriefLines(env);
    expect(env.data).toEqual([
      'Therapy with Dr. Test Provider at Example Clinic — 2026-11-03T10:00 — check in',
      'Appointment — no date — scheduled',
    ]);
  });

  it('notes a partial page', async () => {
    const env = await brief(registerAppointmentTools, 'insync_list_appointments', { page_size: 1 }, () =>
      okJson({ currentAppointment: { TotalRows: 5, Appointment: [VISIT] } }),
    );
    expectBriefLines(env);
    expect(env.data.at(-1)).toBe('-- 1 of 5 shown');
  });

  it('notes "-- more" when the page is full and the total is unknown', async () => {
    const env = await brief(registerAppointmentTools, 'insync_list_appointments', { page_size: 1 }, () =>
      okJson({ currentAppointment: { Appointment: [VISIT] } }),
    );
    expect(env.data.at(-1)).toBe('-- more');
  });

  it('notes an empty result', async () => {
    const env = await brief(registerAppointmentTools, 'insync_list_appointments', { when: 'past' }, () =>
      okJson({ currentAppointment: { TotalRows: 0, Appointment: [] } }),
    );
    expect(env.data).toEqual(['-- none']);
    const odd = await brief(registerAppointmentTools, 'insync_list_appointments', {}, () => okJson({}));
    expect(odd.data).toEqual(['-- none']);
  });
});

const MESSAGE = {
  TODOChildId: 'C1',
  TODOMasterId: 'M1',
  GroupName: 'Example Clinic',
  ToGroupName: 'Pat Example',
  TaskSubject: 'Your appointment reminder',
  ReminderDateText: '10/20/2026 09:00 AM',
  IsFromPatient: false,
};

describe('insync_list_messages view brief', () => {
  it('answers one enveloped line per message, the folder as its status', async () => {
    const env = await brief(registerMessageTools, 'insync_list_messages', {}, () =>
      okJson({ recordsTotal: 1, data: [MESSAGE] }),
    );
    expectBriefLines(env);
    expect(env.data).toEqual(['Your appointment reminder (from Example Clinic) — 2026-10-20T09:00 — unread']);
  });

  it('escapes a subject that would read as a note line', async () => {
    const env = await brief(registerMessageTools, 'insync_list_messages', {}, () =>
      okJson({ recordsTotal: 1, data: [{ ...MESSAGE, TaskSubject: '-- none' }] }),
    );
    expect(env.data).toEqual(['\\-- none (from Example Clinic) — 2026-10-20T09:00 — unread']);
  });

  it('names the recipient on a sent message, and copes with a missing subject', async () => {
    const env = await brief(registerMessageTools, 'insync_list_messages', { folder: 'sent' }, () =>
      okJson({ recordsTotal: 1, data: [{ ...MESSAGE, IsFromPatient: true }, { IsFromPatient: true }] }),
    );
    expectBriefLines(env);
    expect(env.data).toEqual([
      'Your appointment reminder (to Pat Example) — 2026-10-20T09:00 — sent',
      'Message — no date — sent',
    ]);
  });

  it('notes a partial page and an empty folder', async () => {
    const partial = await brief(registerMessageTools, 'insync_list_messages', {}, () =>
      okJson({ recordsTotal: 40, data: [MESSAGE] }),
    );
    expect(partial.data.at(-1)).toBe('-- 1 of 40 shown');
    const none = await brief(registerMessageTools, 'insync_list_messages', {}, () => okJson({ recordsTotal: 0, data: [] }));
    expect(none.data).toEqual(['-- none']);
  });
});

describe('insync_list_forms view brief', () => {
  const FORMS = {
    PatientFormcollection: [
      { FormName: 'Intake Questionnaire', Status: 'Sent', SentOn: '10/01/2026', PatientUserPassword: 'HASH' },
      { FormName: 'Consent', Status: 'Received', ReceivedOn: '09/01/2026' },
    ],
  };

  it('answers one enveloped line per pending form by default, never a secret field', async () => {
    const env = await brief(registerDocumentTools, 'insync_list_forms', {}, () => okJson(FORMS));
    expectBriefLines(env);
    expect(env.data).toEqual(['Intake Questionnaire — 2026-10-01 — to complete']);
    expect(JSON.stringify(env)).not.toContain('HASH');
  });

  it('covers every form on status all', async () => {
    const env = await brief(registerDocumentTools, 'insync_list_forms', { status: 'all' }, () =>
      okJson({ PatientFormcollection: [...FORMS.PatientFormcollection, { Status: '' }] }),
    );
    expectBriefLines(env);
    expect(env.data).toEqual([
      'Intake Questionnaire — 2026-10-01 — to complete',
      'Consent — 2026-09-01 — received',
      'Form — no date — unknown',
    ]);
  });

  it('notes an empty result', async () => {
    const env = await brief(registerDocumentTools, 'insync_list_forms', {}, () => okJson({ PatientFormcollection: [] }));
    expect(env.data).toEqual(['-- none']);
  });
});
