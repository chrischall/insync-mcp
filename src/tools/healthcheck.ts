import type { McpServer } from '@modelcontextprotocol/server';
import { registerAdaptiveHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import type { InsyncClient } from '../client.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

export interface InsyncHealthcheckArms {
  /** Present only when relaying through the browser bridge. */
  bridge: FetchproxyTransport | undefined;
  /** Whether server-side credentials are configured (drives the credential arm). */
  credentialsConfigured: boolean;
}

/**
 * ONE `insync_healthcheck`, answering from whichever transport is carrying
 * requests. The credential arm probes `Dashboard/GetDashBoradCount`; the bridge
 * arm round-trips the signed-in `Dashboard` page through the user's tab. The
 * probe is skipped when no credential resolves.
 */
export function registerInsyncHealthcheckTool(
  server: McpServer,
  client: InsyncClient,
  hostLabel: string,
  arms: InsyncHealthcheckArms,
): void {
  const { bridge, credentialsConfigured } = arms;
  registerAdaptiveHealthcheckTool({
    server,
    prefix: 'insync',
    hostLabel,
    usingBridge: () => bridge !== undefined,
    bridge: {
      probePath: 'Dashboard',
      transport: () => bridge as FetchproxyTransport,
      probeFn: (path) => client.pageText(path),
    },
    credential: {
      probePath: '/Dashboard',
      resolveCredential: async () =>
        credentialsConfigured ? { source: 'env', detail: { transport: 'server' } } : { source: null },
      probeFn: async () => {
        await client.getCounts();
      },
      hints: {
        session_expired:
          `${hostLabel} has no live session yet. A read tool signs in with ` +
          'INSYNC_USERNAME / INSYNC_PASSWORD on first use; run one and retry.',
        credential_rejected:
          `${hostLabel} refused the username and password. Check INSYNC_USERNAME and ` +
          'INSYNC_PASSWORD — nothing retries automatically, because the portal counts failed ' +
          'sign-ins toward a lockout.',
      },
    },
  });
}
