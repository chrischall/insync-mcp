import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsyncClient } from '../src/client.js';
import type { BinaryFetchResult, FetchResult } from '../src/transport.js';
import type { DeliverArgs, DownloadIO, DownloadOutcome } from '../src/download-io.js';
import { DeliveryLadderIO, NodeDownloadIO } from '../src/download-io.js';
import { registerDownloadTools, splitAttachmentName } from '../src/tools/downloads.js';
import { BLOB_BASE, FakeTransport, type FakeCall, type Handler, fakeBlobStore, textOf } from './_tools.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A disk outcome, as NodeDownloadIO reports one. */
const onDisk = (a: DeliverArgs, savedTo: string): DownloadOutcome => ({
  via: 'disk',
  fileName: a.fileName,
  mimeType: a.mimeType,
  size: a.bytes.length,
  content: [],
  savedTo,
});

const PORTAL_FILE = 'https://pfbhintouch.insynchcs.com/DocumentManager/DownloadFile.ashx?f=1';

// Fake S3 values that must never surface from a download result (the creds the
// login carries are held server-side and the file tools never touch them).
const S3_SENTINELS = ['AKIATESTKEY12345', 'SECRETKEY67890ABCDEF', 'test-bucket-synthetic'];

const okJson = (value: unknown): FetchResult => ({ status: 200, body: JSON.stringify(value) });
const okBin = (body: string, contentType?: string): BinaryFetchResult => ({
  status: 200,
  body: '',
  bytes: new Uint8Array(Buffer.from(body)),
  contentType,
});

/** A DownloadIO that records the last deliver() and returns a canned outcome. */
class RecordingIO implements DownloadIO {
  last?: DeliverArgs;
  constructor(private readonly outcome: (a: DeliverArgs) => DownloadOutcome) {}
  async deliver(args: DeliverArgs): Promise<DownloadOutcome> {
    this.last = args;
    return this.outcome(args);
  }
}

function setup(opts: {
  responder?: (call: FakeCall) => FetchResult;
  binaryResponder?: (call: FakeCall) => BinaryFetchResult;
  io?: DownloadIO;
}): { handlers: Map<string, Handler>; transport: FakeTransport; io: DownloadIO } {
  const transport = new FakeTransport(
    opts.responder ?? (() => okJson({})),
    opts.binaryResponder,
  );
  const client = new InsyncClient({ transport });
  const io =
    opts.io ?? new RecordingIO((a) => onDisk(a, `/out/${a.fileName}`));
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, fn: Handler) => handlers.set(name, fn),
  };
  registerDownloadTools(server as never, client, io);
  return { handlers, transport, io };
}

const ATTACHMENTS = [
  { FileName: 'plan.pdf', FilePath: PORTAL_FILE, FileNotExit: true },
  { FileName: 'home##_##https://exercisepro.example/abc', FilePath: PORTAL_FILE, FileNotExit: true },
  { FileName: 'gone.pdf', FilePath: PORTAL_FILE, FileNotExit: false },
];

describe('splitAttachmentName', () => {
  it('keeps the display half and splits off the exercise url', () => {
    expect(splitAttachmentName('a.pdf')).toEqual({ fileName: 'a.pdf' });
    expect(splitAttachmentName('a.pdf##_##http://x/y')).toEqual({
      fileName: 'a.pdf',
      exerciseUrl: 'http://x/y',
    });
    expect(splitAttachmentName('a##_##')).toEqual({ fileName: 'a' });
    expect(splitAttachmentName(undefined)).toEqual({ fileName: '' });
  });
});

describe('insync_list_attachments', () => {
  it('lists names and positions without ever leaking the file URL', async () => {
    const { handlers, transport } = setup({ responder: () => okJson(ATTACHMENTS) });
    const res = await handlers.get('insync_list_attachments')!({ master_id: '9001' });
    const text = textOf(res);
    expect(text).toContain('plan.pdf');
    expect(text).toContain('https://exercisepro.example/abc'); // exercise url is shown
    expect(text).toContain('"present"');
    // the fetchable FilePath never appears in the result
    expect(text).not.toContain('DownloadFile.ashx');
    // listing used the side-effect-free attachments endpoint with the master id
    expect(transport.calls[0]).toMatchObject({
      verb: 'getJson',
      path: 'Messages/GetToDoAttachments?todoMasaterId=9001',
    });
  });
});

describe('insync_download_attachment', () => {
  it('downloads the chosen attachment and delivers it (disk)', async () => {
    const { handlers, transport, io } = setup({
      responder: () => okJson(ATTACHMENTS),
      binaryResponder: () => okBin('PDFBYTES', 'application/pdf'),
    });
    const res = await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 0 });
    const out = JSON.parse(textOf(res));
    expect(out.saved_to).toBe('/out/plan.pdf');
    expect(out.mime_type).toBe('application/pdf');
    expect(out.size_bytes).toBe(8);
    // the IO received the real bytes, name and source url
    expect((io as RecordingIO).last).toMatchObject({ fileName: 'plan.pdf', url: PORTAL_FILE });
    // the bytes were fetched through getBinary on the attachment's own path
    expect(transport.calls.some((c) => c.verb === 'getBinary' && c.path === PORTAL_FILE)).toBe(true);
    for (const s of S3_SENTINELS) expect(textOf(res)).not.toContain(s);
  });

  it('returns the exercise-url display name for a ##_## attachment', async () => {
    const io = new RecordingIO((a) => onDisk(a, `/out/${a.fileName}`));
    const { handlers } = setup({
      responder: () => okJson(ATTACHMENTS),
      binaryResponder: () => okBin('X'),
      io,
    });
    await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 1 });
    expect(io.last?.fileName).toBe('home');
  });

  it('names a nameless attachment "attachment"', async () => {
    const io = new RecordingIO((a) => onDisk(a, `/out/${a.fileName}`));
    const rows = [{ FileName: '##_##http://x/y', FilePath: PORTAL_FILE, FileNotExit: true }]; // empty display name
    const { handlers } = setup({
      responder: () => okJson(rows),
      binaryResponder: () => okBin('X'),
      io,
    });
    await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 0 });
    expect(io.last?.fileName).toBe('attachment');
    expect(io.last?.url).toBe(PORTAL_FILE);
  });

  it('refuses an attachment with no download path, fetching no bytes', async () => {
    // An empty path would resolve to the portal ROOT and deliver the dashboard
    // page as "the attachment" — so a missing, empty or non-string FilePath is
    // refused before any fetch.
    for (const row of [
      { FileName: 'a.pdf', FileNotExit: true },
      { FileName: 'a.pdf', FilePath: '', FileNotExit: true },
      { FileName: 'a.pdf', FilePath: 42, FileNotExit: true },
    ]) {
      const io = new RecordingIO((a) => onDisk(a, '/out/x'));
      const { handlers, transport } = setup({
        responder: () => okJson([row]),
        binaryResponder: () => okBin('<html>dashboard</html>'),
        io,
      });
      const res = await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 0 });
      expect(JSON.parse(textOf(res))).toEqual({ error: 'That attachment has no download path.' });
      expect(transport.calls.some((c) => c.verb === 'getBinary')).toBe(false);
      expect(io.last).toBeUndefined();
    }
  });

  it('returns a small non-image file as a signed link on a hosted server', async () => {
    const blob = fakeBlobStore();
    const { handlers } = setup({
      responder: () => okJson(ATTACHMENTS),
      binaryResponder: () => okBin('PDFBYTES', 'application/pdf'),
      io: new DeliveryLadderIO({ store: blob.store }),
    });
    const res = (await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 0 })) as {
      content: unknown[];
    };
    const out = JSON.parse(textOf(res));
    expect(out.saved_to).toBeUndefined();
    expect(out.delivered_via).toBe('link');
    expect(out.url.startsWith(`${BLOB_BASE}/`)).toBe(true);
    expect(out.base64).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(blob.calls.map((c) => c.method)).toEqual(['PUT']);
  });

  it('hands back a signed download link for an over-cap file on a hosted server', async () => {
    const blob = fakeBlobStore();
    const { handlers } = setup({
      responder: () => okJson(ATTACHMENTS),
      binaryResponder: () => okBin('PDFBYTES', 'application/pdf'),
      io: new DeliveryLadderIO({ store: blob.store, inlineMaxBytes: 4 }),
    });
    const res = (await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 0 })) as {
      content: unknown[];
    };
    const out = JSON.parse(textOf(res));
    expect(out.delivered_via).toBe('link');
    expect(out.url.startsWith(`${BLOB_BASE}/`)).toBe(true);
    expect(out.expires_at).toMatch(/^\d{4}-/);
    expect(out.note).toMatch(/too large to return inline/);
    expect(out.link_note).toMatch(/only to the user/);
    expect(res.content).toHaveLength(1);
    expect(blob.calls.map((c) => c.method)).toEqual(['PUT']);
  });

  it('saves to disk on a local install (real NodeDownloadIO)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insync-dl-tool-'));
    try {
      const { handlers } = setup({
        responder: () => okJson(ATTACHMENTS),
        binaryResponder: () => okBin('PDFBYTES', 'application/pdf'),
        io: new NodeDownloadIO([dir]),
      });
      const res = await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 0, output_dir: dir });
      const out = JSON.parse(textOf(res));
      expect(out.saved_to.startsWith(dir)).toBe(true);
      expect(out.delivered_via).toBe('disk');
      expect(readFileSync(out.saved_to, 'utf8')).toBe('PDFBYTES');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when the index is out of range, fetching no bytes', async () => {
    const { handlers, transport } = setup({ responder: () => okJson(ATTACHMENTS) });
    const res = await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 9 });
    expect(JSON.parse(textOf(res)).error).toMatch(/No attachment at position 9/);
    expect(transport.calls.some((c) => c.verb === 'getBinary')).toBe(false);
  });

  it('errors when the attachment was deleted or moved', async () => {
    const { handlers, transport } = setup({ responder: () => okJson(ATTACHMENTS) });
    const res = await handlers.get('insync_download_attachment')!({ master_id: '9001', index: 2 });
    expect(JSON.parse(textOf(res)).error).toMatch(/no longer available/);
    expect(transport.calls.some((c) => c.verb === 'getBinary')).toBe(false);
  });

  it('refuses an attachment whose path points off the portal', async () => {
    const offPortal = [{ FileName: 'x.pdf', FilePath: 'https://evil.example.com/x', FileNotExit: true }];
    const { handlers } = setup({
      responder: () => okJson(offPortal),
      binaryResponder: () => okBin('X'),
    });
    await expect(
      handlers.get('insync_download_attachment')!({ master_id: '9001', index: 0 }),
    ).rejects.toThrow(/outside the InSync portal/);
  });
});

describe('insync_download_document', () => {
  function docResponder(source: Record<string, unknown>) {
    return (call: FakeCall): FetchResult => {
      if (call.path.startsWith('PatientDocument/GetFileSource')) return okJson(source);
      return okJson({});
    };
  }

  it('resolves the file source then downloads and delivers it', async () => {
    const io = new RecordingIO((a) => onDisk(a, `/out/${a.fileName}`));
    const { handlers, transport } = setup({
      responder: docResponder({ Status: 'success', FilePath: '/srv/doc-123' }),
      binaryResponder: () => okBin('DOCBYTES', 'application/pdf'),
      io,
    });
    const res = await handlers.get('insync_download_document')!({
      folder_url: 'folder/abc',
      file_name: 'summary.pdf',
    });
    expect(JSON.parse(textOf(res)).saved_to).toBe('/out/summary.pdf');
    expect(io.last?.fileName).toBe('summary.pdf');
    // GetFileSource carried the FolderUrl; GetFile posted the resolved FilePath
    expect(transport.calls[0]).toMatchObject({
      verb: 'postJson',
      path: 'PatientDocument/GetFileSource?FolderUrl=folder%2Fabc',
    });
    expect(transport.calls.find((c) => c.verb === 'postBinary')).toMatchObject({
      path: 'PatientDocument/GetFile',
      body: { FilePath: '/srv/doc-123' },
    });
  });

  it('errors (no download) when the portal cannot resolve the file', async () => {
    const { handlers, transport } = setup({
      responder: docResponder({ Status: 'warning', FilePath: '' }),
    });
    const res = await handlers.get('insync_download_document')!({
      folder_url: 'folder/abc',
      file_name: 'summary.pdf',
    });
    expect(JSON.parse(textOf(res)).error).toMatch(/not available to download/);
    expect(transport.calls.some((c) => c.verb === 'postBinary')).toBe(false);
  });

  it('errors when the resolve succeeds but the path is empty', async () => {
    const { handlers } = setup({
      responder: docResponder({ Status: 'success', FilePath: '' }),
    });
    const res = await handlers.get('insync_download_document')!({
      folder_url: 'folder/abc',
      file_name: 'summary.pdf',
    });
    expect(JSON.parse(textOf(res)).error).toMatch(/not available to download/);
  });

  it('omits the status in the error when the portal gave none', async () => {
    const { handlers } = setup({ responder: docResponder({ Status: '', FilePath: '' }) });
    const res = await handlers.get('insync_download_document')!({
      folder_url: 'folder/abc',
      file_name: 'summary.pdf',
    });
    const out = JSON.parse(textOf(res));
    expect(out.error).toMatch(/not available to download/);
    expect(out.status).toBeUndefined();
  });

  it('links an over-cap document on a hosted server instead of dead-ending', async () => {
    const blob = fakeBlobStore();
    const { handlers } = setup({
      responder: docResponder({ Status: 'success', FilePath: '/srv/doc' }),
      binaryResponder: () => okBin('TOOBIG', 'application/pdf'),
      io: new DeliveryLadderIO({ store: blob.store, inlineMaxBytes: 2 }),
    });
    const res = await handlers.get('insync_download_document')!({
      folder_url: 'folder/abc',
      file_name: 'big.pdf',
    });
    const out = JSON.parse(textOf(res));
    expect(out.delivered_via).toBe('link');
    expect(out.url).toContain('big.pdf');
    expect(out.base64).toBeUndefined();
  });

  it('refuses an over-cap document clearly when hosted with no blob store', async () => {
    const { handlers } = setup({
      responder: docResponder({ Status: 'success', FilePath: '/srv/doc' }),
      binaryResponder: () => okBin('TOOBIG', 'application/pdf'),
      io: new DeliveryLadderIO({ store: null, inlineMaxBytes: 2 }),
    });
    await expect(
      handlers.get('insync_download_document')!({ folder_url: 'folder/abc', file_name: 'big.pdf' }),
    ).rejects.toThrow(/inline limit/);
  });
});
