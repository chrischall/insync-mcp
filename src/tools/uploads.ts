// The one upload tool: an insurance-card image POSTed to the patient's own
// InSync profile. It is NOT read-only — the practice sees the uploaded image
// and there is no delete/undo through this server — so it is annotated
// destructive and confirm-gated like the other writes (`defineWrite` +
// `registerWrite`): the first call reads nothing from the portal, returns a
// preview + confirmToken, and only a repeat call with that token (after the
// user approved the preview) actually uploads. The upload goes through
// `sendOnce`, so a 5xx or a dropped connection after sending is reported as
// `status: "unknown"` rather than an error that reads as safe to retry.
//
// Each side's image arrives by exactly ONE route (`resolveUploadSource`,
// @chrischall/mcp-utils/export):
//   * `<side>_path` — a file on this machine (local installs only; refused on a
//     hosted server, whose disk the caller cannot fill), vetted by vetUploadFile:
//     confined to the allowed roots, no symlink, size cap, magic bytes;
//   * `<side>_inline` — `{filename, contentBase64}`, strictly decoded and capped;
//   * `<side>_blob_key` — a file the caller PUT to a signed slot from
//     `insync_upload_slots` (hosted only), read back from the blob store.
// Every route checks the type is JPEG/PNG AND that the bytes look like it.
//
// The write gate binds the exact bytes (request.body) and each side's sha256
// (in the preview), and `plan` re-resolves every source on the confirmed call,
// so a file or blob that changed since the preview is refused as DRAFT_CHANGED.
// Reading never deletes: a blob is released only after the portal ACCEPTS the
// upload — a rejection or an unknown outcome keeps it — and the release result
// is reported, never thrown (the upload has already happened).
//
// Scope note: this is the ONLY patient-facing upload the portal exposes (the
// insurance-card save in _JS_ProfileBundle). There is deliberately no generic
// document-upload tool. The upload shape is derived from the portal JS and is
// UNVERIFIED on the wire — see docs/INSYNC-API.md.

import { z } from 'zod';
import { McpToolError, defineWrite, registerWrite } from '@chrischall/mcp-utils';
import {
  blobStoreFromEnv,
  inlineFileSchema,
  isHostedEnv,
  mimeFromFileName,
  mintUploadSlot,
  resolveUploadMime,
  resolveUploadSource,
  uploadSlotRequestSchema,
  type BlobStore,
  type UploadRelease,
  type UploadSource,
} from '@chrischall/mcp-utils/export';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import { READ } from './_shared.js';
import { WRITE, compactResult, sendOnce, writeDescription } from './_writes.js';
import { healthMeta, withToolMeta } from './hints.js';

/** The image types the portal accepts. */
export const UPLOAD_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

/** Path-route extension allowlist, typed by the shared extension→MIME table. */
export const uploadMimeByExt: Readonly<Record<string, string>> = Object.fromEntries(
  ['jpg', 'jpeg', 'png'].map((ext) => [ext, mimeFromFileName(`card.${ext}`)]),
);

/** Largest insurance-card image accepted, in bytes. A card photo is well under this. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Folders a LOCAL insurance-card path may be read from. A hosted server takes
 * no paths at all (its disk is not the caller's), so there is no hosted root.
 */
export const DEFAULT_UPLOAD_ROOTS: readonly string[] = [
  '~/Downloads',
  '~/Documents',
  '~/Desktop',
  '~/Pictures',
];

/** The slot tool, named in refusals that point at it. */
const SLOT_TOOL = 'insync_upload_slots';

/**
 * Drop a `data:image/<type>;base64,` prefix if one is present, matching the
 * portal's own `FileReader` handling. The bytes this server reads off disk are
 * already raw, so this is defensive: the portal stores the base64 verbatim, and
 * a stray data-URL prefix would corrupt the saved image.
 */
export function stripDataUrlPrefix(value: string): string {
  return value.replace(/^data:image\/[a-z]+;base64,/i, '');
}

/** The SaveInsuranceCardImages form: base64 front/back (prefix stripped), empties otherwise. */
export function buildInsuranceForm(input: {
  front?: Uint8Array;
  back?: Uint8Array;
}): Record<string, string> {
  const b64 = (bytes?: Uint8Array): string =>
    bytes === undefined ? '' : stripDataUrlPrefix(Buffer.from(bytes).toString('base64'));
  return {
    FrontImage: b64(input.front),
    BackImage: b64(input.back),
    DocManagerImagePath: '',
    ScannerName: '',
  };
}

/** Options for {@link registerUploadTools}. */
export interface UploadToolOptions {
  /** Where a local `*_path` may be read from. Default {@link DEFAULT_UPLOAD_ROOTS}. */
  allowedRoots?: readonly string[] | 'unconfined';
  /** Largest file accepted. Default {@link MAX_UPLOAD_BYTES}. */
  maxBytes?: number;
  /** The blob store (slots + blob keys). Default `blobStoreFromEnv()` per call; `null` for none. */
  store?: BlobStore | null;
  /** True on a hosted deployment (paths refused). Default `isHostedEnv()` per call. */
  hosted?: boolean;
}

/** One side's source arguments, as the schema parses them. */
interface SideArgs {
  path?: string;
  inline?: z.infer<typeof inlineFileSchema>;
  blobKey?: string;
}

/** An empty string is "not given", so `front_path: ''` reads as a missing source. */
const given = (v: string | undefined): string | undefined => (v === '' ? undefined : v);

/** What deleting one side's blob achieved, for the result. */
type Cleanup = { side: 'front' | 'back' } & ({ deleted: true } | { deleted: false; error: string });

/** Release every blob-store source (after the portal accepted), reporting each. Never throws. */
async function releaseAll(
  sides: { side: 'front' | 'back'; source: UploadSource }[],
): Promise<Cleanup[] | undefined> {
  const blobs = sides.filter((s) => s.source.origin === 'blob');
  if (blobs.length === 0) return undefined;
  const out: Cleanup[] = [];
  for (const { side, source } of blobs) {
    // A blob source's release never answers `deleted: null` (that is path/inline).
    const r = (await source.release()) as Exclude<UploadRelease, { deleted: null }>;
    out.push(r.deleted ? { side, deleted: true } : { side, deleted: false, error: r.error });
  }
  return out;
}

/** Which sides a `side` argument asks for. */
function sidesFor(side: 'front' | 'back' | 'both'): { front: boolean; back: boolean } {
  return { front: side !== 'back', back: side !== 'front' };
}

export function registerUploadTools(
  server: McpServer,
  client: InsyncClient,
  opts: UploadToolOptions = {},
): void {
  const allowedRoots = opts.allowedRoots ?? DEFAULT_UPLOAD_ROOTS;
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const store = (): BlobStore | undefined =>
    opts.store === undefined ? blobStoreFromEnv() : (opts.store ?? undefined);

  const resolveSide = (side: 'front' | 'back', a: SideArgs): Promise<UploadSource> =>
    resolveUploadSource(
      { path: given(a.path), inline: a.inline, blobKey: given(a.blobKey) },
      {
        maxBytes,
        allowedMimeTypes: UPLOAD_MIME_TYPES,
        path: { mimeByExt: uploadMimeByExt, allowedRoots },
        store: store() ?? null,
        hosted: opts.hosted ?? isHostedEnv(),
        names: {
          path: `${side}_path`,
          inline: `${side}_inline`,
          blobKey: `${side}_blob_key`,
          slotTool: SLOT_TOOL,
        },
      },
    );

  server.registerTool(
    SLOT_TOOL,
    {
      _meta: healthMeta('other', { aliases: ['upload insurance card photo'] }),
      description:
        'Get signed upload URLs for insurance-card images (JPG, JPEG or PNG), for a hosted server ' +
        'that cannot read files on your machine. PUT each file to its uploadUrl (the returned curl ' +
        'command does it), then pass its blobKey to insync_upload_insurance_card as front_blob_key or ' +
        'back_blob_key. Changes nothing on the portal; each URL is a short-lived credential to write ' +
        'that one file, so share it with no one else.',
      annotations: READ,
      inputSchema: z.object({
        files: z
          .array(uploadSlotRequestSchema)
          .min(1)
          .max(2)
          .describe('One entry per card side to upload (at most 2): the image filename, e.g. "front.jpg".'),
      }),
    },
    async ({ files }) => {
      const s = store();
      if (s === undefined) {
        throw new McpToolError(
          'Upload slots need the blob store a hosted deployment provides, and this server has no blob store. ' +
            'Pass front_path/back_path (a local file) or front_inline/back_inline (base64) to ' +
            'insync_upload_insurance_card instead.',
        );
      }
      for (const f of files) {
        const mime = resolveUploadMime(f.filename, f.mimeType);
        if (!UPLOAD_MIME_TYPES.includes(mime)) {
          throw new McpToolError(
            `${f.filename}: ${mime} is not accepted here (accepted: ${UPLOAD_MIME_TYPES.join(', ')}).`,
          );
        }
      }
      return compactResult({
        slots: files.map((f) => mintUploadSlot(s, f)),
        next:
          'PUT each file to its uploadUrl with exactly its Content-Type (the curl does), then call ' +
          'insync_upload_insurance_card with front_blob_key / back_blob_key set to the blobKey values. ' +
          'The uploaded copy is deleted once the portal accepts it.',
      });
    },
  );

  withToolMeta(server, healthMeta('send', { aliases: ['insurance card', 'upload my insurance'] }), () =>
    registerWrite(
      server,
      defineWrite({
        name: 'insync_upload_insurance_card',
        description: writeDescription(
          'Upload a photo of your insurance card (front, back, or both) to your own InSync ' +
            'patient profile (JPG, JPEG or PNG). Give each side exactly one of: <side>_path (a file on ' +
            'this machine — local installs only), <side>_inline (base64, for a small image), or ' +
            '<side>_blob_key (from insync_upload_slots, on a hosted server). This WRITES to the portal: ' +
            'the practice sees the uploaded image and there is no delete or undo through this server, ' +
            'so it is irreversible.',
        ),
        annotations: WRITE,
        inputSchema: z.object({
          side: z
            .enum(['front', 'back', 'both'])
            .describe('Which side(s) to upload: front, back, or both.'),
          front_path: z
            .string()
            .optional()
            .describe('FRONT image as a path on this machine (local installs only; refused when hosted).'),
          front_inline: inlineFileSchema
            .optional()
            .describe('FRONT image as base64 {filename, contentBase64} — for a small image.'),
          front_blob_key: z
            .string()
            .optional()
            .describe('FRONT image as the blobKey from insync_upload_slots, after PUTting the file.'),
          back_path: z
            .string()
            .optional()
            .describe('BACK image as a path on this machine (local installs only; refused when hosted).'),
          back_inline: inlineFileSchema
            .optional()
            .describe('BACK image as base64 {filename, contentBase64} — for a small image.'),
          back_blob_key: z
            .string()
            .optional()
            .describe('BACK image as the blobKey from insync_upload_slots, after PUTting the file.'),
        }),
        async plan(args) {
          const side = args.side;
          const want = sidesFor(side);
          // Resolve (and validate) every wanted side BEFORE anything is shown or
          // sent. No portal request is made, and nothing is deleted: a blob is
          // only read, so the preview call and the confirmed call each read it.
          const front = want.front
            ? await resolveSide('front', {
                path: args.front_path,
                inline: args.front_inline,
                blobKey: args.front_blob_key,
              })
            : undefined;
          const back = want.back
            ? await resolveSide('back', {
                path: args.back_path,
                inline: args.back_inline,
                blobKey: args.back_blob_key,
              })
            : undefined;
          const sides = [
            ...(front ? [{ side: 'front' as const, source: front }] : []),
            ...(back ? [{ side: 'back' as const, source: back }] : []),
          ];

          const body = buildInsuranceForm({ front: front?.bytes, back: back?.bytes });
          const files = sides.map(({ side: which, source }) => ({
            side: which,
            name: source.fileName,
            type: source.mimeType,
            size: source.sizeBytes,
            source: source.origin,
            sha256: source.sha256,
          }));

          // `plan` runs on EVERY call, so the gate is rebuilt from the current
          // arguments and re-resolved files (each side's sha256 is in `files`). registerWrite hands the whole gate to
          // confirmWrite: the exact bytes (request.body) AND the shown preview are
          // bound into the token, so a file or argument that changed since the
          // preview is refused as DRAFT_CHANGED. `willSend` keeps the base64 out
          // of the preview the user reads, while the real body stays bound. The
          // anti-forgery token is NOT bound — client.upload mints a fresh one for
          // whichever session is live.
          const label = side === 'both' ? 'front and back' : side;
          return {
            gate: {
              action: 'insync.upload_insurance_card',
              summary: `Upload your insurance card (${label}) to your InSync profile`,
              account: undefined,
              target: side,
              request: { method: 'POST', path: 'PatientProfile/SaveInsuranceCardImages', body },
              willSend: { files },
              preview: {
                warning:
                  'This uploads to your InSync profile; the practice can see it and this server cannot ' +
                  'remove it.',
              },
            },
            state: { body, files, sides },
          };
        },
        async execute({ body, files, sides }) {
          return sendOnce(
            async () => {
              const result = await client.upload('PatientProfile/SaveInsuranceCardImages', body);
              // Only now — the portal accepted — is an uploaded blob deleted. A
              // rejection (thrown above) or an unknown outcome keeps it.
              const blobCleanup = await releaseAll(sides);
              return {
                uploaded: files.map((f) => ({ side: f.side, name: f.name, size: f.size })),
                status: result.status,
                ...(blobCleanup ? { blob_cleanup: blobCleanup } : {}),
                note:
                  'The image is now on your InSync profile and visible to the practice; this server ' +
                  'cannot remove it.',
              };
            },
            'insurance-card upload',
            'your InSync profile',
          );
        },
        render: compactResult,
      }),
    ),
  );
}
