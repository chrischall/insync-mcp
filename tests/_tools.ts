// Shared test rig for the read tools: a FakeTransport that answers by path, and
// a `capture` that registers a tool module on a stub server and hands back the
// tool handlers plus the transport (to assert which calls were made).
import { InsyncClient } from '../src/client.js';
import type { FetchResult, InsyncTransport, RequestOptions, S3Config } from '../src/transport.js';
import { registerAppointmentTools } from '../src/tools/appointments.js';
import { registerClinicalTools } from '../src/tools/clinical.js';
import { registerDashboardTools } from '../src/tools/dashboard.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerProfileTools } from '../src/tools/profile.js';

export interface FakeCall {
  verb: 'getJson' | 'postJson' | 'postForm' | 'getText' | 'postText';
  path: string;
  body?: unknown;
  opts?: RequestOptions;
}

export class FakeTransport implements InsyncTransport {
  calls: FakeCall[] = [];
  constructor(private readonly responder: (call: FakeCall) => FetchResult) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  status(): unknown {
    return {};
  }
  getS3Config(): S3Config | undefined {
    return undefined;
  }
  private rec(call: FakeCall): Promise<FetchResult> {
    this.calls.push(call);
    return Promise.resolve(this.responder(call));
  }
  getJson(path: string, opts?: RequestOptions) {
    return this.rec({ verb: 'getJson', path, opts });
  }
  postJson(path: string, body: unknown, opts?: RequestOptions) {
    return this.rec({ verb: 'postJson', path, body, opts });
  }
  postForm(path: string, body: Record<string, string> | URLSearchParams, opts?: RequestOptions) {
    return this.rec({ verb: 'postForm', path, body, opts });
  }
  getText(path: string, opts?: RequestOptions) {
    return this.rec({ verb: 'getText', path, opts });
  }
  postText(path: string, body: string, opts?: RequestOptions) {
    return this.rec({ verb: 'postText', path, body, opts });
  }
}

export const okJson = (value: unknown): FetchResult => ({ status: 200, body: JSON.stringify(value) });
export const okText = (body: string): FetchResult => ({ status: 200, body });

export type ToolResult = { content: { text: string }[]; isError?: boolean };
export type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Register a tool module and return its handlers keyed by tool name. */
export function capture(
  register: (server: unknown, client: InsyncClient) => void,
  responder: (call: FakeCall) => FetchResult,
): { handlers: Map<string, Handler>; transport: FakeTransport; client: InsyncClient } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, fn: Handler) => handlers.set(name, fn),
  };
  const transport = new FakeTransport(responder);
  const client = new InsyncClient({ transport });
  register(server, client);
  return { handlers, transport, client };
}

/** The text of a tool result's first content block. */
export function textOf(res: ToolResult): string {
  return res.content[0]!.text;
}

/** Parse a tool result as JSON. */
export function jsonOf(res: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(res)) as Record<string, unknown>;
}

/** A no-op transport for registration-only tests (no call reaches the network). */
export const stubTransport: InsyncTransport = {
  start: async () => {},
  close: async () => {},
  status: () => ({}),
  getS3Config: () => undefined,
  getJson: async () => ({ status: 200, body: '{}' }),
  postJson: async () => ({ status: 200, body: '{}' }),
  postForm: async () => ({ status: 200, body: '' }),
  getText: async () => ({ status: 200, body: '' }),
  postText: async () => ({ status: 200, body: '' }),
};

/** The names the six read modules register (healthcheck needs the concrete deps). */
export function readToolRoster(): string[] {
  const names: string[] = [];
  const server = { registerTool: (name: string) => names.push(name) } as unknown as Parameters<
    typeof registerDashboardTools
  >[0];
  const client = new InsyncClient({ transport: stubTransport });
  registerDashboardTools(server, client);
  registerAppointmentTools(server, client);
  registerClinicalTools(server, client);
  registerMessageTools(server, client);
  registerDocumentTools(server, client);
  registerProfileTools(server, client);
  return names;
}
