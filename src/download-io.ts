// The delivery boundary for the file-download tools. A download fetches bytes
// through the portal (see InsyncClient); where those bytes GO depends on where
// the server runs, and that is the one thing this module decides:
//
//   * local stdio / desktop install → the server's filesystem IS the user's, so
//     the bytes are written to a private (0600) file under a confined output
//     directory and the tool returns the path (NodeDownloadIO — unchanged).
//   * hosted (mcp-host) → the user can't reach the runner's disk, so the bytes
//     go through mcp-utils' `deliverFile` ladder (DeliveryLadderIO): inline as
//     an MCP content block when they fit (10 MiB), otherwise PUT to the host's
//     blob store and returned as a signed, expiring download link. Never disk.
//   * local with INSYNC_INLINE_DOWNLOADS → the same ladder without a blob
//     store, falling back to the private disk write when a file is over the
//     inline cap (rather than a dead end).
//
// The download cap and timeout are the transport's and are untouched here.
// Injected into the tools so a test can pass a fake IO.

import { delimiter } from 'node:path';
import {
  extensionForMime,
  isSafeExtension,
  parseBoolEnv,
  readEnvVar,
  resolveOutputDir,
  writeBinaryOutput,
  type EnvSource,
} from '@chrischall/mcp-utils';
import {
  INLINE_DELIVERY_MAX_BYTES,
  blobStoreFromEnv,
  deliverFile,
  isHostedEnv,
  type BlobStore,
  type DeliveredContent,
} from '@chrischall/mcp-utils/export';

/** What a download delivered, for the tool to render. */
export interface DownloadOutcome {
  /** The route taken: an inline content block, a signed link, or a file on disk. */
  via: 'image' | 'resource' | 'link' | 'disk';
  /** The display file name (with extension). */
  fileName: string;
  /** MIME type, when known. */
  mimeType?: string;
  /** Size of the downloaded bytes. */
  size: number;
  /** Inline MCP content blocks (empty for `link` / `disk`). */
  content: DeliveredContent[];
  /** Absolute path written (`disk`). */
  savedTo?: string;
  /** Signed GET URL (`link`) — a bearer credential for that one file until it expires. */
  url?: string;
  /** When the link stops working, ISO-8601 (`link`). */
  expiresAt?: string;
  /** Why the route differs from the default, when it does. */
  note?: string;
}

/** One file's bytes plus the naming hints a delivery needs. */
export interface DeliverArgs {
  bytes: Uint8Array;
  /** The portal's file name (with extension when it has one). */
  fileName: string;
  mimeType?: string;
  /** The source URL, a fallback for the file extension. */
  url?: string;
  /** Per-call output directory (disk IO only); confined to the IO's roots. */
  dest?: string;
}

/** Where a download's bytes go. */
export interface DownloadIO {
  deliver(args: DeliverArgs): Promise<DownloadOutcome>;
}

/** The file extension to write with: the name's own, if safe, else one from the MIME type/URL. */
function resolveExtension(fileName: string, mimeType?: string, url?: string): string {
  const dot = fileName.lastIndexOf('.');
  const named = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  if (named !== '' && isSafeExtension(named)) return named;
  return extensionForMime(mimeType, { url });
}

/** The filename stem (no extension) to write with. */
function baseStem(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return stem === '' ? 'download' : stem;
}

/**
 * Disk-backed delivery: write the bytes to a non-overwriting file under the
 * resolved output directory and report the path. The per-call `dest` is
 * confined to {@link allowedRoots}; `INSYNC_OUTPUT_DIR` and the
 * `~/Downloads/insync-mcp` fallback are operator config and are not.
 */
export class NodeDownloadIO implements DownloadIO {
  constructor(private readonly allowedRoots: readonly string[]) {}

  async deliver(args: DeliverArgs): Promise<DownloadOutcome> {
    const dir = resolveOutputDir(args.dest, 'INSYNC_OUTPUT_DIR', {
      name: 'insync-mcp',
      allowedRoots: this.allowedRoots,
    });
    const savedTo = writeBinaryOutput({
      dir,
      baseName: baseStem(args.fileName),
      base64: Buffer.from(args.bytes).toString('base64'),
      extension: resolveExtension(args.fileName, args.mimeType, args.url),
      mode: 0o600,
    });
    return {
      via: 'disk',
      fileName: args.fileName,
      mimeType: args.mimeType,
      size: args.bytes.length,
      content: [],
      savedTo,
    };
  }
}

/** Options for {@link DeliveryLadderIO}. */
export interface DeliveryLadderOptions {
  /** The blob store for over-cap links; `null`/omitted for none. */
  store?: BlobStore | null;
  /** Inline ceiling in raw bytes. Default mcp-utils' 10 MiB (under mcp-host's 14 MiB result cap). */
  inlineMaxBytes?: number;
  /** Local inline mode only: where an over-cap file is written instead. Never set when hosted. */
  diskFallback?: NodeDownloadIO;
}

/**
 * `deliverFile`'s ladder: inline when the bytes fit, else a signed link from
 * the blob store, else (local inline mode) the private disk write, else a
 * `too_large` error naming the size and the limit. A hosted IO is built with
 * NO disk, so it can never hand back a path on the runner nobody can open.
 */
export class DeliveryLadderIO implements DownloadIO {
  private readonly store: BlobStore | null;
  private readonly inlineMaxBytes: number;

  constructor(private readonly opts: DeliveryLadderOptions = {}) {
    this.store = opts.store ?? null;
    this.inlineMaxBytes = opts.inlineMaxBytes ?? INLINE_DELIVERY_MAX_BYTES;
  }

  /** True when an over-cap file can become a link. */
  get hasStore(): boolean {
    return this.store !== null;
  }

  /** True when an over-cap file falls back to the local disk. */
  get hasDiskFallback(): boolean {
    return this.opts.diskFallback !== undefined;
  }

  async deliver(args: DeliverArgs): Promise<DownloadOutcome> {
    const fallback = this.opts.diskFallback;
    if (fallback !== undefined && this.store === null && args.bytes.length > this.inlineMaxBytes) {
      // deliverFile's own disk rung writes with the default mode; a health
      // record keeps the 0600 write NodeDownloadIO does.
      const out = await fallback.deliver(args);
      return {
        ...out,
        note: `${args.fileName} is ${args.bytes.length} bytes, too large to return inline (limit ${this.inlineMaxBytes}). It was saved to disk instead.`,
      };
    }
    const d = await deliverFile({
      bytes: args.bytes,
      fileName: args.fileName,
      mimeType: args.mimeType,
      store: this.store,
      inlineMaxBytes: this.inlineMaxBytes,
    });
    return {
      via: d.via,
      fileName: d.fileName,
      mimeType: d.mimeType,
      size: d.sizeBytes,
      content: d.content,
      url: d.url,
      expiresAt: d.expiresAt,
      note: d.note,
    };
  }
}

/** Default roots a per-call `dest` may resolve inside when INSYNC_OUTPUT_DIR is unset. */
export const DEFAULT_DOWNLOAD_ROOTS: readonly string[] = ['~/Downloads', '~/Documents'];

/**
 * The folders a per-call download `dest` is confined to:
 *   - `INSYNC_OUTPUT_DIR` set → exactly those (a path-delimiter list; `~` expands);
 *   - unset → `~/Downloads` and `~/Documents`.
 * Local installs only: a hosted server never writes a download to disk.
 * A blank or delimiter-only value counts as unset, so it can never disable it.
 */
export function downloadRoots(env: EnvSource = process.env): readonly string[] {
  const configured = (readEnvVar('INSYNC_OUTPUT_DIR', { env }) ?? '')
    .split(delimiter)
    .map((r) => r.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_DOWNLOAD_ROOTS;
}

/**
 * Pick the download IO from the environment, the sibling of the transport
 * selector:
 *   - hosted (`MCP_DATA_DIR` or a blob store) → the ladder with the blob store
 *     and no disk: inline, else a signed link;
 *   - local with `INSYNC_INLINE_DOWNLOADS` truthy → the ladder without a store,
 *     over-cap files saved to disk;
 *   - local otherwise → disk (the default, unchanged).
 * `store` defaults to the env's blob store; pass `null` for none.
 */
export function makeDownloadIO(
  env: EnvSource = process.env,
  store: BlobStore | null | undefined = blobStoreFromEnv(env),
): DownloadIO {
  if (store || isHostedEnv(env)) return new DeliveryLadderIO({ store: store ?? null });
  const disk = new NodeDownloadIO(downloadRoots(env));
  return parseBoolEnv('INSYNC_INLINE_DOWNLOADS', { env })
    ? new DeliveryLadderIO({ store: null, diskFallback: disk })
    : disk;
}
