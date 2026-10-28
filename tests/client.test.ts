import { describe, expect, it } from 'vitest';
import { InsyncClient, isSignedOut, type TransportMode } from '../src/client.js';
import { SecretScrubber } from '../src/secrets.js';
import type { FetchResult, InsyncTransport, RequestOptions, S3Config } from '../src/transport.js';

interface Call {
  verb: 'getJson' | 'postJson' | 'postForm' | 'getText' | 'postText';
  path: string;
  body?: unknown;
  opts?: RequestOptions;
}

class FakeTransport implements InsyncTransport {
  calls: Call[] = [];
  s3: S3Config | undefined;
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
