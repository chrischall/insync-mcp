// Shared test rig for the read tools: a FakeTransport that answers by path, and
// a `capture` that registers a tool module on a stub server and hands back the
// tool handlers plus the transport (to assert which calls were made).
import { vi } from 'vitest';
import { createBlobStore, mintUploadSlot, type BlobStore } from '@chrischall/mcp-utils/export';
import { InsyncClient } from '../src/client.js';
import type {
  BinaryFetchResult,
  FetchResult,
  InsyncTransport,
  RequestOptions,
  S3Config,
} from '../src/transport.js';
import type { DownloadIO } from '../src/download-io.js';
import { registerAppointmentTools } from '../src/tools/appointments.js';
import { registerClinicalTools } from '../src/tools/clinical.js';
import { registerDashboardTools } from '../src/tools/dashboard.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerDownloadTools } from '../src/tools/downloads.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerProfileTools } from '../src/tools/profile.js';
import { registerUploadTools } from '../src/tools/uploads.js';
import { registerComposeTools } from '../src/tools/compose.js';
import { registerRefillTools } from '../src/tools/refills.js';
import { registerSchedulingTools } from '../src/tools/scheduling.js';

export interface FakeCall {
  verb: 'getJson' | 'postJson' | 'postForm' | 'getText' | 'postText' | 'getBinary' | 'postBinary';
  path: string;
  body?: unknown;
  opts?: RequestOptions;
}

export class FakeTransport implements InsyncTransport {
  calls: FakeCall[] = [];
  constructor(
    private readonly responder: (call: FakeCall) => FetchResult,
    private readonly binaryResponder?: (call: FakeCall) => BinaryFetchResult,
  ) {}
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
  private recBinary(call: FakeCall): Promise<BinaryFetchResult> {
    this.calls.push(call);
    if (this.binaryResponder === undefined) throw new Error('no binaryResponder');
    return Promise.resolve(this.binaryResponder(call));
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
  getBinary(path: string, opts?: RequestOptions) {
    return this.recBinary({ verb: 'getBinary', path, opts });
  }
  postBinary(path: string, body: unknown, opts?: RequestOptions) {
    return this.recBinary({ verb: 'postBinary', path, body, opts });
  }
}

export const okJson = (value: unknown): FetchResult => ({ status: 200, body: JSON.stringify(value) });
export const okText = (body: string): FetchResult => ({ status: 200, body });

export type ToolResult = { content: { text: string }[]; isError?: boolean };
export type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<ToolResult>;

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

/**
 * A request context from a client WITHOUT MCP elicitation, so a confirm-gated
 * write takes the two-phase preview → confirmToken path.
 */
export function writeCtx(): unknown {
  return {
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { extensions: {} },
      },
      inputResponses: undefined,
      requestState: () => undefined,
    },
  };
}

/**
 * Drive a confirm-gated tool: `preview` is phase 1; `confirmed` previews, clears
 * the recorded calls, then repeats the call with the issued token.
 */
export function gated(fn: Handler, transport: FakeTransport) {
  return {
    preview: async (args: Record<string, unknown>) => jsonOf(await fn(args, writeCtx())),
    raw: (args: Record<string, unknown>) => fn(args, writeCtx()),
    confirmed: async (args: Record<string, unknown>) => {
      const preview = jsonOf(await fn(args, writeCtx()));
      transport.calls.length = 0;
      return fn({ ...args, confirmToken: preview.confirmToken as string }, writeCtx());
    },
  };
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
  getBinary: async () => ({ status: 200, body: '', bytes: new Uint8Array() }),
  postBinary: async () => ({ status: 200, body: '', bytes: new Uint8Array() }),
};

/** A disk-persisting DownloadIO stub for registration-only tests. */
export const stubDownloadIO: DownloadIO = {
  deliver: async (args) => ({
    via: 'disk',
    fileName: args.fileName,
    mimeType: args.mimeType,
    size: args.bytes.length,
    content: [],
  }),
};

/** The fake blob store's base URL (`MCP_BLOB_BASE_URL` shape). Synthetic. */
export const BLOB_BASE = 'https://host.example/b/reg_0123456789abcdef01234567';

/** One request the fake blob store saw. */
export interface BlobCall {
  method: string;
  key: string;
}

/**
 * A real mcp-utils blob store whose objects live in a map, behind a stubbed
 * global fetch (restore with `vi.unstubAllGlobals()`). `putUpload` stands in
 * for the caller's curl to an upload slot; `deleteStatus` makes DELETE fail.
 */
export function fakeBlobStore(opts: { deleteStatus?: number } = {}): {
  store: BlobStore;
  objects: Map<string, { bytes: Uint8Array; type: string }>;
  calls: BlobCall[];
  putUpload: (filename: string, bytes: Uint8Array) => string;
} {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const calls: BlobCall[] = [];
  const prefix = new URL(BLOB_BASE).pathname + '/';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.slice(prefix.length));
      const method = init?.method ?? 'GET';
      calls.push({ method, key });
      if (method === 'PUT') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        objects.set(key, {
          bytes: new Uint8Array(init!.body as ArrayBuffer),
          type: headers['content-type'] ?? 'application/octet-stream',
        });
        return new Response(null, { status: 200 });
      }
      if (method === 'DELETE') {
        if (opts.deleteStatus !== undefined) return new Response('', { status: opts.deleteStatus });
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const o = objects.get(key);
      return o
        ? new Response(o.bytes.slice(), { headers: { 'content-type': o.type } })
        : new Response('', { status: 404 });
    }),
  );
  const store = createBlobStore({ baseUrl: BLOB_BASE, signingKey: 'a2V5' });
  const putUpload = (filename: string, bytes: Uint8Array): string => {
    const slot = mintUploadSlot(store, { filename });
    objects.set(slot.blobKey, { bytes, type: slot.mimeType });
    return slot.blobKey;
  };
  return { store, objects, calls, putUpload };
}

/** The names every read/download module registers (healthcheck needs the concrete deps). */
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
  registerDownloadTools(server, client, stubDownloadIO);
  registerUploadTools(server, client, { allowedRoots: 'unconfined' });
  registerComposeTools(server, client);
  registerRefillTools(server, client);
  registerSchedulingTools(server, client);
  return names;
}
