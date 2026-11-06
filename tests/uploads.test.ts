import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsyncClient } from '../src/client.js';
import type { FetchResult, InsyncTransport, RequestOptions } from '../src/transport.js';
import type { BlobStore } from '@chrischall/mcp-utils/export';
import {
  DEFAULT_UPLOAD_ROOTS,
  UPLOAD_MIME_TYPES,
  buildInsuranceForm,
  registerUploadTools,
  stripDataUrlPrefix,
  uploadMimeByExt,
} from '../src/tools/uploads.js';
import { fakeBlobStore } from './_tools.js';

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
  opts: {
    allowedRoots: readonly string[] | 'unconfined';
    maxBytes?: number;
    store?: BlobStore | null;
    hosted?: boolean;
  },
) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, fn: Handler) => handlers.set(name, fn),
  } as unknown as Parameters<typeof registerUploadTools>[0];
  const transport = new FakeTransport(responder);
  const client = new InsyncClient({ transport });
  registerUploadTools(server, client, { store: null, hosted: false, ...opts });
  const fn = handlers.get('insync_upload_insurance_card')!;
  const slots = handlers.get('insync_upload_slots')!;
  const parse = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  return {
    transport,
    once: async (args: Record<string, unknown>) => parse(await fn(args, ctx())),
    raw: (args: Record<string, unknown>) => fn(args, ctx()),
    slots: async (args: Record<string, unknown>) => parse(await slots(args, ctx())),
    slotsRaw: (args: Record<string, unknown>) => slots(args, ctx()),
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
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
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

  it('confines local upload paths to the user media folders', () => {
    expect(DEFAULT_UPLOAD_ROOTS).toEqual(['~/Downloads', '~/Documents', '~/Desktop', '~/Pictures']);
  });

  it('accepts exactly JPG/JPEG/PNG, with MIME types from the shared table', () => {
    expect(UPLOAD_MIME_TYPES).toEqual(['image/jpeg', 'image/png']);
    expect(uploadMimeByExt).toEqual({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' });
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

  it('refuses a missing or empty back source before touching anything', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const one = /exactly one of back_path, back_inline or back_blob_key/;
    await expect(t.raw({ side: 'both', front_path: write('f.png', PNG) })).rejects.toThrow(one);
    await expect(t.raw({ side: 'back', back_path: '' })).rejects.toThrow(one);
    await expect(t.raw({ side: 'back', back_blob_key: '' })).rejects.toThrow(one);
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses a missing or empty front source before touching anything', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const one = /exactly one of front_path, front_inline or front_blob_key/;
    await expect(t.raw({ side: 'front' })).rejects.toThrow(one);
    await expect(t.raw({ side: 'front', front_path: '' })).rejects.toThrow(one);
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses two sources for one side (exactly one of path | inline | blob key)', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    await expect(
      t.raw({
        side: 'front',
        front_path: write('f.png', PNG),
        front_inline: { filename: 'f.png', contentBase64: b64(PNG) },
      }),
    ).rejects.toThrow(/exactly one of front_path, front_inline or front_blob_key/);
    await expect(
      t.raw({ side: 'back', back_inline: { filename: 'b.png', contentBase64: b64(PNG) }, back_blob_key: 'x' }),
    ).rejects.toThrow(/exactly one of back_path, back_inline or back_blob_key/);
    expect(t.transport.calls).toEqual([]);
  });

  it('binds each side\'s sha256 into the preview', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const out = await t.once({ side: 'both', front_path: write('f.png', PNG), back_path: write('b.jpg', JPG) });
    const files = (out.preview as { willSend: { files: Record<string, unknown>[] } }).willSend.files;
    expect(files).toEqual([
      { side: 'front', name: 'f.png', type: 'image/png', size: PNG.length, source: 'path', sha256: sha(PNG) },
      { side: 'back', name: 'b.jpg', type: 'image/jpeg', size: JPG.length, source: 'path', sha256: sha(JPG) },
    ]);
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

  it('reports an unknown outcome (not an error) when the save answers a 5xx', async () => {
    // The bytes may have landed before the backend failed: the confirm token is
    // spent, so a throw that reads as "safe to retry" would upload twice.
    const fiveHundred = (c: FakeCall): FetchResult =>
      c.path.endsWith('SaveInsuranceCardImages') ? { status: 502, body: 'Bad Gateway' } : happy(c);
    const t = tool(fiveHundred, { allowedRoots: [root] });
    const out = await t.confirmed({ side: 'front', front_path: write('card.png', PNG) });
    expect(out.status).toBe('unknown');
    expect(out.warning).toMatch(/did not confirm this insurance-card upload/);
    expect(out.warning).toMatch(/your InSync profile/);
    expect(out.uploaded).toBeUndefined();
    // Sent exactly once — never retried.
    expect(t.transport.calls.filter((c) => c.path.endsWith('SaveInsuranceCardImages'))).toHaveLength(1);
  });

  it('reports an unknown outcome when the connection drops during the save', async () => {
    const dropped = (c: FakeCall): FetchResult => {
      if (c.path.endsWith('SaveInsuranceCardImages')) throw new Error('socket hang up');
      return happy(c);
    };
    const t = tool(dropped, { allowedRoots: [root] });
    const out = await t.confirmed({ side: 'front', front_path: write('card.png', PNG) });
    expect(out.status).toBe('unknown');
    expect(out.warning).toMatch(/may already have gone through/);
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

describe('insync_upload_insurance_card — inline base64', () => {
  it('uploads an inline image (preview, then confirm)', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    const args = { side: 'front', front_inline: { filename: 'card.png', contentBase64: b64(PNG) } };
    const preview = await t.once(args);
    const files = (preview.preview as { willSend: { files: Record<string, unknown>[] } }).willSend.files;
    expect(files[0]).toMatchObject({ side: 'front', name: 'card.png', source: 'inline', sha256: sha(PNG) });
    const out = await t.confirmed(args);
    const save = t.transport.calls.find((c) => c.path.endsWith('SaveInsuranceCardImages'))!;
    expect((save.body as Record<string, string>).FrontImage).toBe(b64(PNG));
    expect(out.uploaded).toEqual([{ side: 'front', name: 'card.png', size: PNG.length }]);
    expect(out.blob_cleanup).toBeUndefined();
  });

  it('accepts a data-URL prefix on inline base64', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    await t.confirmed({
      side: 'back',
      back_inline: { filename: 'back.jpg', contentBase64: `data:image/jpeg;base64,${b64(JPG)}` },
    });
    const save = t.transport.calls.find((c) => c.path.endsWith('SaveInsuranceCardImages'))!;
    expect((save.body as Record<string, string>).BackImage).toBe(b64(JPG));
  });

  it('refuses bad base64 before touching anything', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    await expect(
      t.raw({ side: 'front', front_inline: { filename: 'card.png', contentBase64: 'not*base64!' } }),
    ).rejects.toThrow(/not valid base64/);
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses an oversize inline image', async () => {
    const t = tool(happy, { allowedRoots: [root], maxBytes: 4 });
    await expect(
      t.raw({ side: 'front', front_inline: { filename: 'card.png', contentBase64: b64(PNG) } }),
    ).rejects.toThrow(/too large/);
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses a non-image type, and bytes that do not match the claimed type', async () => {
    const t = tool(happy, { allowedRoots: [root] });
    await expect(
      t.raw({ side: 'front', front_inline: { filename: 'card.pdf', contentBase64: b64(Buffer.from('%PDF-1.7')) } }),
    ).rejects.toThrow(/not accepted here/);
    await expect(
      t.raw({ side: 'front', front_inline: { filename: 'card.png', contentBase64: b64(JPG) } }),
    ).rejects.toThrow(/do not look like image\/png/);
  });

  it('still works hosted (no disk needed)', async () => {
    const t = tool(happy, { allowedRoots: [root], hosted: true });
    const out = await t.confirmed({ side: 'front', front_inline: { filename: 'card.png', contentBase64: b64(PNG) } });
    expect(out.uploaded).toHaveLength(1);
  });
});

describe('insync_upload_insurance_card — hosted paths', () => {
  it('refuses a path on a hosted server, pointing at the slot tool', async () => {
    const blob = fakeBlobStore();
    const t = tool(happy, { allowedRoots: [root], hosted: true, store: blob.store });
    await expect(t.raw({ side: 'front', front_path: write('card.png', PNG) })).rejects.toThrow(
      /can't read files on your machine.*insync_upload_slots.*front_blob_key/,
    );
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses a path on a hosted server with no blob store, pointing at inline', async () => {
    const t = tool(happy, { allowedRoots: [root], hosted: true, store: null });
    await expect(t.raw({ side: 'back', back_path: write('card.png', PNG) })).rejects.toThrow(/back_inline/);
  });
});

describe('insync_upload_slots', () => {
  it('mints a signed PUT slot per requested image', async () => {
    const blob = fakeBlobStore();
    const t = tool(happy, { allowedRoots: [root], store: blob.store });
    const out = await t.slots({ files: [{ filename: 'front.png' }, { filename: 'back.jpg' }] });
    const slots = out.slots as Record<string, string>[];
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ filename: 'front.png', mimeType: 'image/png', method: 'PUT' });
    expect(slots[0]!.blobKey).toMatch(/^uploads\//);
    expect(slots[0]!.uploadUrl).toContain('sig=');
    expect(slots[1]!.curl).toContain("Content-Type: image/jpeg");
    expect(out.next).toMatch(/front_blob_key/);
    expect(blob.calls).toEqual([]); // minting is local signing, no request
    expect(t.transport.calls).toEqual([]);
  });

  it('refuses clearly when the server has no blob store', async () => {
    const t = tool(happy, { allowedRoots: [root], store: null });
    await expect(t.slotsRaw({ files: [{ filename: 'front.png' }] })).rejects.toThrow(
      /no blob store.*front_path.*front_inline/,
    );
  });

  it('refuses a slot for a type the portal will not take', async () => {
    const blob = fakeBlobStore();
    const t = tool(happy, { allowedRoots: [root], store: blob.store });
    await expect(t.slotsRaw({ files: [{ filename: 'card.heic' }] })).rejects.toThrow(/image\/heic.*not accepted/);
  });
});

describe('insync_upload_insurance_card — blob keys', () => {
  it('previews from a blob WITHOUT deleting it', async () => {
    const blob = fakeBlobStore();
    const key = blob.putUpload('card.png', new Uint8Array(PNG));
    const t = tool(happy, { allowedRoots: [root], store: blob.store, hosted: true });
    const out = await t.once({ side: 'front', front_blob_key: key });
    expect(out.status).toBe('confirmation-required');
    const files = (out.preview as { willSend: { files: Record<string, unknown>[] } }).willSend.files;
    expect(files[0]).toMatchObject({ name: 'card.png', source: 'blob', sha256: sha(PNG) });
    expect(blob.calls.map((c) => c.method)).toEqual(['GET']);
    expect(blob.objects.has(key)).toBe(true);
    expect(t.transport.calls).toEqual([]);
  });

  it('deletes the blob after the portal accepts, and reports it', async () => {
    const blob = fakeBlobStore();
    const front = blob.putUpload('front.png', new Uint8Array(PNG));
    const back = blob.putUpload('back.jpg', new Uint8Array(JPG));
    const t = tool(happy, { allowedRoots: [root], store: blob.store, hosted: true });
    const out = await t.confirmed({ side: 'both', front_blob_key: front, back_blob_key: back });
    const body = t.transport.calls.find((c) => c.path.endsWith('SaveInsuranceCardImages'))!.body as Record<
      string,
      string
    >;
    expect(body.FrontImage).toBe(b64(PNG));
    expect(body.BackImage).toBe(b64(JPG));
    expect(out.blob_cleanup).toEqual([
      { side: 'front', deleted: true },
      { side: 'back', deleted: true },
    ]);
    expect(blob.objects.size).toBe(0);
    // Deletes only after the reads of both calls.
    expect(blob.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'DELETE', 'DELETE']);
  });

  it('keeps the blob when the portal rejects the upload', async () => {
    const blob = fakeBlobStore();
    const key = blob.putUpload('card.png', new Uint8Array(PNG));
    const reject = (c: FakeCall): FetchResult =>
      c.path.endsWith('SaveInsuranceCardImages')
        ? { status: 200, body: JSON.stringify({ Success: false, Status: '0' }) }
        : happy(c);
    const t = tool(reject, { allowedRoots: [root], store: blob.store, hosted: true });
    await expect(t.confirmed({ side: 'front', front_blob_key: key })).rejects.toThrow(/did not accept/i);
    expect(blob.objects.has(key)).toBe(true);
    expect(blob.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('keeps the blob when the outcome is unknown', async () => {
    const blob = fakeBlobStore();
    const key = blob.putUpload('card.png', new Uint8Array(PNG));
    const fiveHundred = (c: FakeCall): FetchResult =>
      c.path.endsWith('SaveInsuranceCardImages') ? { status: 502, body: 'Bad Gateway' } : happy(c);
    const t = tool(fiveHundred, { allowedRoots: [root], store: blob.store, hosted: true });
    const out = await t.confirmed({ side: 'front', front_blob_key: key });
    expect(out.status).toBe('unknown');
    expect(blob.objects.has(key)).toBe(true);
  });

  it('reports a failed delete without failing the (already done) upload', async () => {
    const blob = fakeBlobStore({ deleteStatus: 500 });
    const key = blob.putUpload('card.png', new Uint8Array(PNG));
    const t = tool(happy, { allowedRoots: [root], store: blob.store, hosted: true });
    const out = await t.confirmed({ side: 'front', front_blob_key: key });
    expect(out.uploaded).toHaveLength(1);
    expect(out.blob_cleanup).toEqual([{ side: 'front', deleted: false, error: expect.stringMatching(/HTTP 500/) }]);
  });

  it('refuses a blob that changed between preview and confirmation (DRAFT_CHANGED)', async () => {
    const blob = fakeBlobStore();
    const key = blob.putUpload('card.png', new Uint8Array(PNG));
    const t = tool(happy, { allowedRoots: [root], store: blob.store, hosted: true });
    const preview = await t.once({ side: 'front', front_blob_key: key });
    blob.objects.set(key, { bytes: new Uint8Array(PNG2), type: 'image/png' });
    const out = await t.once({ side: 'front', front_blob_key: key, confirmToken: preview.confirmToken });
    expect(out.error).toBe('DRAFT_CHANGED');
    expect(t.transport.calls.some((c) => c.path.endsWith('SaveInsuranceCardImages'))).toBe(false);
    expect(blob.objects.has(key)).toBe(true);
  });

  it('refuses a blob key that is not an upload-slot key', async () => {
    const blob = fakeBlobStore();
    const t = tool(happy, { allowedRoots: [root], store: blob.store, hosted: true });
    await expect(t.raw({ side: 'front', front_blob_key: 'files/other/thing.png' })).rejects.toThrow(
      /not an upload key/,
    );
  });

  it('refuses a blob key when there is no blob store', async () => {
    const t = tool(happy, { allowedRoots: [root], store: null });
    await expect(
      t.raw({ side: 'front', front_blob_key: 'uploads/00000000-0000-0000-0000-000000000000/Y2FyZC5wbmc' }),
    ).rejects.toThrow(/no blob store/);
  });
});

describe('registerUploadTools — defaults from the environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function bare() {
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _def: unknown, fn: Handler) => handlers.set(name, fn),
    } as unknown as Parameters<typeof registerUploadTools>[0];
    registerUploadTools(server, new InsyncClient({ transport: new FakeTransport(happy) }));
    return handlers;
  }

  it('reads the blob store and hosting from the env when not injected', async () => {
    const blob = fakeBlobStore();
    vi.stubEnv('MCP_BLOB_BASE_URL', 'https://host.example/b/reg_0123456789abcdef01234567');
    vi.stubEnv('MCP_BLOB_SIGNING_KEY', 'a2V5');
    const handlers = bare();
    const res = await handlers.get('insync_upload_slots')!({ files: [{ filename: 'front.png' }] }, ctx());
    expect(JSON.parse(res.content[0]!.text).slots).toHaveLength(1);
    // Hosted (the blob store is configured): a path is refused.
    const key = blob.putUpload('card.png', new Uint8Array(PNG));
    await expect(
      handlers.get('insync_upload_insurance_card')!({ side: 'front', front_path: '/tmp/card.png' }, ctx()),
    ).rejects.toThrow(/can't read files on your machine/);
    const preview = await handlers.get('insync_upload_insurance_card')!({ side: 'front', front_blob_key: key }, ctx());
    expect(JSON.parse(preview.content[0]!.text).status).toBe('confirmation-required');
  });

  it('is local with no store when the env sets neither, confining paths to the media folders', async () => {
    vi.stubEnv('MCP_DATA_DIR', '');
    vi.stubEnv('MCP_BLOB_BASE_URL', '');
    const handlers = bare();
    await expect(
      handlers.get('insync_upload_slots')!({ files: [{ filename: 'front.png' }] }, ctx()),
    ).rejects.toThrow(/no blob store/);
    // A local path outside ~/Downloads etc. is refused by the default roots.
    await expect(
      handlers.get('insync_upload_insurance_card')!({ side: 'front', front_path: write('card.png', PNG) }, ctx()),
    ).rejects.toThrow(/outside the directories uploads may come from/);
  });
});
