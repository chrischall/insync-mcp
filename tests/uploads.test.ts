import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsyncClient } from '../src/client.js';
import type { FetchResult, InsyncTransport, RequestOptions } from '../src/transport.js';
import {
  DEFAULT_UPLOAD_ROOTS,
  buildInsuranceForm,
  registerUploadTools,
  stripDataUrlPrefix,
  uploadRoots,
} from '../src/tools/uploads.js';

// Real magic bytes, so vetUploadFile's signature check passes. The pixel data is
// synthetic — no real card, no PHI.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PNG2 = Buffer.concat([PNG, Buffer.from([0x01, 0x02, 0x03, 0x04])]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

interface FakeCall {
  verb: string;
  path: string;
  body?: unknown;
  opts?: RequestOptions;
}

class FakeTransport implements InsyncTransport {
  calls: FakeCall[] = [];
  constructor(private readonly responder: (call: FakeCall) => FetchResult) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  status(): unknown {
    return {};
  }
  getS3Config() {
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
  async getBinary() {
    return { status: 200, body: '', bytes: new Uint8Array() };
  }
  async postBinary() {
    return { status: 200, body: '', bytes: new Uint8Array() };
  }
}

/** The portal's happy-path answers: a fresh anti-forgery token, then an accepted save. */
const happy = (call: FakeCall): FetchResult => {
  if (call.path.endsWith('GetAntiForgeryToken')) {
    return { status: 200, body: JSON.stringify({ success: true, formToken: 'tok-123' }) };
  }
  if (call.path.endsWith('SaveInsuranceCardImages')) {
    return { status: 200, body: JSON.stringify({ Success: true, Status: '1' }) };
  }
  return { status: 200, body: '{}' };
};

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>;

/** A client without MCP elicitation, so a write takes the two-phase token path. */
function ctx(): unknown {
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

function tool(
  responder: (c: FakeCall) => FetchResult,
  opts: { allowedRoots: readonly string[] | 'unconfined'; maxBytes?: number },
) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, fn: Handler) => handlers.set(name, fn),
  } as unknown as Parameters<typeof registerUploadTools>[0];
  const transport = new FakeTransport(responder);
  const client = new InsyncClient({ transport });
  registerUploadTools(server, client, opts);
  const fn = handlers.get('insync_upload_insurance_card')!;
  const parse = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  return {
    transport,
    once: async (args: Record<string, unknown>) => parse(await fn(args, ctx())),
    raw: (args: Record<string, unknown>) => fn(args, ctx()),
    /** Preview, then confirm with the issued token. Clears the preview's calls. */
    confirmed: async (args: Record<string, unknown>) => {
      const preview = parse(await fn(args, ctx()));
      transport.calls.length = 0;
      const confirmToken = preview.confirmToken as string;
      return parse(await fn({ ...args, confirmToken }, ctx()));
    },
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insync-up-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const write = (name: string, bytes: Buffer): string => {
  const p = join(root, name);
  writeFileSync(p, bytes);
  return p;
};

describe('pure helpers', () => {
  it('strips a data-URL prefix (and leaves raw base64 alone)', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,QUJD')).toBe('QUJD');
    expect(stripDataUrlPrefix('data:image/jpeg;base64,QUJD')).toBe('QUJD');
    expect(stripDataUrlPrefix('QUJD')).toBe('QUJD');
  });

  it('builds the SaveInsuranceCardImages form with prefix-free base64', () => {
    const form = buildInsuranceForm({ front: new Uint8Array([65, 66, 67]) });
    expect(form.FrontImage).toBe('QUJD');
    expect(form.BackImage).toBe('');
    expect(form.DocManagerImagePath).toBe('');
    expect(form.ScannerName).toBe('');
    expect(form.FrontImage).not.toMatch(/^data:/);
  });

  it('confines uploads to the user media folders, or the hosted data dir', () => {
    expect(uploadRoots({})).toEqual(DEFAULT_UPLOAD_ROOTS);
    expect(uploadRoots({ MCP_DATA_DIR: '/srv/data' })).toEqual(['/srv/data/uploads']);
    expect(uploadRoots({ MCP_DATA_DIR: '   ' })).toEqual(DEFAULT_UPLOAD_ROOTS);
  });
});

describe('insync_upload_insurance_card — the preview', () => {
  it('is the default, returns a token, and makes NO network call', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const out = await t.once({ side: 'front', front_path: write('card.png', PNG) });
    expect(out.status).toBe('confirmation-required');
    expect(typeof out.confirmToken).toBe('string');
    expect(t.transport.calls).toEqual([]);
    const preview = out.preview as Record<string, unknown>;
    expect(preview.path).toBe('PatientProfile/SaveInsuranceCardImages');
    expect(preview.willSend).toMatchObject({ files: [{ side: 'front', type: 'image/png' }] });
    // The base64 bytes are bound into the token but never shown in the preview.
    expect(JSON.stringify(preview)).not.toContain(PNG.toString('base64'));
  });

  it('refuses a missing or empty back path before touching anything', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    await expect(t.raw({ side: 'both', front_path: write('f.png', PNG) })).rejects.toThrow(/back_path/);
    await expect(t.raw({ side: 'back', back_path: '' })).rejects.toThrow(/back_path/);
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses a missing or empty front path before touching anything', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    await expect(t.raw({ side: 'front' })).rejects.toThrow(/front_path/);
    await expect(t.raw({ side: 'front', front_path: '' })).rejects.toThrow(/front_path/);
    expect(t.transport.calls).toEqual([]);
  });
});

describe('insync_upload_insurance_card — the confirmed upload', () => {
  it('fetches a token then POSTs the save, never replayed, with both sides', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const out = await t.confirmed({
      side: 'both',
      front_path: write('front.png', PNG),
      back_path: write('back.jpg', JPG),
    });
    const verbs = t.transport.calls.map((c) => `${c.verb} ${c.path}`);
    expect(verbs).toEqual([
      'getText ClinicalSummary/GetAntiForgeryToken',
      'postForm PatientProfile/SaveInsuranceCardImages',
    ]);
    const save = t.transport.calls.find((c) => c.path.endsWith('SaveInsuranceCardImages'))!;
    expect(save.opts?.replay).toBe(false);
    const body = save.body as Record<string, string>;
    expect(body.FrontImage).toBe(PNG.toString('base64'));
    expect(body.BackImage).toBe(JPG.toString('base64'));
    expect(body.__RequestVerificationToken).toBe('tok-123');
    expect(out.status).toBe('1');
    expect(out.uploaded).toHaveLength(2);
  });

  it('uploads without a token when the portal yields none, and tolerates no Status', async () => {
    // GetAntiForgeryToken answers without a formToken; the save still goes out
    // (the endpoint may not validate one) and reports success by `Success`.
    const noToken = (c: FakeCall): FetchResult =>
      c.path.endsWith('GetAntiForgeryToken')
        ? { status: 200, body: JSON.stringify({ success: false }) }
        : c.path.endsWith('SaveInsuranceCardImages')
          ? { status: 200, body: JSON.stringify({ Success: true }) }
          : happy(c);
    const t = tool(noToken, { allowedRoots: [root] });
    const out = await t.confirmed({ side: 'front', front_path: write('card.png', PNG) });
    const save = t.transport.calls.find((c) => c.path.endsWith('SaveInsuranceCardImages'))!;
    expect((save.body as Record<string, string>).__RequestVerificationToken).toBeUndefined();
    expect(out.status).toBeUndefined();
    expect(out.uploaded).toHaveLength(1);
  });

  it('tolerates a non-JSON anti-forgery response and still uploads', async () => {
    const badToken = (c: FakeCall): FetchResult =>
      c.path.endsWith('GetAntiForgeryToken') ? { status: 200, body: 'not json' } : happy(c);
    const t = tool(badToken, { allowedRoots: [root] });
    const out = await t.confirmed({ side: 'front', front_path: write('card.png', PNG) });
    expect(out.status).toBe('1');
  });

  it('uploads the back only', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const out = await t.confirmed({ side: 'back', back_path: write('back.jpg', JPG) });
    const save = t.transport.calls.find((c) => c.path.endsWith('SaveInsuranceCardImages'))!;
    const body = save.body as Record<string, string>;
    expect(body.FrontImage).toBe('');
    expect(body.BackImage).toBe(JPG.toString('base64'));
    expect(out.uploaded).toEqual([{ side: 'back', name: expect.stringContaining('back.jpg'), size: JPG.length }]);
  });

  it('reports a signed-out portal at the anti-forgery step without uploading', async () => {
    const signedOut = (c: FakeCall): FetchResult =>
      c.path.endsWith('GetAntiForgeryToken')
        ? { status: 200, body: '<html><head><title>Portal :: Login</title></head></html>' }
        : happy(c);
    const t = tool(signedOut, { allowedRoots: [root] });
    const path = write('card.png', PNG);
    const preview = await t.once({ side: 'front', front_path: path });
    const confirmToken = preview.confirmToken as string;
    await expect(t.raw({ side: 'front', front_path: path, confirmToken })).rejects.toThrow(/not signed in/i);
    expect(t.transport.calls.some((c) => c.path.endsWith('SaveInsuranceCardImages'))).toBe(false);
  });

  it('refuses when a file changed between preview and confirmation (DRAFT_CHANGED)', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const path = write('card.png', PNG);
    const preview = await t.once({ side: 'front', front_path: path });
    const confirmToken = preview.confirmToken as string;
    write('card.png', PNG2); // same path, different bytes
    const out = await t.once({ side: 'front', front_path: path, confirmToken });
    expect(out.error).toBe('DRAFT_CHANGED');
  });

  it('surfaces a portal rejection without claiming success', async () => {
    const reject = (c: FakeCall): FetchResult =>
      c.path.endsWith('SaveInsuranceCardImages')
        ? { status: 200, body: JSON.stringify({ Success: false, Status: '0' }) }
        : happy(c);
    const t = tool(reject, { allowedRoots: [root] });
    await expect(t.confirmed({ side: 'front', front_path: write('card.png', PNG) })).rejects.toThrow(
      /did not accept the upload/i,
    );
  });
});

describe('insync_upload_insurance_card — vetUploadFile boundary', () => {
  it('refuses a non-image extension', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    await expect(t.raw({ side: 'front', front_path: write('card.txt', PNG) })).rejects.toThrow();
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses an oversize file', async () => {
    const t = tool(happy, { allowedRoots: [root], maxBytes: 4 });
    await expect(t.raw({ side: 'front', front_path: write('card.png', PNG) })).rejects.toThrow();
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses a symlink', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const real = write('real.png', PNG);
    const link = join(root, 'link.png');
    symlinkSync(real, link);
    await expect(t.raw({ side: 'front', front_path: link })).rejects.toThrow();
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses a file outside the allowed roots', async () => {
    const other = mkdtempSync(join(tmpdir(), 'insync-other-'));
    try {
      const outside = join(other, 'card.png');
      writeFileSync(outside, PNG);
      const t = tool(happy, { allowedRoots: [root] });
      await expect(t.raw({ side: 'front', front_path: outside })).rejects.toThrow();
      expect(t.transport.calls).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
