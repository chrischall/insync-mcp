import { describe, expect, it } from 'vitest';
import { CONFIRM_FLOW_SENTENCE, CONFIRM_INJECTION_RULE } from '@chrischall/mcp-utils';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { InsyncClient } from '../src/client.js';
import type { FetchResult, InsyncTransport } from '../src/transport.js';
import { registerAppointmentTools } from '../src/tools/appointments.js';
import { registerClinicalTools } from '../src/tools/clinical.js';
import { registerDashboardTools } from '../src/tools/dashboard.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerDownloadTools } from '../src/tools/downloads.js';
import { registerInsyncHealthcheckTool } from '../src/tools/healthcheck.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerProfileTools } from '../src/tools/profile.js';
import { registerUploadTools } from '../src/tools/uploads.js';
import { registerComposeTools } from '../src/tools/compose.js';
import { registerRefillTools } from '../src/tools/refills.js';
import { registerSchedulingTools } from '../src/tools/scheduling.js';
import { stubDownloadIO } from './_tools.js';

const stubTransport: InsyncTransport = {
  start: async () => {},
  close: async () => {},
  status: () => ({}),
  getS3Config: () => undefined,
  getJson: async (): Promise<FetchResult> => ({ status: 200, body: '{}' }),
  postJson: async (): Promise<FetchResult> => ({ status: 200, body: '{}' }),
  postForm: async (): Promise<FetchResult> => ({ status: 200, body: '' }),
  getText: async (): Promise<FetchResult> => ({ status: 200, body: '' }),
  postText: async (): Promise<FetchResult> => ({ status: 200, body: '' }),
  getBinary: async () => ({ status: 200, body: '', bytes: new Uint8Array() }),
  postBinary: async () => ({ status: 200, body: '', bytes: new Uint8Array() }),
};

async function servedTools() {
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
    registerInsyncHealthcheckTool(server, client, 'pfbhintouch.insynchcs.com', {
      bridge: undefined,
      credentialsConfigured: true,
    });
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools;
}

describe('tool annotations', () => {
  it('covers the whole served surface', async () => {
    expect(await servedTools()).toHaveLength(26);
  });

  it('marks every tool open-world', async () => {
    const notOpen = (await servedTools())
      .filter((t) => t.annotations?.openWorldHint !== true)
      .map((t) => t.name);
    expect(notOpen).toEqual([]);
  });

  it('sets a BOOLEAN destructiveHint on every tool this server defines', async () => {
    // insync_healthcheck is the fleet-standard tool from @chrischall/mcp-utils;
    // it is read-only and does not declare destructiveHint, and this server does
    // not own its annotations. Every tool THIS repo registers states it.
    const bad = (await servedTools())
      .filter((t) => t.name !== 'insync_healthcheck')
      .filter((t) => typeof t.annotations?.destructiveHint !== 'boolean')
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it('marks every read tool read-only and never read-and-destructive', async () => {
    const tools = await servedTools();
    // The writes: insync_get_message (opening an unread message marks it read,
    // which the practice sees and cannot be undone) and the six confirm-gated
    // writes (sends, requests, cancellation, insurance-card upload). All are
    // destructive; everything else is a read.
    const writes = tools
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => [t.name, t.annotations?.destructiveHint])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(writes).toEqual([
      ['insync_cancel_appointment', true],
      ['insync_get_message', true],
      ['insync_reply_message', true],
      ['insync_request_appointment', true],
      ['insync_request_refill', true],
      ['insync_send_message', true],
      ['insync_upload_insurance_card', true],
    ]);

    const contradictory = tools
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  it('states the confirm flow exactly once, plus the injection rule, on every gated write', async () => {
    // registerWrite appends the confirm-flow sentence itself; a tool that also
    // added it by hand would say it twice.
    const gated = (await servedTools()).filter(
      (t) => t.annotations?.readOnlyHint !== true && t.name !== 'insync_get_message',
    );
    expect(gated.map((t) => t.name)).toContain('insync_upload_insurance_card');
    const bad = gated
      .filter(
        (t) =>
          (t.description ?? '').split(CONFIRM_FLOW_SENTENCE).length !== 2 ||
          !(t.description ?? '').includes(CONFIRM_INJECTION_RULE),
      )
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });
});
