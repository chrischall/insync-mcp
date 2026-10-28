import { describe, expect, it } from 'vitest';
import { InsyncClient, isSignedOut, type TransportMode } from '../src/client.js';
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
  opts: { mode?: TransportMode; scrubber?: SecretScrubber } = {},
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
