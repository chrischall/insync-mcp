import { describe, expect, it } from 'vitest';
import { buildComposePayload, buildReplyPayload, parseReplyForm, registerComposeTools } from '../src/tools/compose.js';
import { capture, gated, jsonOf, okJson, okText, type FakeCall } from './_tools.js';
import type { FetchResult } from '../src/transport.js';

// Synthetic portal answers in the verified shapes — no PHI.
const DETAIL = {
  Resources: [
    { UserGroupID: 401, GroupName: 'Front Desk Team', PatientID: 1 },
    { UserGroupID: 402, GroupName: 'Clinical Team', PatientID: 1 },
  ],
  Subjects: ['Appointment request', 'Medication refill request'],
  PatientSignatureDetail: { IsShowPriorityBtnInCmpsMsgScrnEnable: false },
};
const COMPOSE_FORM =
  '<input class="x hide" id="ReminderDate" name="ReminderDate" type="text" value="10/28/2026 4:01:00 PM">';
const REPLY_FORM = `
  <input type="hidden" id="lblReplyToID" value="403" />
  <input type="hidden" id="todoChildId" value="111" />
  <input type="hidden" id="todoMasterId" value="222" />
  <input type="hidden" id="ToGroupIds" value="-1" />
  <input type="hidden" id="hdnGroupName" value="Care Team" />
  <input type="hidden" id="emailhistory" value="--- From: Care Team &lt;b&gt;earlier&lt;/b&gt; &amp; more" />
  <input type="text" class="x" id="txtSubject" value="Re: Your visit" />`;
const UNREAD_NONE = { data: [], recordsTotal: 0 };
const OK_RESULT = { Result: [{ Status: 1 }] };

function portal(over: Partial<Record<string, FetchResult>> = {}) {
  return (call: FakeCall): FetchResult => {
    const key = call.path.split('?')[0]!;
    if (over[key] !== undefined) return over[key]!;
    switch (key) {
      case 'Messages/GetComposeMessageDetail':
        return okJson(DETAIL);
      case 'Messages/LoadComposeMessageDetail':
        return okText(COMPOSE_FORM);
      case 'Messages/GetComposeDetailForReply':
        return okText(REPLY_FORM);
      case 'Messages/GetMessages':
        return okJson(UNREAD_NONE);
      case 'ClinicalSummary/GetAntiForgeryToken':
        return okJson({ formToken: 'tok' });
      case 'Messages/ComposeEmail':
      case 'Messages/ReplySendEmail':
        return okJson(OK_RESULT);
      default:
        throw new Error(`unexpected call ${call.verb} ${call.path}`);
    }
  };
}

function rig(over: Partial<Record<string, FetchResult>> = {}) {
  const { handlers, transport } = capture(registerComposeTools as never, portal(over));
  return {
    transport,
    recipients: handlers.get('insync_list_message_recipients')!,
    send: gated(handlers.get('insync_send_message')!, transport),
    reply: gated(handlers.get('insync_reply_message')!, transport),
  };
}

const sentBody = (calls: FakeCall[], path: string, field: string) =>
  JSON.parse((calls.find((c) => c.path === path)!.body as Record<string, string>)[field]!) as Record<
    string,
    unknown
  >;

describe('pure builders', () => {
  it('builds the ComposeEmail objToDoNew exactly as the portal script does', () => {
    expect(
      buildComposePayload({ groupId: '401', groupName: 'Front Desk Team', subject: 'S', body: 'B' }),
    ).toEqual({
      TODOMasterId: 0,
      TaskSubject: 'S',
      TaskMessage: 'B',
      IsImportant: 'false',
      IsImportantColor: '',
      ToGroupIds: '401',
      ToGroupName: 'Front Desk Team',
      _setPatientSignature: false,
      _setPatientSignaturepath: '',
      AttachmentFileName: '',
    });
  });

  it('parses the reply form and re-escapes the quoted history', () => {
    const form = parseReplyForm(REPLY_FORM);
    expect(form).toEqual({
      masterId: '222',
      childId: '111',
      replyToGroupId: '403',
      toGroupIds: '-1',
      groupName: 'Care Team',
      history: '--- From: Care Team <b>earlier</b> & more',
      subject: 'Re: Your visit',
    });
    expect(buildReplyPayload(form!, { subject: 'Re: Your visit', body: 'Thanks' })).toEqual({
      TODOMasterId: '222',
      TODOChildId: '111',
      TaskSubject: 'Re: Your visit',
      TaskMessage: 'Thanks',
      History: '--- From: Care Team &lt;b&gt;earlier&lt;/b&gt; &amp; more',
      ToGroupIds: '-1',
      FromGroupId: '403',
      _setPatientSignature: false,
      _setPatientSignaturepath: '',
      AttachmentFileName: '',
    });
  });

  it('returns undefined for a page that is not the reply form, and defaults blank fields', () => {
    expect(parseReplyForm('<html></html>')).toBeUndefined();
    expect(parseReplyForm('<input id="todoMasterId" value="1"><input id="todoChildId" value="2">')).toEqual({
      masterId: '1',
      childId: '2',
      replyToGroupId: '',
      toGroupIds: '',
      groupName: '',
      history: '',
      subject: '',
    });
  });
});

describe('insync_list_message_recipients', () => {
  it('lists the groups a message can go to and the quick subjects', async () => {
    const r = rig();
    expect(jsonOf(await r.recipients({}))).toEqual({
      recipients: [
        { groupId: '401', name: 'Front Desk Team' },
        { groupId: '402', name: 'Clinical Team' },
      ],
      subjects: ['Appointment request', 'Medication refill request'],
    });
  });

  it('tolerates a detail with no lists', async () => {
    const r = rig({ 'Messages/GetComposeMessageDetail': okJson({}) });
    expect(jsonOf(await r.recipients({}))).toEqual({ recipients: [], subjects: [] });
  });
});

describe('insync_send_message', () => {
  const args = { to_group_id: '401', subject: 'Question', body: 'Hello there' };

  it('previews with the resolved recipient and the disclaimer, and sends nothing', async () => {
    const r = rig();
    const preview = await r.send.preview(args);
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).toContain('Front Desk Team');
    expect(JSON.stringify(preview)).toMatch(/911/);
    expect(r.transport.calls.map((c) => c.path)).toEqual(['Messages/GetComposeMessageDetail']);
  });

  it('refuses a recipient the portal does not offer, listing the valid ones', async () => {
    const r = rig();
    await expect(r.send.raw({ ...args, to_group_id: '999' })).rejects.toThrow(/999/);
    const empty = rig({ 'Messages/GetComposeMessageDetail': okJson({}) });
    await expect(empty.send.raw(args)).rejects.toMatchObject({ hint: expect.stringMatching(/Valid groups: none/) });
    await expect(r.send.raw({ ...args, to_group_id: '999' })).rejects.toMatchObject({
      hint: expect.stringMatching(/401 \(Front Desk Team\).*insync_list_message_recipients/),
    });
  });

  it('on confirm stamps the portal ReminderDate and posts objToDoNew once, never replayed', async () => {
    const r = rig();
    const out = jsonOf(await r.send.confirmed(args));
    const post = r.transport.calls.find((c) => c.path === 'Messages/ComposeEmail')!;
    expect(post.verb).toBe('postForm');
    expect(post.opts?.replay).toBe(false);
    expect(sentBody(r.transport.calls, 'Messages/ComposeEmail', 'objToDoNew')).toMatchObject({
      TODOMasterId: 0,
      ToGroupIds: '401',
      ToGroupName: 'Front Desk Team',
      TaskSubject: 'Question',
      TaskMessage: 'Hello there',
      ReminderDate: '10/28/2026 4:01:00 PM',
    });
    expect(out).toMatchObject({ sent: true, to: 'Front Desk Team', subject: 'Question' });
  });

  it('sends without a ReminderDate when the compose form carries none', async () => {
    const r = rig({ 'Messages/LoadComposeMessageDetail': okText('<form></form>') });
    await r.send.confirmed(args);
    expect(sentBody(r.transport.calls, 'Messages/ComposeEmail', 'objToDoNew')).not.toHaveProperty('ReminderDate');
  });

  it('reports a rejected send without claiming success', async () => {
    for (const answer of [{ Result: [{ Status: 0 }] }, {}, { validationMessage: 'Extentions not Supported' }]) {
      const r = rig({ 'Messages/ComposeEmail': okJson(answer) });
      await expect(r.send.confirmed(args)).rejects.toThrow(/did not accept/);
    }
  });
});

describe('insync_reply_message', () => {
  const args = { child_id: '111', master_id: '222', body: 'Thanks' };

  it('previews the reply (recipient, default subject) after confirming it is not unread', async () => {
    const r = rig();
    const preview = await r.reply.preview(args);
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).toContain('Care Team');
    expect(JSON.stringify(preview)).toContain('Re: Your visit');
    expect(r.transport.calls.map((c) => c.path.split('?')[0])).toEqual([
      'Messages/GetMessages',
      'Messages/GetComposeDetailForReply',
    ]);
  });

  it('refuses an unread message unless allow_mark_read is set', async () => {
    const unread = okJson({ data: [{ TODOChildId: 111, TODOMasterId: 222, TaskSubject: 'x' }] });
    const r = rig({ 'Messages/GetMessages': unread });
    await expect(r.reply.raw(args)).rejects.toThrow(/unread/i);
    expect(r.transport.calls.map((c) => c.path.split('?')[0])).toEqual(['Messages/GetMessages']);
    const preview = await r.reply.preview({ ...args, allow_mark_read: true });
    expect(preview.confirmToken).toEqual(expect.any(String));
  });

  it('refuses when the sender is no longer with the practice, or the form is missing', async () => {
    const inactive = REPLY_FORM.replace('value="Care Team"', 'value=""');
    await expect(rig({ 'Messages/GetComposeDetailForReply': okText(inactive) }).reply.raw(args)).rejects.toThrow(
      /no longer associated/,
    );
    await expect(
      rig({ 'Messages/GetComposeDetailForReply': okText('<div>nope</div>') }).reply.raw(args),
    ).rejects.toThrow(/reply form/);
  });

  it('on confirm posts objReplySent once with the portal ids, a custom subject and the history', async () => {
    const r = rig();
    const out = jsonOf(await r.reply.confirmed({ ...args, subject: 'Re: Custom' }));
    const post = r.transport.calls.find((c) => c.path === 'Messages/ReplySendEmail')!;
    expect(post.opts?.replay).toBe(false);
    expect(sentBody(r.transport.calls, 'Messages/ReplySendEmail', 'objReplySent')).toMatchObject({
      TODOMasterId: '222',
      TODOChildId: '111',
      TaskSubject: 'Re: Custom',
      TaskMessage: 'Thanks',
      FromGroupId: '403',
      ToGroupIds: '-1',
      History: '--- From: Care Team &lt;b&gt;earlier&lt;/b&gt; &amp; more',
    });
    expect(out).toMatchObject({ sent: true, to: 'Care Team', subject: 'Re: Custom' });
    expect(String(out.note)).toMatch(/search Sent by subject/);
  });

  it('reports an unknown outcome (not an error) when the reply is answered with a 5xx', async () => {
    const r = rig({ 'Messages/ReplySendEmail': { status: 502, body: '' } });
    expect(jsonOf(await r.reply.confirmed(args))).toMatchObject({
      status: 'unknown',
      warning: expect.stringMatching(/Sent folder/),
    });
  });

  it('reports a rejected reply without claiming success', async () => {
    const r = rig({ 'Messages/ReplySendEmail': okJson({ Result: [] }) });
    await expect(r.reply.confirmed(args)).rejects.toThrow(/did not accept/);
  });
});
