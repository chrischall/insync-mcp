import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { InsyncClient } from '../src/client.js';
import type { FetchResult, InsyncTransport } from '../src/transport.js';
import { registerAppointmentTools } from '../src/tools/appointments.js';
import { registerClinicalTools } from '../src/tools/clinical.js';
import { registerDashboardTools } from '../src/tools/dashboard.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerInsyncHealthcheckTool } from '../src/tools/healthcheck.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerProfileTools } from '../src/tools/profile.js';

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
    expect(await servedTools()).toHaveLength(14);
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
    // insync_get_message is the one write among these: opening an unread
    // message marks it read, which the practice sees and which cannot be undone.
    const writes = tools
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => [t.name, t.annotations?.destructiveHint])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(writes).toEqual([['insync_get_message', true]]);

    const contradictory = tools
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });
});
