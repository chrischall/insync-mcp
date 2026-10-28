import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import { READ, asRecord } from './_shared.js';
import { assembledViewArg, assembledViewResponse } from '../view.js';

const SECRET_KEY = /pass|pwd|hash|token|secret/i;

/**
 * Reduce the ~540 KB patient-profile payload to its demographic SCALARS. Every
 * rung gets the same reduction — the payload also carries the profile photo,
 * long picklists, and password/token-shaped keys, none of which belongs in a
 * transcript. Objects and arrays (including every `*List`), the `Image`, any
 * password/hash/token key, and empty values are all dropped.
 */
export function projectProfileScalars(raw: unknown): Record<string, unknown> {
  const detail = asRecord(asRecord(raw).PatientDetail);
  if (Object.keys(detail).length === 0) {
    return {
      note: 'The portal did not return the expected PatientDetail object; see docs/INSYNC-API.md.',
      topLevelKeys: Object.keys(asRecord(raw)),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue;
    if (k === 'Image' || /List$/.test(k) || SECRET_KEY.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function registerProfileTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_get_profile',
    {
      description:
        'Get the patient’s demographic profile — name, date of birth, contact details and ' +
        'the other scalar fields on file. The profile photo, picklists and any credential-shaped ' +
        'field are never returned.',
      annotations: READ,
      inputSchema: z.object({ view: assembledViewArg() }),
    },
    async ({ view }) => {
      const raw = await client.getProfile();
      return assembledViewResponse(view, projectProfileScalars(raw));
    },
  );
}
