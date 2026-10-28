#!/usr/bin/env node
// insync-mcp — InSync Healthcare (Qualifacts) patient portal.
//
// Two transports, chosen by what is configured:
//
//   * credentials set  → bridge-less. Signs in server-side with a cookie jar.
//     No browser, no extension, and therefore hostable.
//   * otherwise        → the fetchproxy bridge, relaying through the user's
//     signed-in portal tab. Holds no credentials at all.
//
// NOT read-only: alongside the reads and portal-file downloads it sends secure
// messages, refill requests, appointment requests and cancellation requests,
// and uploads an insurance card (all confirm-gated); opening an unread message
// can also mark it read. The S3 creds the login carries are held server-side
// and never emitted.

import { loadDotenvSafely, readEnvVar, readPortEnv, requireEnvVar, runMcp } from '@chrischall/mcp-utils';
import { InsyncClient, type TransportMode } from './client.js';
import { makeDownloadIO } from './download-io.js';
import { SecretScrubber } from './secrets.js';
import { registerAppointmentTools } from './tools/appointments.js';
import { registerClinicalTools } from './tools/clinical.js';
import { registerDashboardTools } from './tools/dashboard.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerDownloadTools } from './tools/downloads.js';
import { registerInsyncHealthcheckTool } from './tools/healthcheck.js';
import { registerMessageTools } from './tools/messages.js';
import { registerProfileTools } from './tools/profile.js';
import { registerUploadTools, uploadRoots } from './tools/uploads.js';
import { registerComposeTools } from './tools/compose.js';
import { registerRefillTools } from './tools/refills.js';
import { registerSchedulingTools } from './tools/scheduling.js';
import { DEFAULT_PORT, FetchproxyTransport } from './transport-fetchproxy.js';
import { ServerTransport } from './transport-server.js';
import { parsePortal, type InsyncTransport } from './transport.js';
import { VERSION } from './version.js';

await loadDotenvSafely({});

// INSYNC_PORTAL is mandatory — the portal is per-practice, so without it there
// is no host to talk to. requireEnvVar throws a value-free error at boot rather
// than letting parsePortal fail later.
const portalRaw = requireEnvVar('INSYNC_PORTAL', {
  hint: 'Set INSYNC_PORTAL to your practice portal, e.g. https://pfbhintouch.insynchcs.com (scheme + host only, no path).',
});
const username = readEnvVar('INSYNC_USERNAME');
// The password may legitimately contain leading/trailing whitespace.
const password = readEnvVar('INSYNC_PASSWORD', { trim: false });
const credentialsConfigured = username !== undefined && password !== undefined;

// server when both creds are set, else fetchproxy — unless INSYNC_TRANSPORT
// forces one.
const forced = readEnvVar('INSYNC_TRANSPORT');
const mode: TransportMode =
  forced === 'server' || forced === 'fetchproxy'
    ? forced
    : credentialsConfigured
      ? 'server'
      : 'fetchproxy';

const { subdomain, host } = parsePortal(portalRaw);
const scrubber = new SecretScrubber();
const port = readPortEnv('INSYNC_WS_PORT', DEFAULT_PORT);

let transport: InsyncTransport;
let bridge: FetchproxyTransport | undefined;

if (mode === 'server') {
  transport = new ServerTransport({ portal: portalRaw, username, password, scrubber });
} else {
  bridge = new FetchproxyTransport({ subdomain, version: VERSION });
  transport = bridge;
  await bridge.start();
}

const client = new InsyncClient({ transport, scrubber, mode, portalHost: host });
const downloadIO = makeDownloadIO();

await runMcp({
  name: 'insync-mcp',
  version: VERSION,
  banner:
    mode === 'server'
      ? `[insync-mcp] v${VERSION} — bridge-less sign-in to ${host} as the configured account. ` +
        'No browser required. This project was developed and is maintained by AI. Use at your own discretion.'
      : `[insync-mcp] v${VERSION} — InSync via @fetchproxy/server on 127.0.0.1:${port}. ` +
        `Requests relay through your signed-in ${host} tab; the session cookie is never read. ` +
        'This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [
    (server) => registerDashboardTools(server, client),
    (server) => registerAppointmentTools(server, client),
    (server) => registerClinicalTools(server, client),
    (server) => registerMessageTools(server, client),
    (server) => registerDocumentTools(server, client),
    (server) => registerProfileTools(server, client),
    (server) => registerDownloadTools(server, client, downloadIO),
    (server) => registerUploadTools(server, client, { allowedRoots: uploadRoots() }),
    (server) => registerComposeTools(server, client),
    (server) => registerRefillTools(server, client),
    (server) => registerSchedulingTools(server, client),
    (server) => registerInsyncHealthcheckTool(server, client, host, { bridge, credentialsConfigured }),
  ],
});
