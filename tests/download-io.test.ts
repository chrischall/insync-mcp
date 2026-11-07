import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DOWNLOAD_ROOTS,
  DeliveryLadderIO,
  NodeDownloadIO,
  downloadRoots,
  makeDownloadIO,
} from '../src/download-io.js';
import { BLOB_BASE, fakeBlobStore } from './_tools.js';

const temps: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'insync-dl-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PDF = new Uint8Array(Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

describe('NodeDownloadIO (local disk — unchanged)', () => {
  it('writes the bytes to the per-call dir, private, and reports the path', async () => {
    const dir = tmp();
    const io = new NodeDownloadIO([dir]);
    const out = await io.deliver({
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      dest: dir,
    });
    expect(out.via).toBe('disk');
    expect(out.savedTo!.endsWith('.pdf')).toBe(true);
    expect(out.size).toBe(4);
    expect(out.content).toEqual([]);
    expect([...readFileSync(out.savedTo!)]).toEqual([1, 2, 3, 4]);
    expect(statSync(out.savedTo!).mode & 0o777).toBe(0o600);
  });

  it('derives the extension from the MIME type when the name has none', async () => {
    const dir = tmp();
    const out = await new NodeDownloadIO([dir]).deliver({
      bytes: new Uint8Array([0]),
      fileName: 'scan',
      mimeType: 'image/png',
      dest: dir,
    });
    expect(out.savedTo!.endsWith('.png')).toBe(true);
  });

  it('falls back to the MIME extension when the name extension is unsafe', async () => {
    const dir = tmp();
    const out = await new NodeDownloadIO([dir]).deliver({
      bytes: new Uint8Array([0]),
      fileName: 'weird.name!',
      mimeType: 'application/pdf',
      dest: dir,
    });
    expect(out.savedTo!.endsWith('.pdf')).toBe(true);
  });

  it('falls back to a default stem when the name has none', async () => {
    const dir = tmp();
    const out = await new NodeDownloadIO([dir]).deliver({
      bytes: new Uint8Array([0]),
      fileName: '',
      mimeType: 'application/pdf',
      dest: dir,
    });
    expect(out.savedTo!.replace(/\\/g, '/')).toMatch(/\/download\.pdf$/);
  });

  it('refuses a per-call dir outside the allowed roots', async () => {
    const allowed = tmp();
    const outside = tmp();
    const io = new NodeDownloadIO([allowed]);
    await expect(
      io.deliver({ bytes: new Uint8Array([0]), fileName: 'x.pdf', dest: outside }),
    ).rejects.toThrow();
  });
});

describe('DeliveryLadderIO (hosted: inline, else a signed link)', () => {
  it('returns a small file inline as a content block when there is no blob store', async () => {
    const out = await new DeliveryLadderIO({ store: null }).deliver({
      bytes: PDF,
      fileName: 'report.pdf',
      mimeType: 'application/pdf;charset=UTF-8',
    });
    expect(out.via).toBe('resource');
    expect(out.mimeType).toBe('application/pdf');
    expect(out.content).toHaveLength(1);
    const block = out.content[0] as { resource: { blob: string; mimeType: string } };
    expect(Buffer.from(block.resource.blob, 'base64').toString()).toBe(Buffer.from(PDF).toString());
  });

  it('sends a small non-image file as a signed link when a blob store exists (hosted clients reject resource blobs)', async () => {
    const blob = fakeBlobStore();
    const out = await new DeliveryLadderIO({ store: blob.store }).deliver({
      bytes: PDF,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    });
    expect(out.via).toBe('link');
    expect(out.url?.startsWith(`${BLOB_BASE}/`)).toBe(true);
    expect(blob.calls.map((c) => c.method)).toEqual(['PUT']);
  });

  it('returns an image as an image block', async () => {
    const out = await new DeliveryLadderIO({ store: null }).deliver({ bytes: PNG, fileName: 'scan.png' });
    expect(out.via).toBe('image');
    expect(out.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('hands back a signed link (and PUTs the bytes) when the file is over the inline cap', async () => {
    const blob = fakeBlobStore();
    const out = await new DeliveryLadderIO({ store: blob.store, inlineMaxBytes: 4 }).deliver({
      bytes: PDF,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
    });
    expect(out.via).toBe('link');
    expect(out.content).toEqual([]);
    expect(out.url!.startsWith(`${BLOB_BASE}/`)).toBe(true);
    expect(out.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.note).toMatch(/too large to return inline/);
    expect(blob.calls.map((c) => c.method)).toEqual(['PUT']);
    const [stored] = [...blob.objects.values()];
    expect(Buffer.from(stored!.bytes).toString()).toBe(Buffer.from(PDF).toString());
  });

  it('refuses (too_large) when over the cap with no store and no disk', async () => {
    await expect(
      new DeliveryLadderIO({ store: null, inlineMaxBytes: 4 }).deliver({ bytes: PDF, fileName: 'report.pdf' }),
    ).rejects.toThrow(/too large|inline limit/);
  });

  it('defaults to the 10 MiB inline cap', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    await expect(new DeliveryLadderIO({ store: null }).deliver({ bytes: big, fileName: 'big.bin' })).rejects.toThrow(
      /10485760/,
    );
  });

  it('falls back to the local disk over the cap when one is given (local inline mode)', async () => {
    const dir = tmp();
    const io = new DeliveryLadderIO({ store: null, inlineMaxBytes: 4, diskFallback: new NodeDownloadIO([dir]) });
    const out = await io.deliver({ bytes: PDF, fileName: 'report.pdf', mimeType: 'application/pdf', dest: dir });
    expect(out.via).toBe('disk');
    expect(out.note).toMatch(/too large to return inline.*saved to disk/);
    expect(statSync(out.savedTo!).mode & 0o777).toBe(0o600);
  });

  it('inlines under the cap even with a disk fallback', async () => {
    const dir = tmp();
    const io = new DeliveryLadderIO({ store: null, diskFallback: new NodeDownloadIO([dir]) });
    const out = await io.deliver({ bytes: PDF, fileName: 'report.pdf', mimeType: 'application/pdf' });
    expect(out.via).toBe('resource');
  });
});

describe('downloadRoots', () => {
  it('uses INSYNC_OUTPUT_DIR as a delimiter list, trimmed', () => {
    expect(downloadRoots({ INSYNC_OUTPUT_DIR: ` /a ${process.platform === 'win32' ? ';' : ':'} /b ` })).toEqual(
      ['/a', '/b'],
    );
  });

  it('treats a blank value as unset and falls back', () => {
    expect(downloadRoots({ INSYNC_OUTPUT_DIR: '   ' })).toEqual(DEFAULT_DOWNLOAD_ROOTS);
  });

  it('defaults to Downloads and Documents', () => {
    expect(downloadRoots({})).toEqual(DEFAULT_DOWNLOAD_ROOTS);
  });
});

describe('makeDownloadIO', () => {
  it('writes to disk on a local install', () => {
    expect(makeDownloadIO({}, null)).toBeInstanceOf(NodeDownloadIO);
  });

  it('uses the ladder, with a disk fallback, when INSYNC_INLINE_DOWNLOADS is truthy locally', async () => {
    const io = makeDownloadIO({ INSYNC_INLINE_DOWNLOADS: '1' }, null);
    expect(io).toBeInstanceOf(DeliveryLadderIO);
    expect((io as DeliveryLadderIO).hasDiskFallback).toBe(true);
  });

  it('uses the ladder with the blob store and NO disk when hosted', async () => {
    const blob = fakeBlobStore();
    const io = makeDownloadIO({ MCP_DATA_DIR: '/srv/data' }, blob.store);
    expect(io).toBeInstanceOf(DeliveryLadderIO);
    expect((io as DeliveryLadderIO).hasDiskFallback).toBe(false);
    const out = await (io as DeliveryLadderIO).deliver({ bytes: PDF, fileName: 'r.pdf', mimeType: 'application/pdf' });
    expect(out.via).toBe('link');
  });

  it('is still the ladder (inline, then a clear refusal) when hosted with no blob store', () => {
    const io = makeDownloadIO({ MCP_DATA_DIR: '/srv/data' }, null);
    expect(io).toBeInstanceOf(DeliveryLadderIO);
    expect((io as DeliveryLadderIO).hasStore).toBe(false);
    expect((io as DeliveryLadderIO).hasDiskFallback).toBe(false);
  });

  it('treats a configured blob store as hosted, and reads the store from the env by default', async () => {
    const io = makeDownloadIO({ MCP_BLOB_BASE_URL: BLOB_BASE, MCP_BLOB_SIGNING_KEY: 'a2V5' });
    expect(io).toBeInstanceOf(DeliveryLadderIO);
    expect((io as DeliveryLadderIO).hasStore).toBe(true);
  });
});
