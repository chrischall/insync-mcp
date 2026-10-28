// Secure-message writes: send a new message to a practice group, or reply to
// one. Both are confirm-gated (`defineWrite` + `registerWrite`): the practice
// receives the message and there is no unsend.
//
// Shapes are derived from the portal's `_bundles_Revamp_messagesScript` and the
// compose/reply partial views, with the recipient list and the reply form
// verified live (read-only). Both sends — a new message and a reply — were
// verified live on 2026-10-28 (owner-supervised); see docs/INSYNC-API.md. Attachments and the patient-signature option are not
// offered: both need a file/signature capture this server does not do.

import { z } from 'zod';
import { McpToolError, NonEmptyString, NumericIdString, defineWrite, registerWrite } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import { htmlEscapeText, inputValue } from '../forms.js';
import { READ, asRecord, asRecordArray, sameId } from './_shared.js';
import { WRITE, compactResult, sendOnce, writeDescription } from './_writes.js';

/** The portal's own compose-screen disclaimer the user ticks before sending. */
export const MESSAGE_DISCLAIMER =
  'The information in this message may not be reviewed in a timely manner. If you require ' +
  'immediate attention, go to your nearest hospital or call 911.';

/** The `objToDoNew` ComposeEmail posts, as the portal script builds it (no attachment, no signature). */
export function buildComposePayload(input: {
  groupId: string;
  groupName: string;
  subject: string;
  body: string;
}): Record<string, unknown> {
  return {
    TODOMasterId: 0,
    TaskSubject: input.subject,
    TaskMessage: input.body,
    IsImportant: 'false',
    IsImportantColor: '',
    ToGroupIds: input.groupId,
    ToGroupName: input.groupName,
    _setPatientSignature: false,
    _setPatientSignaturepath: '',
    AttachmentFileName: '',
  };
}

/** The hidden fields of the reply partial (`GetComposeDetailForReply`). */
export interface ReplyForm {
  masterId: string;
  childId: string;
  replyToGroupId: string;
  toGroupIds: string;
  /** The replying-to group's name; empty when that staff member left the practice. */
  groupName: string;
  /** The quoted thread, entity-decoded (as `.val()` reads it). */
  history: string;
  /** The portal's prefilled `Re: …` subject. */
  subject: string;
}

/** Read the reply partial; `undefined` when the page is not the reply form. */
export function parseReplyForm(html: string): ReplyForm | undefined {
  const masterId = inputValue(html, 'todoMasterId');
  const childId = inputValue(html, 'todoChildId');
  if (masterId === undefined || childId === undefined) return undefined;
  return {
    masterId,
    childId,
    replyToGroupId: inputValue(html, 'lblReplyToID') ?? '',
    toGroupIds: inputValue(html, 'ToGroupIds') ?? '',
    groupName: inputValue(html, 'hdnGroupName') ?? '',
    history: inputValue(html, 'emailhistory') ?? '',
    subject: inputValue(html, 'txtSubject') ?? '',
  };
}

/** The `objReplySent` ReplySendEmail posts; the history is re-escaped as the portal does. */
export function buildReplyPayload(
  form: ReplyForm,
  input: { subject: string; body: string },
): Record<string, unknown> {
  return {
    TODOMasterId: form.masterId,
    TODOChildId: form.childId,
    TaskSubject: input.subject,
    TaskMessage: input.body,
    History: htmlEscapeText(form.history),
    ToGroupIds: form.toGroupIds,
    FromGroupId: form.replyToGroupId,
    _setPatientSignature: false,
    _setPatientSignaturepath: '',
    AttachmentFileName: '',
  };
}

/** The recipients and quick subjects the compose screen offers. */
function projectComposeDetail(raw: unknown): {
  recipients: { groupId: string; name: string }[];
  subjects: string[];
} {
  const data = asRecord(raw);
  return {
    recipients: asRecordArray(data.Resources).map((r) => ({
      groupId: String(r.UserGroupID),
      name: String(r.GroupName),
    })),
    subjects: Array.isArray(data.Subjects) ? data.Subjects.map(String) : [],
  };
}

/** Both send endpoints answer `Result[0].Status > 0` on success. */
function assertSent(data: Record<string, unknown>, what: string): void {
  const status = Number(asRecord(asRecordArray(data.Result)[0]).Status);
  if (!(status > 0)) {
    throw new McpToolError(`InSync did not accept the ${what}.`, {
      hint: 'Nothing was sent. The portal rejected it, or its send flow changed; see docs/INSYNC-API.md.',
    });
  }
}

export function registerComposeTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_list_message_recipients',
    {
      description:
        'List who you can send a secure message to (the practice groups, with the group id ' +
        'insync_send_message takes) and the practice’s suggested subjects. Changes nothing.',
      annotations: READ,
      inputSchema: z.object({}),
    },
    async () => compactResult(projectComposeDetail(await client.getComposeDetail())),
  );

  registerWrite(
    server,
    defineWrite({
      name: 'insync_send_message',
      description: writeDescription(
        'Send a NEW secure message to a group at your practice (get group ids from ' +
          'insync_list_message_recipients). The practice receives it and it cannot be unsent. ' +
          'Not for emergencies: the practice may not read it promptly. Use insync_reply_message ' +
          'to answer an existing message.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        to_group_id: NumericIdString.describe('Recipient group id, from insync_list_message_recipients.'),
        subject: NonEmptyString.max(200).describe('Message subject.'),
        body: NonEmptyString.max(10000).describe('Message text (plain text).'),
      }),
      async plan({ to_group_id, subject, body }) {
        const { recipients } = projectComposeDetail(await client.getComposeDetail());
        const to = recipients.find((r) => r.groupId === to_group_id);
        if (to === undefined) {
          throw new McpToolError(`Group ${to_group_id} is not one you can message.`, {
            hint:
              `Valid groups: ${recipients.map((r) => `${r.groupId} (${r.name})`).join(', ') || 'none'}. ` +
              'See insync_list_message_recipients.',
          });
        }
        const payload = buildComposePayload({ groupId: to.groupId, groupName: to.name, subject, body });
        return {
          gate: {
            action: 'insync.send_message',
            summary: `Send a secure message to ${to.name} at your practice`,
            account: undefined,
            target: to.groupId,
            request: { method: 'POST', path: 'Messages/ComposeEmail', body: payload },
            willSend: { to: to.name, subject, body },
            preview: { disclaimer: MESSAGE_DISCLAIMER },
          },
          state: { payload, to: to.name, subject },
        };
      },
      async execute({ payload, to, subject }) {
        // ReminderDate is the send time the portal stamps into its compose form.
        // It moves every minute, so it is read at send time and not bound.
        const reminderDate = inputValue(await client.getComposeForm(), 'ReminderDate');
        const objToDoNew = JSON.stringify({ ...payload, ReminderDate: reminderDate });
        return sendOnce(
          async () => {
            assertSent(await client.submitFormJson('Messages/ComposeEmail', { objToDoNew }), 'message');
            return { sent: true, to, subject };
          },
          'message',
          'your Sent folder (insync_list_messages folder=sent)',
        );
      },
      render: compactResult,
    }),
  );

  registerWrite(
    server,
    defineWrite({
      name: 'insync_reply_message',
      description: writeDescription(
        'Reply to a secure message from your practice (ids from insync_list_messages). The ' +
          'practice receives it and it cannot be unsent. Opening the reply form on an UNREAD ' +
          'message may mark it read, so an unread message is refused unless allow_mark_read is ' +
          'true. Not for emergencies.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        child_id: NumericIdString.describe('TODOChildId of the message, from insync_list_messages.'),
        master_id: NumericIdString.describe('TODOMasterId of the message, from insync_list_messages.'),
        body: NonEmptyString.max(10000).describe('Reply text (plain text).'),
        subject: NonEmptyString.max(200)
          .optional()
          .describe('Subject. Default: the portal’s own "Re: …" subject.'),
        allow_mark_read: z
          .boolean()
          .default(false)
          .describe('Set true ONLY after the user agrees an unread message may be marked read.'),
      }),
      async plan({ child_id, master_id, body, subject, allow_mark_read }) {
        if (!allow_mark_read) {
          const unread = await client.listMessages({ folder: 'unread', length: 200 });
          const isUnread = asRecordArray(asRecord(unread).data).some(
            (r) => sameId(r.TODOChildId, child_id) && sameId(r.TODOMasterId, master_id),
          );
          if (isUnread) {
            throw new McpToolError('This message is unread; opening its reply form may mark it read.', {
              hint: 'The practice can see that. Re-call with allow_mark_read=true after the user agrees.',
            });
          }
        }
        const form = parseReplyForm(await client.getReplyForm(child_id, master_id));
        if (form === undefined) {
          throw new McpToolError('InSync did not return a reply form for this message.', {
            hint: 'Check the ids against insync_list_messages; the message may not accept replies.',
          });
        }
        if (form.groupName === '') {
          throw new McpToolError(
            'The team member who sent this message is no longer associated with the practice.',
            { hint: 'Send a new message to a current group instead (insync_send_message).' },
          );
        }
        const finalSubject = subject ?? form.subject;
        const payload = buildReplyPayload(form, { subject: finalSubject, body });
        return {
          gate: {
            action: 'insync.reply_message',
            summary: `Reply to ${form.groupName} at your practice`,
            account: undefined,
            target: `${child_id}/${master_id}`,
            request: { method: 'POST', path: 'Messages/ReplySendEmail', body: payload },
            willSend: { to: form.groupName, subject: finalSubject, body },
            preview: { disclaimer: MESSAGE_DISCLAIMER },
          },
          state: { payload, to: form.groupName, subject: finalSubject },
        };
      },
      async execute({ payload, to, subject }) {
        const objReplySent = JSON.stringify(payload);
        return sendOnce(
          async () => {
            assertSent(await client.submitFormJson('Messages/ReplySendEmail', { objReplySent }), 'reply');
            return {
              sent: true,
              to,
              subject,
              note: 'The Sent folder orders by when the thread began, so an old thread’s reply may ' +
                'not be at the top; search Sent by subject to find it.',
            };
          },
          'reply',
          'your Sent folder (insync_list_messages folder=sent)',
        );
      },
      render: compactResult,
    }),
  );
}
