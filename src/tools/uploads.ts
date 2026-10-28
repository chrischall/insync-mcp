// The one upload tool: an insurance-card image POSTed to the patient's own
// InSync profile. It is NOT read-only — the practice sees the uploaded image
// and there is no delete/undo through this server — so it is annotated
// destructive and gated by `confirmWrite`: the first call reads nothing from the
// portal, returns a preview + confirmToken, and only a repeat call with that
// token (after the user approved the preview) actually uploads.
//
// Two safety boundaries before a byte leaves the machine:
//   * vetUploadFile confines the source path to the allowed roots, refuses a
//     symlink / non-image / oversize file, and reads the bytes from the one
//     vetted descriptor (so nothing can be swapped in after the checks);
//   * confirmWrite binds the exact bytes + the shown preview into the token, so
//     a file (or argument) that changed between the preview and the confirmed
//     call is refused as DRAFT_CHANGED.
//
// Scope note: this is the ONLY patient-facing upload the portal exposes (the
// insurance-card save in _JS_ProfileBundle). There is deliberately no generic
// document-upload tool. The upload shape is derived from the portal JS and is
// UNVERIFIED on the wire — see docs/INSYNC-API.md.

import { join } from 'node:path';
import { z } from 'zod';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  McpToolError,
  confirmTokenParam,
  confirmWrite,
  minifiedResult,
  readEnvVar,
  toolAnnotations,
  vetUploadFile,
  type EnvSource,
  type VettedUpload,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';

/** The image types the portal accepts, lower-case extension → the MIME it is sent as. */
export const UPLOAD_MIME_BY_EXT: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** Largest insurance-card image accepted, in bytes. A card photo is well under this. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Folders an insurance-card image may be read from when none is configured. */
export const DEFAULT_UPLOAD_ROOTS: readonly string[] = [
  '~/Downloads',
  '~/Documents',
  '~/Desktop',
  '~/Pictures',
];

/**
 * The folders a per-call upload path is confined to:
 *   - hosted (`MCP_DATA_DIR`) → `$MCP_DATA_DIR/uploads` only (the only disk the
 *     runner and the user share);
 *   - otherwise → the user's usual media folders.
 * A blank `MCP_DATA_DIR` counts as unset.
 */
export function uploadRoots(env: EnvSource = process.env): readonly string[] {
  const dataDir = readEnvVar('MCP_DATA_DIR', { env });
  if (dataDir !== undefined && dataDir.trim() !== '') return [join(dataDir.trim(), 'uploads')];
  return DEFAULT_UPLOAD_ROOTS;
}

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

/** Options for {@link registerUploadTools}; `allowedRoots` is resolved at boot from the env. */
export interface UploadToolOptions {
  allowedRoots: readonly string[] | 'unconfined';
  /** Largest file accepted. Default {@link MAX_UPLOAD_BYTES}. */
  maxBytes?: number;
}

/** Which sides a `side` argument asks for. */
function sidesFor(side: 'front' | 'back' | 'both'): { front: boolean; back: boolean } {
  return { front: side !== 'back', back: side !== 'front' };
}

export function registerUploadTools(
  server: McpServer,
  client: InsyncClient,
  opts: UploadToolOptions,
): void {
  const allowedRoots = opts.allowedRoots;
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;

  server.registerTool(
    'insync_upload_insurance_card',
    {
      description:
        'Upload a photo of your insurance card (front, back, or both) to your own InSync ' +
        'patient profile, from a local image file (JPG, JPEG or PNG). This WRITES to the portal: ' +
        'the practice sees the uploaded image and there is no delete or undo through this server, ' +
        'so it is irreversible. ' +
        CONFIRM_FLOW_SENTENCE +
        ' ' +
        CONFIRM_INJECTION_RULE,
      annotations: toolAnnotations({ readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        side: z
          .enum(['front', 'back', 'both'])
          .describe('Which side(s) to upload: front, back, or both.'),
        front_path: z
          .string()
          .optional()
          .describe('Local path to the FRONT image (JPG/JPEG/PNG). Required for side front or both.'),
        back_path: z
          .string()
          .optional()
          .describe('Local path to the BACK image (JPG/JPEG/PNG). Required for side back or both.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ side, front_path, back_path, confirmToken }, ctx) => {
      const want = sidesFor(side);
      if (want.front && (front_path === undefined || front_path === '')) {
        throw new McpToolError('front_path is required to upload the front of the card.', {
          hint: 'Pass front_path (a local JPG/JPEG/PNG), or use side="back" to upload only the back.',
        });
      }
      if (want.back && (back_path === undefined || back_path === '')) {
        throw new McpToolError('back_path is required to upload the back of the card.', {
          hint: 'Pass back_path (a local JPG/JPEG/PNG), or use side="front" to upload only the front.',
        });
      }

      // Vet (and read) the files BEFORE anything is shown or sent. On the preview
      // call this only touches the local filesystem — no portal request is made.
      const vet = (path: string): Promise<VettedUpload> =>
        vetUploadFile(path, { mimeByExt: UPLOAD_MIME_BY_EXT, maxBytes, allowedRoots, readAll: true });
      const front = want.front ? await vet(front_path as string) : undefined;
      const back = want.back ? await vet(back_path as string) : undefined;

      const body = buildInsuranceForm({ front: front?.bytes, back: back?.bytes });
      const files = [
        ...(front ? [{ side: 'front', name: front.requested, type: front.mime, size: front.size }] : []),
        ...(back ? [{ side: 'back', name: back.requested, type: back.mime, size: back.size }] : []),
      ];

      // Gate on EVERY call with the request rebuilt from the current arguments.
      // The exact bytes (request.body) AND the shown preview are bound into the
      // token, so a file or argument that changed since the preview is refused as
      // DRAFT_CHANGED. `willSend` keeps the base64 out of the preview the user
      // reads, while the real body stays bound. The anti-forgery token is NOT
      // bound — client.upload mints a fresh one for whichever session is live.
      const label = side === 'both' ? 'front and back' : side;
      const gate = await confirmWrite(ctx, {
        tool: 'insync_upload_insurance_card',
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
        args: { side, front_path, back_path },
        confirmToken,
      });
      if (gate) return gate;

      const result = await client.upload('PatientProfile/SaveInsuranceCardImages', body);
      return minifiedResult({
        uploaded: files.map((f) => ({ side: f.side, name: f.name, size: f.size })),
        status: result.status,
        note: 'The image is now on your InSync profile and visible to the practice; this server ' +
          'cannot remove it.',
      });
    },
  );
}
