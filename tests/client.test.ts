import { describe, expect, it } from 'vitest';
import { WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
import { InsyncClient, InsyncNotSignedInError, isSignedOut, type TransportMode } from '../src/client.js';
import { SecretScrubber } from '../src/secrets.js';
import type {
  BinaryFetchResult,
  FetchResult,
  InsyncTransport,
  RequestOptions,
  S3Config,
} from '../src/transport.js';

interface Call {
  verb: 'getJson' | 'postJson' | 'postForm' | 'getText' | 'postText' | 'getBinary' | 'postBinary';
  path: string;
  body?: unknown;
  opts?: RequestOptions;
}

class FakeTransport implements InsyncTransport {
  calls: Call[] = [];
  s3: S3Config | undefined;
  binary: BinaryFetchResult = { status: 200, body: '', bytes: new Uint8Array() };
  constructor(private readonly responder: (call: Call) => FetchResult) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  status(): unknown {
    return {};
  }
  getS3Config(): S3Config | undefined {
    return this.s3;
  }
  private record(call: Call): FetchResult {
    this.calls.push(call);
    return this.responder(call);
  }
  getJson(path: string, opts?: RequestOptions): Promise<FetchResult> {
    return Promise.resolve(this.record({ verb: 'getJson', path, opts }));
  }
  postJson(path: string, body: unknown, opts?: RequestOptions): Promise<FetchResult> {
    return Promise.resolve(this.record({ verb: 'postJson', path, body, opts }));
  }
  postForm(
    path: string,
    form: Record<string, string> | URLSearchParams,
    opts?: RequestOptions,
  ): Promise<FetchResult> {
    return Promise.resolve(this.record({ verb: 'postForm', path, body: form, opts }));
  }
  getText(path: string, opts?: RequestOptions): Promise<FetchResult> {
    return Promise.resolve(this.record({ verb: 'getText', path, opts }));
  }
  postText(path: string, body: string, opts?: RequestOptions): Promise<FetchResult> {
    return Promise.resolve(this.record({ verb: 'postText', path, body, opts }));
  }
  getBinary(path: string, opts?: RequestOptions): Promise<BinaryFetchResult> {
    this.calls.push({ verb: 'getBinary', path, opts });
    return Promise.resolve(this.binary);
  }
  postBinary(path: string, body: unknown, opts?: RequestOptions): Promise<BinaryFetchResult> {
    this.calls.push({ verb: 'postBinary', path, body, opts });
    return Promise.resolve(this.binary);
  }
}

const ok = (body: string, extra: Partial<FetchResult> = {}): FetchResult => ({
  status: 200,
  body,
  ...extra,
});
const LOGIN = '<html><head><title>Portal :: Login</title></head><body></body></html>';

function client(
  responder: (call: Call) => FetchResult,
  opts: { mode?: TransportMode; scrubber?: SecretScrubber; portalHost?: string } = {},
): { c: InsyncClient; t: FakeTransport } {
  const t = new FakeTransport(responder);
  return { c: new InsyncClient({ transport: t, ...opts }), t };
}

describe('isSignedOut', () => {
  it('flags the login page, an isTimeout body, and a 302 to /Login', () => {
    expect(isSignedOut({ status: 200, body: LOGIN })).toBe(true);
    expect(isSignedOut({ status: 200, body: '{"isTimeout":true,"redirectUrl":"/Login"}' })).toBe(true);
    expect(isSignedOut({ status: 302, body: '', url: 'https://x.insynchcs.com/Login' })).toBe(true);
  });
  it('does not flag a normal JSON body or an unrelated redirect', () => {
    expect(isSignedOut({ status: 200, body: '{"data":[]}' })).toBe(false);
    expect(isSignedOut({ status: 302, body: '', url: 'https://x.insynchcs.com/Dashboard' })).toBe(false);
    expect(isSignedOut({ status: 302, body: '' })).toBe(false);
  });
});

describe('InsyncClient reads', () => {
  it('posts the dashboard count with an empty body', async () => {
    const { c, t } = client(() => ok('{"Dashboard":[{}]}'));
    await c.getCounts();
    expect(t.calls[0]).toMatchObject({ verb: 'postJson', path: 'Dashboard/GetDashBoradCount', body: {} });
  });

  it('posts the balance', async () => {
    const { c, t } = client(() => ok('{"Dashboard":{"PaymentSummaryModel":[{}]}}'));
    await c.getBalance();
    expect(t.calls[0]?.path).toBe('Dashboard/GetPateintBalance');
  });

  it('lists upcoming appointments ascending and past descending', async () => {
    const { c, t } = client(() => ok('{"currentAppointment":{"Appointment":[]}}'));
    await c.listAppointments('upcoming');
    await c.listAppointments('past', { pageSize: 5, currentPage: 2 });
    expect(t.calls[0]).toMatchObject({
      path: 'PatientScheduler/FutureAppiontmentDetails',
      body: { pageOptions: { PageSize: 20, CurrentPage: 1 }, sortOptions: { Direction: 'ASC' } },
    });
    expect(t.calls[1]).toMatchObject({
      path: 'PatientScheduler/PastAppiontmentDetails',
      body: { pageOptions: { PageSize: 5, CurrentPage: 2 }, sortOptions: { Direction: 'DESC' } },
    });
  });

  it('sends the calendar month as given', async () => {
    const { c, t } = client(() => ok('{"appointments":[],"totalCount":0}'));
    await c.getAppointmentCalendar('10/01/2026', '10/31/2026');
    expect(t.calls[0]).toMatchObject({
      path: 'PatientScheduler/MonthlyAppointments',
      body: { FromDate: '10/01/2026', ToDate: '10/31/2026' },
    });
  });

  it('maps medication status to the portal Type code', async () => {
    const { c, t } = client(() => ok('{"data":[]}'));
    await c.listMedications('current');
    await c.listMedications('discontinued', { start: 10, length: 50 });
    await c.listMedications('cancelled');
    expect(t.calls[0]?.path).toContain('objMedicationsSummary=' + encodeURIComponent('{"Type":"82"}'));
    expect(t.calls[1]?.path).toContain(encodeURIComponent('{"Type":"68"}'));
    expect(t.calls[1]?.path).toContain('start=10');
    expect(t.calls[1]?.path).toContain('length=50');
    expect(t.calls[2]?.path).toContain(encodeURIComponent('{"Type":"78"}'));
  });

  it('lists allergies with an empty filter object', async () => {
    const { c, t } = client(() => ok('{"data":[]}'));
    await c.listAllergies();
    expect(t.calls[0]?.path).toContain('GetAllergiesGridData?');
    expect(t.calls[0]?.path).toContain('objAllergie=' + encodeURIComponent('{}'));
  });

  it('maps message folder to messageType and threads the filters', async () => {
    const { c, t } = client(() => ok('{"data":[]}'));
    await c.listMessages({ folder: 'unread' });
    await c.listMessages({ folder: 'sent', search: 'bill', hasAttachment: true, archived: true, start: 5, length: 10, draw: 3 });
    expect(t.calls[0]?.path).toContain('messageType=1');
    expect(t.calls[1]?.path).toContain('messageType=4');
    expect(t.calls[1]?.path).toContain('searchStr=bill');
    expect(t.calls[1]?.path).toContain('hasAttachment=true');
    expect(t.calls[1]?.path).toContain('IsArchived=true');
  });

  it('reads the two folder codes for read messages too', async () => {
    const { c, t } = client(() => ok('{"data":[]}'));
    await c.listMessages({ folder: 'read' });
    expect(t.calls[0]?.path).toContain('messageType=2');
  });

  it('builds the message-detail query with the misspelled master-id param', async () => {
    const { c, t } = client(() => ok('{"MessageDetail":{}}'));
    await c.getMessageDetail({ childId: 'C1', masterId: 'M1' });
    await c.getMessageDetail({ childId: 'C2', masterId: 'M2', type: 'sent' });
    expect(t.calls[0]?.path).toContain('toDoChildId=C1');
    expect(t.calls[0]?.path).toContain('todoMasaterId=M1');
    expect(t.calls[0]?.path).toContain('type=inbox');
    expect(t.calls[1]?.path).toContain('type=sent');
  });

  it('posts the forms, documents and profile reads', async () => {
    const { c, t } = client(() => ok('{"PatientFormcollection":[]}'));
    await c.listForms();
    await c.listDocuments();
    await c.getProfile();
    expect(t.calls.map((x) => x.path)).toEqual([
      'PatientDocument/GetPatientFromList',
      'PatientDocument/GetAllPatientDocs',
      'PatientProfile/GetPatientDetails',
    ]);
  });

  it('returns survey and refill HTML verbatim', async () => {
    const { c, t } = client(() => ok('<table><tr><td>Survey</td></tr></table>'));
    expect(await c.listSurveys()).toContain('<tr>');
    expect(t.calls[0]).toMatchObject({ verb: 'getText', path: 'SurveyForms/GetReceivedSurveyForms' });
    const r = client(() => ok('<table><tr><td>Refill</td></tr></table>'));
    expect(await r.c.listRefillRequests()).toContain('Refill');
    expect(await r.c.listRefillRequests({ draw: 2, start: 5, length: 10 })).toContain('Refill');
    expect(r.t.calls[0]).toMatchObject({ verb: 'postForm', path: 'RefillPrescription/RefillPrescripationGrid' });
    expect(r.t.calls[1]?.body).toMatchObject({ draw: '2', start: '5', length: '10' });
  });

  it('exposes the transport S3 config', () => {
    const { c, t } = client(() => ok('{}'));
    t.s3 = { enabled: true, bucketName: 'b' };
    expect(c.getS3Config()).toEqual({ enabled: true, bucketName: 'b' });
  });

  it('delegates start and close to the transport', async () => {
    const { c } = client(() => ok('{}'));
    await expect(c.start()).resolves.toBeUndefined();
    await expect(c.close()).resolves.toBeUndefined();
  });
});

describe('InsyncClient signed-out and malformed responses', () => {
  it('raises a not-signed-in error naming the server transport', async () => {
    const { c } = client(() => ok(LOGIN));
    await expect(c.getCounts()).rejects.toThrow(/Not signed in/);
    await expect(c.getCounts()).rejects.toMatchObject({ kind: 'session_expired', hint: /INSYNC_USERNAME/ });
  });

  it('names the browser tab in fetchproxy mode', async () => {
    const { c } = client(() => ok(LOGIN), { mode: 'fetchproxy' });
    await expect(c.listSurveys()).rejects.toMatchObject({ hint: /Chrome tab/ });
  });

  it('reports an empty JSON response, mode-aware', async () => {
    const { c } = client(() => ok(''));
    await expect(c.getCounts()).rejects.toThrow(/empty response/);
    await expect(c.getCounts()).rejects.toMatchObject({ hint: /signs in again/ });
    const bridge = client(() => ok(''), { mode: 'fetchproxy' });
    await expect(bridge.c.getCounts()).rejects.toMatchObject({ hint: /Chrome tab/ });
  });

  it('reports an empty text response', async () => {
    const { c } = client(() => ok('   '));
    await expect(c.listSurveys()).rejects.toThrow(/empty response/);
  });

  it('surfaces an HTML error page, with and without a title', async () => {
    const titled = client(() => ok('<html><title>Portal :: Oops</title></html>'));
    await expect(titled.c.getCounts()).rejects.toThrow(/did not return JSON.*Oops/);
    const untitled = client(() => ok('not json at all'));
    await expect(untitled.c.getCounts()).rejects.toThrow(/did not return JSON\.$/);
  });

  it('reports a body that starts like JSON but does not parse', async () => {
    const { c } = client(() => ok('{"broken":'));
    await expect(c.getCounts()).rejects.toThrow(/could not be parsed as JSON/);
  });

  it('scrubs registered secret values out of error text', async () => {
    const scrubber = new SecretScrubber();
    scrubber.add('S3SUPERSECRET123');
    const { c } = client(() => ok('<html><title>S3SUPERSECRET123</title></html>'), { scrubber });
    await expect(c.getCounts()).rejects.toThrow(/\[REDACTED\]/);
    await expect(c.getCounts()).rejects.not.toThrow(/S3SUPERSECRET123/);
  });
});

describe('InsyncClient file transfer', () => {
  const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));

  it('lists attachments through the side-effect-free endpoint', async () => {
    const { c, t } = client(() => ok('[]'));
    await c.listAttachments('42');
    expect(t.calls[0]).toMatchObject({
      verb: 'getJson',
      path: 'Messages/GetToDoAttachments?todoMasaterId=42',
    });
  });

  it('downloads an attachment on a relative portal path', async () => {
    const { c, t } = client(() => ok('{}'));
    t.binary = { status: 200, body: '', bytes: bytes('PDF'), contentType: 'application/pdf' };
    const res = await c.downloadAttachment('/DocumentManager/DownloadFile.ashx?f=1');
    expect(Buffer.from(res.bytes).toString()).toBe('PDF');
    expect(t.calls[0]?.verb).toBe('getBinary');
  });

  it('refuses an off-portal host', async () => {
    const { c } = client(() => ok('{}'));
    await expect(c.downloadAttachment('https://evil.example.com/x')).rejects.toThrow(
      /outside the InSync portal/,
    );
  });

  it('refuses a protocol-relative path, which resolves off the portal', async () => {
    const { c, t } = client(() => ok('{}'));
    await expect(c.downloadAttachment('//evil.example/x')).rejects.toThrow(/outside the InSync portal/);
    const pinned = client(() => ok('{}'), { portalHost: 'pfb.insynchcs.com' });
    await expect(pinned.c.downloadAttachment('//evil.example/x')).rejects.toThrow(
      /outside the InSync portal/,
    );
    expect([...t.calls, ...pinned.t.calls]).toEqual([]);
  });

  it('pins downloads to the configured portal host', async () => {
    const { c, t } = client(() => ok('{}'), { portalHost: 'pfb.insynchcs.com' });
    t.binary = { status: 200, body: '', bytes: bytes('PDF') };
    await c.downloadAttachment('/DocumentManager/DownloadFile.ashx?f=1');
    await c.downloadAttachment('https://pfb.insynchcs.com/DocumentManager/DownloadFile.ashx?f=2');
    expect(t.calls.map((x) => x.path)).toEqual([
      '/DocumentManager/DownloadFile.ashx?f=1',
      'https://pfb.insynchcs.com/DocumentManager/DownloadFile.ashx?f=2',
    ]);
    // Another practice's portal is still off-portal once the host is known.
    await expect(c.downloadAttachment('https://other.insynchcs.com/x')).rejects.toThrow(
      /outside the InSync portal/,
    );
    await expect(c.downloadAttachment('//other.insynchcs.com/x')).rejects.toThrow(
      /outside the InSync portal/,
    );
  });

  it('refuses an unparseable absolute attachment path', async () => {
    const { c } = client(() => ok('{}'));
    await expect(c.downloadAttachment('http://')).rejects.toThrow(/not a valid URL/);
  });

  it('rejects a signed-out binary response', async () => {
    const { c, t } = client(() => ok('{}'));
    t.binary = { status: 200, body: LOGIN, bytes: bytes(LOGIN) };
    await expect(c.downloadAttachment('/x')).rejects.toThrow(/Not signed in/);
  });

  it('rejects an error status and an empty binary body', async () => {
    const err = client(() => ok('{}'));
    err.t.binary = { status: 404, body: '', bytes: new Uint8Array() };
    await expect(err.c.downloadAttachment('/x')).rejects.toThrow(/returned 404/);
    const empty = client(() => ok('{}'));
    empty.t.binary = { status: 200, body: '', bytes: new Uint8Array() };
    await expect(empty.c.downloadAttachment('/x')).rejects.toThrow(/no data/);
  });

  it('resolves a file source and reads non-string fields as absent', async () => {
    const good = client(() => ok(JSON.stringify({ Status: 'Success', FilePath: '/srv/f' })));
    expect(await good.c.getFileSource('folder/x')).toEqual({ status: 'Success', filePath: '/srv/f' });
    expect(good.t.calls[0]).toMatchObject({
      verb: 'postJson',
      path: 'PatientDocument/GetFileSource?FolderUrl=folder%2Fx',
    });
    const odd = client(() => ok(JSON.stringify({ Status: 1, FilePath: null })));
    expect(await odd.c.getFileSource('x')).toEqual({ status: '', filePath: '' });
  });

  it('downloads a document file via GetFile', async () => {
    const { c, t } = client(() => ok('{}'));
    t.binary = { status: 200, body: '', bytes: bytes('DOC'), contentType: 'application/pdf' };
    const res = await c.downloadFile('/srv/doc');
    expect(Buffer.from(res.bytes).toString()).toBe('DOC');
    expect(t.calls[0]).toMatchObject({ verb: 'postBinary', path: 'PatientDocument/GetFile', body: { FilePath: '/srv/doc' } });
  });
});

describe('InsyncClient write lookups', () => {
  it('reads the compose recipients, compose form and refill form', async () => {
    const { c, t } = client((call) => ok(call.verb === 'getJson' ? '{"Resources":[]}' : '<form></form>'));
    expect(await c.getComposeDetail()).toEqual({ Resources: [] });
    expect(await c.getComposeForm()).toBe('<form></form>');
    expect(await c.getRefillForm()).toBe('<form></form>');
    expect(await c.getSchedulerPage()).toBe('<form></form>');
    expect(t.calls.map((x) => [x.verb, x.path])).toEqual([
      ['getJson', 'Messages/GetComposeMessageDetail'],
      ['getText', 'Messages/LoadComposeMessageDetail?IsPriorityEnable=false'],
      ['getText', 'RefillPrescription/RefillPrescription'],
      ['getText', 'PatientScheduler'],
    ]);
  });

  it('posts the reply form request with the ids as JSON Mstparams', async () => {
    const { c, t } = client(() => ok('<form></form>'));
    await c.getReplyForm('11', '22');
    expect(t.calls[0]).toMatchObject({
      verb: 'postForm',
      path: 'Messages/GetComposeDetailForReply',
      body: { Mstparams: '{"TODOChildId":"11","TODOMasterId":"22"}' },
    });
  });

  it('builds the scheduling lookups the portal’s Angular service sends', async () => {
    const { c, t } = client(() => ok('{}'));
    await c.listRequestFacilities('7');
    await c.listRequestProviders('3', '11/20/2026');
    await c.listRequestVisitTypes({ scheduleSetupId: '5', date: '11/20/2026', facilityId: '3' });
    await c.listRequestSlots({
      scheduleSetupId: '5',
      date: '11/20/2026',
      currentTime: '10/28/2026 04:00 PM',
      resourceId: '9',
      visitTypeId: '',
    });
    expect(t.calls.map((x) => [x.verb, x.path, x.body])).toEqual([
      ['postForm', 'PatientScheduler/BindFacilities?practiceId=7', {}],
      [
        'postForm',
        'PatientScheduler/BindProviders?facilityId=3&date=11%2F20%2F2026&GenderIds=&LanguageIds=&ServiceOfferedIds=&CredentialIds=',
        {},
      ],
      [
        'postJson',
        'PatientScheduler/GetSchedulerVisitTypeSlots',
        { VisitDate: '11/20/2026', ScheduleSetupID: '5', SpCalledFrom: 1, FacilityId: '3' },
      ],
      [
        'postForm',
        'PatientScheduler/BindSchedulerSlots?providerId=5&date=11%2F20%2F2026&currentTime=10%2F28%2F2026+04%3A00+PM&ResourceId=9&EncounterTypeID=',
        {},
      ],
    ]);
  });

  describe('unread lookup', () => {
    const row = { TODOChildId: 11, TODOMasterId: 22, TaskSubject: 'x' };
    const listing = (body: Record<string, unknown>) => client(() => ok(JSON.stringify(body)));

    it('lists the unread folder (200 rows) and finds a row by its child and master ids', async () => {
      const { c, t } = listing({ recordsTotal: 1, data: [row] });
      expect(await c.isUnread('11', '22')).toBe(true);
      expect(await c.findUnreadMessage('11', '22')).toEqual(row);
      expect(t.calls[0]!.path).toMatch(/^Messages\/GetMessages\?/);
      expect(t.calls[0]!.path).toContain('messageType=1');
      expect(t.calls[0]!.path).toContain('length=200');
    });

    it('needs BOTH ids to match', async () => {
      const { c } = listing({ recordsTotal: 1, data: [row] });
      expect(await c.isUnread('11', '99')).toBe(false);
      expect(await c.isUnread('99', '22')).toBe(false);
    });

    it('skips rows that are not records', async () => {
      const { c } = listing({ recordsTotal: 3, data: [null, 5, row] });
      expect(await c.isUnread('11', '22')).toBe(true);
    });

    it('answers false when the complete listing has no match', async () => {
      const { c } = listing({ recordsTotal: 1, data: [row] });
      expect(await c.isUnread('12', '22')).toBe(false);
    });

    it('treats a listing with no recordsTotal (or a non-numeric one) as complete', async () => {
      expect(await listing({ data: [row] }).c.isUnread('12', '22')).toBe(false);
      expect(await listing({ recordsTotal: 'many', data: [row] }).c.isUnread('12', '22')).toBe(false);
      expect(await listing({}).c.isUnread('12', '22')).toBe(false);
      expect(await client(() => ok('[]')).c.isUnread('12', '22')).toBe(false);
    });

    it('fails closed when the listing was truncated and no row matched', async () => {
      const { c } = listing({ recordsTotal: '250', data: [row] });
      await expect(c.isUnread('12', '22')).rejects.toMatchObject({
        message:
          'Could not confirm whether this message is unread: the unread folder has 250 messages and only 1 were checked.',
        hint: expect.stringMatching(/allow_mark_read=true.*does not page/s),
      });
    });

    it('still finds a match on a truncated listing', async () => {
      const { c } = listing({ recordsTotal: 250, data: [row] });
      expect(await c.isUnread('11', '22')).toBe(true);
    });
  });

  it('reads the cancellation-window check as a trimmed code', async () => {
    const { c, t } = client(() => ok(' 2\n'));
    expect(await c.checkCancelWindow('42')).toBe('2');
    expect(t.calls[0]).toMatchObject({
      verb: 'getText',
      path: 'Appointment/CheckCancelAppointmentRequestTimeDuration?VisitID=42',
    });
  });
});

describe('InsyncClient writes', () => {
  const withToken = (answer: FetchResult) => (call: Call): FetchResult =>
    call.path.endsWith('GetAntiForgeryToken') ? ok('{"formToken":"tok"}') : answer;

  it('submits a form once, never replayed, with a fresh anti-forgery token', async () => {
    const { c, t } = client(withToken(ok('')));
    expect(await c.submitForm('Appointment/SaveCancelAppointmentRequest', { VisitID: '1' })).toBe('');
    expect(t.calls[1]).toEqual({
      verb: 'postForm',
      path: 'Appointment/SaveCancelAppointmentRequest',
      body: { VisitID: '1', __RequestVerificationToken: 'tok' },
      opts: { replay: false, headers: { __RequestVerificationToken: 'tok' } },
    });
  });

  it('sends URLSearchParams untouched when the portal yields no token', async () => {
    const { c, t } = client((call) => (call.path.endsWith('GetAntiForgeryToken') ? ok('{}') : ok('')));
    await c.submitForm('X/Y', new URLSearchParams([['a', '1']]));
    expect([...(t.calls[1]!.body as URLSearchParams)]).toEqual([['a', '1']]);
    expect(t.calls[1]!.opts).toEqual({ replay: false, headers: {} });
  });

  it('accepts URLSearchParams for nested-array forms', async () => {
    const { c, t } = client(withToken(ok('ok')));
    const form = new URLSearchParams([['list[0][A]', '1']]);
    await c.submitForm('X/Y', form);
    const sent = t.calls[1]!.body as URLSearchParams;
    expect(sent.get('list[0][A]')).toBe('1');
    expect(sent.get('__RequestVerificationToken')).toBe('tok');
  });

  it('refuses a signed-out answer or a 4xx as not applied', async () => {
    await expect(client(withToken(ok(LOGIN))).c.submitForm('X/Y', {})).rejects.toThrow(/not signed in/i);
    const refused = client(withToken({ status: 400, body: '' })).c.submitForm('X/Y', {});
    await expect(refused).rejects.toThrow(/refused X\/Y with HTTP 400/);
    await expect(refused).rejects.not.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('reports a 5xx or a transport failure after sending as an UNKNOWN outcome', async () => {
    const five = client(withToken({ status: 502, body: '' })).c.submitForm('X/Y', {});
    await expect(five).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    await expect(five).rejects.toMatchObject({ hint: expect.stringMatching(/HTTP 502/) });
    const dropped = client((call) => {
      if (call.path.endsWith('GetAntiForgeryToken')) return ok('{}');
      throw new TypeError('fetch failed');
    });
    await expect(dropped.c.submitForm('X/Y', {})).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    const signedOut = client(() => {
      throw new InsyncNotSignedInError('server');
    });
    await expect(signedOut.c.submitJson('X/Y', {})).rejects.toBeInstanceOf(InsyncNotSignedInError);
  });

  it('submits a form and parses a JSON answer', async () => {
    const { c } = client(withToken(ok('{"Result":[{"Status":1}]}')));
    expect(await c.submitFormJson('Messages/ComposeEmail', { a: '1' })).toEqual({ Result: [{ Status: 1 }] });
    await expect(client(withToken({ status: 404, body: '' })).c.submitFormJson('X/Y', {})).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('uploads through the write-status guard: 5xx is UNKNOWN, 4xx applied nothing', async () => {
    const five = client(withToken({ status: 500, body: '<html><title>Server Error</title></html>' }));
    const fiveRun = five.c.upload('PatientProfile/SaveInsuranceCardImages', { a: '1' });
    await expect(fiveRun).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    await expect(fiveRun).rejects.toMatchObject({ hint: expect.stringMatching(/HTTP 500/) });
    const four = client(withToken({ status: 400, body: '' })).c.upload('X/Y', {});
    await expect(four).rejects.toThrow(/refused X\/Y with HTTP 400/);
    await expect(four).rejects.toMatchObject({ hint: expect.stringMatching(/Nothing was applied/) });
    await expect(four).rejects.not.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('accepts an upload by Success or by Status "1", and refuses anything else', async () => {
    const byFlag = client(withToken(ok('{"Success":true}')));
    expect(await byFlag.c.upload('X/Y', { a: '1' })).toEqual({ status: undefined });
    expect(byFlag.t.calls[1]).toMatchObject({ verb: 'postForm', opts: { replay: false } });
    expect(await client(withToken(ok('{"Status":1}'))).c.upload('X/Y', {})).toEqual({ status: '1' });
    await expect(
      client(withToken(ok('{"Success":false,"Status":"0"}'))).c.upload('X/Y', {}),
    ).rejects.toThrow(/did not accept the upload/);
  });

  it('submits JSON once, never replayed, and parses the answer', async () => {
    const { c, t } = client(() => ok('{"resultModel":{"Status":1}}'));
    expect(await c.submitJson('PatientScheduler/SaveAppointmentReq', { A: 1 })).toEqual({
      resultModel: { Status: 1 },
    });
    expect(t.calls[0]).toEqual({
      verb: 'postJson',
      path: 'PatientScheduler/SaveAppointmentReq',
      body: { A: 1 },
      opts: { replay: false },
    });
    await expect(client(() => ({ status: 500, body: '{}' })).c.submitJson('X/Y', {})).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError,
    );
    await expect(client(() => ok(LOGIN)).c.submitJson('X/Y', {})).rejects.toThrow(/not signed in/i);
  });
});
