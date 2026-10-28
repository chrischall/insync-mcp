// File-download tools. All three are read-only: a download retrieves bytes
// through the portal's own session-authorized endpoints and changes no portal
// state (not-persisting is the inverse). The S3 creds the login carries are
// never used here and never surface; attachment URLs stay server-side — the
// model references an attachment by its position in insync_list_attachments,
// never by a URL it could point elsewhere.

import { z } from 'zod';
import { minifiedResult } from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import type { DownloadIO, DownloadOutcome } from '../download-io.js';
import { READ, asRecordArray, tidy } from './_shared.js';
import { ASSEMBLED_VIEWS, assembledViewArg, untrustedViewResponse } from '../view.js';

/** A portal file name may be `display##_##exercise-url`; keep only the display half. */
export function splitAttachmentName(raw: unknown): { fileName: string; exerciseUrl?: string } {
  const name = typeof raw === 'string' ? raw : '';
  const at = name.indexOf('##_##');
  if (at < 0) return { fileName: name };
  return { fileName: name.slice(0, at), exerciseUrl: name.slice(at + '##_##'.length) || undefined };
}

/**
 * Whether an attachment row's file is still fetchable. The portal's own script
 * enables the download link when `FileNotExit` is truthy and disables it (with a
 * "deleted or moved" tooltip) otherwise, so truthy means present.
 */
function isPresent(row: Record<string, unknown>): boolean {
  return Boolean(row.FileNotExit);
}

/** Render a completed download: the saved path, inline base64, or a too-large note. */
function downloadResult(outcome: DownloadOutcome): CallToolResult {
  if (outcome.savedTo !== undefined) {
    return minifiedResult(
      tidy({
        saved_to: outcome.savedTo,
        file_name: outcome.fileName,
        mime_type: outcome.mimeType,
        size_bytes: outcome.size,
      }),
    );
  }
  if (outcome.tooLarge === true) {
    return minifiedResult(
      tidy({
        file_name: outcome.fileName,
        mime_type: outcome.mimeType,
        size_bytes: outcome.size,
        note:
          'This file is too large to return inline. Download it on a local install, where it ' +
          'writes to INSYNC_OUTPUT_DIR (or ~/Downloads).',
      }),
    );
  }
  return minifiedResult(
    tidy({
      file_name: outcome.fileName,
      mime_type: outcome.mimeType,
      size_bytes: outcome.size,
      base64: outcome.base64,
    }),
  );
}

export function registerDownloadTools(
  server: McpServer,
  client: InsyncClient,
  io: DownloadIO,
): void {
  server.registerTool(
    'insync_list_attachments',
    {
      description:
        'List the files attached to a secure message, by the message’s master id (from ' +
        'insync_list_messages). Returns each attachment’s name and position; use ' +
        'insync_download_attachment with that position to retrieve the file. Listing does NOT ' +
        'open or mark the message read.',
      annotations: READ,
      inputSchema: z.object({
        master_id: z
          .string()
          .min(1)
          .describe('The message’s master id (TODOMasterId) from insync_list_messages.'),
        view: assembledViewArg(),
      }),
    },
    async ({ master_id, view }) => {
      const rows = asRecordArray(await client.listAttachments(master_id));
      const items = rows.map((row, index) => {
        const { fileName, exerciseUrl } = splitAttachmentName(row.FileName);
        return tidy({ index, fileName, exerciseUrl, present: isPresent(row) });
      });
      return untrustedViewResponse({
        view,
        views: ASSEMBLED_VIEWS,
        data: items,
        whoWrote: 'Attachment file names are written by your practice.',
        context: 'Messages/GetToDoAttachments',
      });
    },
  );

  server.registerTool(
    'insync_download_attachment',
    {
      description:
        'Download one file attached to a secure message. Identify it by the message’s master id ' +
        'and the attachment’s position (index) from insync_list_attachments. On a local install ' +
        'the file is saved to disk and the path returned; on a hosted server the bytes come back ' +
        'inline. The download goes through the portal — never direct storage.',
      annotations: READ,
      inputSchema: z.object({
        master_id: z
          .string()
          .min(1)
          .describe('The message’s master id (TODOMasterId) from insync_list_messages.'),
        index: z
          .number()
          .int()
          .min(0)
          .describe('The attachment’s 0-based position from insync_list_attachments.'),
        output_dir: z
          .string()
          .optional()
          .describe(
            'Directory to save into (local install only; ignored on a hosted server, which ' +
              'returns bytes inline). Defaults to INSYNC_OUTPUT_DIR or ~/Downloads; must resolve ' +
              'inside an allowed root.',
          ),
      }),
    },
    async ({ master_id, index, output_dir }) => {
      const rows = asRecordArray(await client.listAttachments(master_id));
      const row = rows[index];
      if (row === undefined) {
        return minifiedResult({
          error: `No attachment at position ${index} on message ${master_id}.`,
          attachments: rows.length,
        });
      }
      if (!isPresent(row)) {
        return minifiedResult({
          error: 'That attachment is no longer available — the practice deleted or moved the file.',
        });
      }
      const { fileName } = splitAttachmentName(row.FileName);
      const filePath = typeof row.FilePath === 'string' ? row.FilePath : '';
      const res = await client.downloadAttachment(filePath);
      return downloadResult(
        io.deliver({
          bytes: res.bytes,
          fileName: fileName || 'attachment',
          mimeType: res.contentType,
          url: filePath,
          dest: output_dir,
        }),
      );
    },
  );

  server.registerTool(
    'insync_download_document',
    {
      description:
        'Download a document filed to the patient’s portal account. Identify it by the ' +
        'folder_url and file_name from insync_list_documents (full view). On a local install the ' +
        'file is saved to disk and the path returned; on a hosted server the bytes come back ' +
        'inline. The download goes through the portal — never direct storage.',
      annotations: READ,
      inputSchema: z.object({
        folder_url: z
          .string()
          .min(1)
          .describe('The document’s DstFolderURL from insync_list_documents (full view).'),
        file_name: z
          .string()
          .min(1)
          .describe('The document’s FileName from insync_list_documents (full view).'),
        output_dir: z
          .string()
          .optional()
          .describe(
            'Directory to save into (local install only; ignored on a hosted server, which ' +
              'returns bytes inline). Defaults to INSYNC_OUTPUT_DIR or ~/Downloads; must resolve ' +
              'inside an allowed root.',
          ),
      }),
    },
    async ({ folder_url, file_name, output_dir }) => {
      const source = await client.getFileSource(folder_url);
      if (source.status.toLowerCase() !== 'success' || source.filePath === '') {
        return minifiedResult({
          error: 'That document is not available to download.',
          status: source.status || undefined,
        });
      }
      const res = await client.downloadFile(source.filePath);
      return downloadResult(
        io.deliver({
          bytes: res.bytes,
          fileName: file_name,
          mimeType: res.contentType,
          dest: output_dir,
        }),
      );
    },
  );
}
