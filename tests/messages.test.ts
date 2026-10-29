import { describe, expect, it } from 'vitest';
import { registerMessageTools } from '../src/tools/messages.js';
import { capture, jsonOf, okJson, type FakeCall } from './_tools.js';

function rig(responder: (c: FakeCall) => ReturnType<typeof okJson>) {
  const { handlers, transport } = capture(registerMessageTools, responder);
  return { get: (name: string) => handlers.get(name)!, transport };
}

const LIST = {
  recordsTotal: 2,
  UnreadMessagesCount: 1,
  data: [
    {
      TODOChildId: 'C1',
      TODOMasterId: 'M1',
      GroupName: 'Example Clinic',
      ToGroupName: 'Pat Example',
      TaskSubject: 'Your lab results',
      ReminderDateText: '10/20/2026 09:00 AM',
      TotalAttachments: 1,
      IsImportant: false,
      IsFromPatient: false,
    },
  ],
};

const DETAIL = {
  PracticeName: 'Example Behavioral Health',
  MessageDetail: {
    TaskSubject: 'Your lab results',
    CreatedOnText: 'Oct 20, 2026',
    PatientName: 'Pat Example',
    TaskMessage: '<p>Hello Pat.</p><p>Your results are ready.</p>',
  },
  MessageAttachments: [
    { FileName: 'results.pdf', FilePath: 'https://secret.example/download?token=abc' },
    { FileName: 'scan.png', FILEPATH: '/docs/scan.png', Thumbnailurl: 'https://secret.example/t' },
  ],
};

describe('insync_list_messages', () => {
  it('projects each row to the ids a reader needs, wrapped as untrusted', async () => {
    const { get } = rig(() => okJson(LIST));
    const res = await get('insync_list_messages')({ folder: 'read' });
    const out = jsonOf(res);
    expect(out.untrusted_content).toBe(true);
    expect(out.total).toBe(2);
    expect(out.unreadCount).toBe(1);
    expect((out.messages as Record<string, unknown>[])[0]).toEqual({
      childId: 'C1',
      masterId: 'M1',
      from: 'Example Clinic',
      to: 'Pat Example',
      subject: 'Your lab results',
      date: '10/20/2026 09:00 AM',
      attachments: 1,
      important: false,
      fromPatient: false,
    });
  });

  it('pages via start/length and asks for the sent folder', async () => {
    const { get, transport } = rig(() => okJson(LIST));
    await get('insync_list_messages')({ folder: 'sent', page: 3, page_size: 10 });
    const path = transport.calls[0]!.path;
    expect(path).toContain('messageType=4');
    expect(path).toContain('start=20');
    expect(path).toContain('length=10');
  });

  it('full keeps the upstream payload (still untrusted-wrapped)', async () => {
    const { get } = rig(() => okJson(LIST));
    const out = jsonOf(await get('insync_list_messages')({ view: 'full' }));
    expect(out.untrusted_content).toBe(true);
    expect(out.data).toBeDefined();
  });

  it('falls back to the raw payload when data is missing', async () => {
    const { get } = rig(() => okJson({ recordsTotal: 0 }));
    const out = jsonOf(await get('insync_list_messages')({}));
    expect(out).toMatchObject({ untrusted_content: true, recordsTotal: 0 });
  });
});

describe('insync_get_message unread gate', () => {
  it('returns metadata WITHOUT fetching the detail when the message is unread', async () => {
    const { get, transport } = rig((c) =>
      c.path.includes('GetMessages') ? okJson(LIST) : okJson(DETAIL),
    );
    const out = jsonOf(await get('insync_get_message')({ child_id: 'C1', master_id: 'M1' }));
    expect(out.untrusted_content).toBe(true);
    expect(out.unread).toBe(true);
    expect((out.message as Record<string, unknown>).subject).toBe('Your lab results');
    expect(out.warning).toMatch(/allow_mark_read=true/);
    // The only call made was the unread listing; the detail was never fetched.
    expect(transport.calls.every((call) => !call.path.includes('GetMessageDetail'))).toBe(true);
  });

  it('fetches the detail when allow_mark_read is true', async () => {
    const { get, transport } = rig((c) =>
      c.path.includes('GetMessages') ? okJson(LIST) : okJson(DETAIL),
    );
    const out = jsonOf(
      await get('insync_get_message')({ child_id: 'C1', master_id: 'M1', allow_mark_read: true }),
    );
    expect(out.untrusted_content).toBe(true);
    expect(out.subject).toBe('Your lab results');
    expect(out.body).toBe('Hello Pat. Your results are ready.');
    // Attachment metadata is kept but its fetch URL is stripped.
    expect(out.attachments).toEqual([{ FileName: 'results.pdf' }, { FileName: 'scan.png' }]);
    expect(transport.calls.some((call) => call.path.includes('GetMessageDetail'))).toBe(true);
  });

  it('refuses to open the message when the unread listing was truncated and it was not seen', async () => {
    const truncated = { ...LIST, recordsTotal: 500 };
    const { get, transport } = rig((c) =>
      c.path.includes('GetMessages') ? okJson(truncated) : okJson(DETAIL),
    );
    await expect(get('insync_get_message')({ child_id: 'C9', master_id: 'M9' })).rejects.toThrow(
      /Could not confirm whether this message is unread: the unread folder has 500 messages and only 1/,
    );
    expect(transport.calls.every((call) => !call.path.includes('GetMessageDetail'))).toBe(true);
  });

  it('opens an ALREADY-READ message (not in the unread list) without the flag', async () => {
    const emptyUnread = { recordsTotal: 0, UnreadMessagesCount: 0, data: [] };
    const { get } = rig((c) =>
      c.path.includes('GetMessages') ? okJson(emptyUnread) : okJson(DETAIL),
    );
    const out = jsonOf(await get('insync_get_message')({ child_id: 'C1', master_id: 'M1' }));
    expect(out.subject).toBe('Your lab results');
  });

  it('handles a detail with no CreatedOnText, no attachments, and a non-string body', async () => {
    const bare = {
      PracticeName: 'Example Behavioral Health',
      MessageDetail: { TaskSubject: 'Reminder', CreatedOn: '2026-10-20T09:00:00', TaskMessage: null },
    };
    const { get } = rig((c) =>
      c.path.includes('GetMessages') ? okJson({ data: [] }) : okJson(bare),
    );
    const out = jsonOf(await get('insync_get_message')({ child_id: 'C1', master_id: 'M1' }));
    expect(out.sent).toBe('2026-10-20T09:00:00');
    // An empty body is dropped (tidy), as is the missing attachment list.
    expect(out).not.toHaveProperty('body');
    expect(out).not.toHaveProperty('attachments');
  });
});
