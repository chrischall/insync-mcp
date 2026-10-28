#!/usr/bin/env node
// insync-mcp — READ-ONLY access to an InSync Healthcare (Qualifacts) patient
// portal (https://<practice>intouch.insynchcs.com).
//
// Scaffold stub: the transports, client and read tools are wired in later.

import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';

await runMcp({
  name: 'insync-mcp',
  version: VERSION,
  banner:
    `[insync-mcp] v${VERSION} — read-only InSync patient portal. ` +
    'This project was developed and is maintained by AI. Use at your own discretion.',
  deps: undefined,
  tools: [],
});
