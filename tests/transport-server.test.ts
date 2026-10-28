import { describe, expect, it } from 'vitest';
import { isSignedOut } from '../src/client.js';
import { SecretScrubber } from '../src/secrets.js';
import { ServerTransport } from '../src/transport-server.js';
import { formBody, parsePortal } from '../src/transport.js';

const PORTAL = 'https://pfbhintouch.insynchcs.com';
// Another practice's portal: same insynchcs.com suffix, different tenant.
const OTHER_PRACTICE = 'https://otherpractice.insynchcs.com';
const DASH = '<html><head><title>Portal :: Dashboard</title></head><body>ok</body></html>';
const LOGIN_PAGE = '<html><head><title>Portal :: Login</title></head><body></body></html>';
const LANDING =
  '<html><head><title>Portal :: Login</title></head>' +
  '<input name="__RequestVerificationToken" type="hidden" value="TOK123" /></html>';
const SESSION_COOKIES = ['.ASPXAUTH=aspxauth-value; path=/; HttpOnly', 'ASP.NET_SessionId=sess123'];
const LOGIN_OK = JSON.stringify({
  Status: 1,
  url: '/Login/RedirectWithoutMessage',
  AvailablePractice: [],
  IsCaseWorker: false,
  IsGuardian: false,
  IsDelegateRestricted: false,
  Password: 'PASSWORDHASHSECRET',
  ePrescriptionToken: 'EPRESCRIPTIONSECRET',
  S3AccessKeyID: 'AKIATESTKEY12345',
  S3SecretAccessKey: 'SECRETKEY67890ABCDEF',
  S3BucketName: 'test-bucket-synthetic',
  S3RegionEndpoint: 's3.us-east-1.amazonaws.com',
  S3PracticeFolderName: 'practice-folder-1234',
  IsAWSS3Enabled: true,
});

function resp(
  status: number,
  body: string,
  opts: { location?: string; setCookies?: string[] } = {},
): Response {
  const headers = new Headers();
  if (opts.location !== undefined) headers.set('location', opts.location);
  for (const cookie of opts.setCookies ?? []) headers.append('set-cookie', cookie);
  return new Response(body, { status, headers });
}

interface MockOptions {
  landing?: () => Response;
  login?: (body: string, callNo: number) => Response;
  handoff?: (url: URL) => Response;
  dashboard?: () => Response;
  dataResponses?: Response[];
  creds?: { username: string | undefined; password: string | undefined };
  portal?: string | undefined;
}

interface Mock {
  loginCalls: number;
  dataCalls: number;
  cookiesSeen: string[];
  loginBodies: string[];
}

function makeTransport(opts: MockOptions = {}): {
  t: ServerTransport;
  mock: Mock;
  scrubber: SecretScrubber;
} {
  const mock: Mock = { loginCalls: 0, dataCalls: 0, cookiesSeen: [], loginBodies: [] };
  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    mock.cookiesSeen.push(headers.Cookie ?? '');
    if (method === 'GET' && url.pathname === '/') return (opts.landing ?? (() => resp(200, LANDING)))();
    if (method === 'POST' && url.pathname === '/Login/userLogin') {
      mock.loginCalls += 1;
      mock.loginBodies.push(String(init?.body ?? ''));
      return (opts.login ?? (() => resp(200, LOGIN_OK, { setCookies: SESSION_COOKIES })))(
        String(init?.body ?? ''),
        mock.loginCalls,
      );
    }
    if (method === 'GET' && url.pathname === '/Login/RedirectWithoutMessage') {
      return (opts.handoff ?? (() => resp(302, '', { location: '/Dashboard' })))(url);
    }
    if (method === 'GET' && url.pathname === '/Dashboard') {
      return (opts.dashboard ?? (() => resp(200, DASH)))();
    }
    const queued = opts.dataResponses?.[mock.dataCalls];
    mock.dataCalls += 1;
    return queued ?? resp(200, '{"data":[]}');
  }) as unknown as typeof fetch;
  const scrubber = new SecretScrubber();
  const creds = opts.creds ?? { username: 'User@Example.com', password: 'pw-secret' };
  const t = new ServerTransport({
    portal: 'portal' in opts ? opts.portal : PORTAL,
    username: creds.username,
    password: creds.password,
    scrubber,
    fetchImpl,
  });
  return { t, mock, scrubber };
}

describe('ServerTransport login (happy path)', () => {
  it('signs in once, sends the session cookie, and captures the S3 config', async () => {
    const { t, mock, scrubber } = makeTransport();
    const res = await t.getJson('Dashboard/GetDashBoradCount');
    expect(JSON.parse(res.body)).toEqual({ data: [] });
    expect(mock.loginCalls).toBe(1);
    // username lowercased; IsAzureAd present
    expect(mock.loginBodies[0]).toContain('UserName=user%40example.com');
    expect(mock.loginBodies[0]).toContain('IsAzureAd=false');
    // the data call carried the session cookie
    expect(mock.cookiesSeen.some((c) => c.includes('.ASPXAUTH=aspxauth-value'))).toBe(true);
    const s3 = t.getS3Config();
    expect(s3).toMatchObject({ enabled: true, accessKeyId: 'AKIATESTKEY12345', bucketName: 'test-bucket-synthetic' });
    expect(t.status()).toMatchObject({ mode: 'server', signedIn: true });
  });

  it('registers the S3 values and the password with the scrubber', async () => {
    const { t, scrubber } = makeTransport();
    await t.getJson('Dashboard/GetDashBoradCount');
    for (const v of ['AKIATESTKEY12345', 'SECRETKEY67890ABCDEF', 'test-bucket-synthetic', 's3.us-east-1.amazonaws.com', 'practice-folder-1234', 'pw-secret']) {
      expect(scrubber.has(v)).toBe(true);
    }
    // none of the whitelist-excluded secrets leak into a scrubbed string
    expect(scrubber.scrub('AKIATESTKEY12345 SECRETKEY67890ABCDEF test-bucket-synthetic')).not.toContain('test-bucket-synthetic');
  });

  it('shares one login across a burst of calls', async () => {
    const { t, mock } = makeTransport();
    await Promise.all([t.getJson('A'), t.getJson('B'), t.getJson('C')]);
    expect(mock.loginCalls).toBe(1);
  });

  it('covers every verb', async () => {
    const { t } = makeTransport();
    expect((await t.getText('SurveyForms/GetReceivedSurveyForms')).status).toBe(200);
    expect((await t.postForm('X', { a: '1' })).status).toBe(200);
    expect((await t.postForm('Y', new URLSearchParams({ b: '2' }))).status).toBe(200);
    expect((await t.postText('Z', 'raw body')).status).toBe(200);
  });

  it('starts and closes without error', async () => {
    const { t } = makeTransport();
    await expect(t.start()).resolves.toBeUndefined();
    await expect(t.close()).resolves.toBeUndefined();
    expect(t.status()).toMatchObject({ signedIn: false });
    expect(t.getS3Config()).toBeUndefined();
  });

  it('absorbs a malformed Set-Cookie without crashing', async () => {
    const { t } = makeTransport({
      landing: () => resp(200, LANDING, { setCookies: ['novalue', '=leadingeq', 'RVT=ok'] }),
    });
    expect((await t.getJson('A')).status).toBe(200);
  });

  it('reports a disabled S3 config with no values', async () => {
    const { t } = makeTransport({
      login: () =>
        resp(200, JSON.stringify({ Status: 1, url: '/Login/RedirectWithoutMessage', IsAWSS3Enabled: false }), {
          setCookies: SESSION_COOKIES,
        }),
    });
    await t.getJson('A');
    expect(t.getS3Config()?.enabled).toBe(false);
    expect(t.getS3Config()?.accessKeyId).toBeUndefined();
  });

  it('registers the password with the scrubber at construction, before any request', () => {
    const { mock, scrubber } = makeTransport();
    expect(scrubber.has('pw-secret')).toBe(true);
    expect(mock.cookiesSeen).toHaveLength(0);
  });

  it('constructs without a password and registers nothing', () => {
    const { scrubber } = makeTransport({ creds: { username: 'u', password: undefined } });
    expect(scrubber.size).toBe(0);
  });

  it('drops a cookie the portal deletes (Max-Age<=0 or a past Expires)', async () => {
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    const { t, mock } = makeTransport({
      landing: () =>
        resp(200, LANDING, { setCookies: ['GONE=1', 'OLD=1', 'KEEP=1', 'FUT=1', 'ODD=1'] }),
      handoff: () =>
        resp(302, '', {
          location: '/Dashboard',
          setCookies: [
            'GONE=; Max-Age=0; path=/',
            'OLD=; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly',
            'KEEP=2; Max-Age=3600',
            `FUT=2; Expires=${future}`,
            // Max-Age wins over Expires (RFC 6265 §5.3 step 3).
            'ODD=2; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
          ],
        }),
    });
    await t.getJson('A');
    const last = mock.cookiesSeen.at(-1) ?? '';
    expect(last).not.toContain('GONE=');
    expect(last).not.toContain('OLD=');
    expect(last).toContain('KEEP=2');
    expect(last).toContain('FUT=2');
    expect(last).toContain('ODD=2');
  });

  it('follows an absolute handoff redirect that stays on the portal host', async () => {
    const { t } = makeTransport({ handoff: () => resp(302, '', { location: `${PORTAL}/Dashboard` }) });
    expect((await t.getJson('A')).status).toBe(200);
  });

  it('succeeds when the handoff redirect carries no Location', async () => {
    const { t } = makeTransport({ handoff: () => resp(302, '') });
    expect((await t.getJson('A')).status).toBe(200);
  });
});

describe('ServerTransport rejected logins (never retried)', () => {
  const cases: Array<[number, RegExp, string?]> = [
    [0, /did not accept the username and password/, 'credential_rejected'],
    [2, /inactive/],
    [3, /locked/],
    [5, /delegate access has expired/],
    [-1, /returned an error during sign-in/],
  ];
  for (const [status, re, kind] of cases) {
    it(`caches Status ${status} and does not re-login`, async () => {
      const { t, mock } = makeTransport({ login: () => resp(200, JSON.stringify({ Status: status })) });
      await expect(t.getJson('A')).rejects.toThrow(re);
      await expect(t.getJson('A')).rejects.toThrow(re);
      expect(mock.loginCalls).toBe(1);
      if (kind !== undefined) {
        await expect(t.getJson('A')).rejects.toMatchObject({ kind });
      }
    });
  }

  it('rejects a multi-practice account permanently', async () => {
    const { t, mock } = makeTransport({
      login: () => resp(200, JSON.stringify({ Status: 1, url: '/x', AvailablePractice: [{ PId: 1 }] })),
    });
    await expect(t.getJson('A')).rejects.toThrow(/Multi-practice/);
    await expect(t.getJson('A')).rejects.toThrow(/Multi-practice/);
    expect(mock.loginCalls).toBe(1);
  });

  it('rejects caseworker and guardian accounts permanently', async () => {
    const cw = makeTransport({ login: () => resp(200, JSON.stringify({ Status: 1, url: '/x', IsCaseWorker: true })) });
    await expect(cw.t.getJson('A')).rejects.toThrow(/Caseworker and guardian/);
    const g = makeTransport({ login: () => resp(200, JSON.stringify({ Status: 1, url: '/x', IsGuardian: true })) });
    await expect(g.t.getJson('A')).rejects.toThrow(/Caseworker and guardian/);
  });

  it('rejects a success with no redirect URL', async () => {
    // url omitted entirely — not a string — exercises the success-without-url path.
    const { t } = makeTransport({
      login: () => resp(200, JSON.stringify({ Status: 1 }), { setCookies: SESSION_COOKIES }),
    });
    await expect(t.getJson('A')).rejects.toThrow(/no redirect/);
  });

  it('reports missing credentials as a permanent no_credential error', async () => {
    const { t, mock } = makeTransport({ creds: { username: undefined, password: undefined } });
    await expect(t.getJson('A')).rejects.toMatchObject({ kind: 'no_credential' });
    expect(mock.loginCalls).toBe(0);
  });
});

describe('ServerTransport transient failures (retried)', () => {
  it('retries when the landing page has no token', async () => {
    const { t, mock } = makeTransport({ landing: () => resp(200, '<html>no token here</html>') });
    await expect(t.getJson('A')).rejects.toThrow(/Could not read the sign-in token/);
    await expect(t.getJson('A')).rejects.toThrow(/Could not read the sign-in token/);
    expect(mock.loginCalls).toBe(0);
  });

  it('retries when userLogin does not return JSON', async () => {
    const { t, mock } = makeTransport({ login: () => resp(200, '<html>maintenance</html>') });
    await expect(t.getJson('A')).rejects.toThrow(/did not return the expected response/);
    await expect(t.getJson('A')).rejects.toThrow(/did not return the expected response/);
    expect(mock.loginCalls).toBe(2);
  });

  it('retries when the userLogin JSON is unparseable', async () => {
    const { t } = makeTransport({ login: () => resp(200, '{broken') });
    await expect(t.getJson('A')).rejects.toThrow(/could not be parsed/);
  });

  it('fails when the dashboard cannot be reached after sign-in', async () => {
    const { t } = makeTransport({ dashboard: () => resp(200, LOGIN_PAGE) });
    await expect(t.getJson('A')).rejects.toThrow(/could not reach the dashboard/);
  });

  it('fails when the handoff redirects off the portal domain', async () => {
    const { t } = makeTransport({ handoff: () => resp(302, '', { location: 'https://evil.example.com/x' }) });
    await expect(t.getJson('A')).rejects.toThrow(/off the portal domain/);
  });

  it("refuses a handoff redirect to another practice's insynchcs.com portal", async () => {
    const { t, mock } = makeTransport({
      handoff: () => resp(302, '', { location: `${OTHER_PRACTICE}/Dashboard` }),
    });
    await expect(t.getJson('A')).rejects.toThrow(/off the portal domain/);
    // The session cookie never reached the other practice: no Dashboard GET ran.
    expect(mock.cookiesSeen.filter((c) => c.includes('.ASPXAUTH'))).toHaveLength(1);
  });

  it('fails when the handoff loops too many times', async () => {
    const { t } = makeTransport({ handoff: () => resp(302, '', { location: '/Login/RedirectWithoutMessage' }) });
    await expect(t.getJson('A')).rejects.toThrow(/too many times/);
  });
});

describe('ServerTransport session expiry', () => {
  it('re-logs-in and replays a read exactly once', async () => {
    const { t, mock } = makeTransport({
      dataResponses: [resp(200, LOGIN_PAGE), resp(200, '{"ok":1}')],
    });
    const res = await t.getJson('Dashboard/GetDashBoradCount');
    expect(JSON.parse(res.body)).toEqual({ ok: 1 });
    expect(mock.loginCalls).toBe(2);
  });

  it('returns the signed-out response when expiry persists', async () => {
    const { t } = makeTransport({ dataResponses: [resp(200, LOGIN_PAGE), resp(200, LOGIN_PAGE)] });
    const res = await t.getJson('X');
    expect(isSignedOut(res)).toBe(true);
  });

  it('refuses to replay a write and reports nothing changed', async () => {
    const { t } = makeTransport({ dataResponses: [resp(200, LOGIN_PAGE)] });
    await expect(t.postJson('X', {}, { replay: false })).rejects.toThrow(/nothing changed/);
  });

  it('returns a write result when the session is live', async () => {
    const { t } = makeTransport({ dataResponses: [resp(200, '{"ok":1}')] });
    const res = await t.postJson('X', {}, { replay: false });
    expect(JSON.parse(res.body)).toEqual({ ok: 1 });
  });
});

function bin(
  status: number,
  body: BodyInit,
  opts: { contentType?: string; location?: string } = {},
): Response {
  const headers = new Headers();
  if (opts.contentType !== undefined) headers.set('content-type', opts.contentType);
  if (opts.location !== undefined) headers.set('location', opts.location);
  return new Response(body, { status, headers });
}

describe('ServerTransport binary downloads', () => {
  it('returns the bytes and content-type, with an empty text body', async () => {
    const { t, mock } = makeTransport({
      dataResponses: [bin(200, Buffer.from('PDFDATA'), { contentType: 'application/pdf' })],
    });
    const res = await t.getBinary('DocumentManager/DownloadFile.ashx?filePath=x');
    expect(Buffer.from(res.bytes).toString()).toBe('PDFDATA');
    expect(res.contentType).toBe('application/pdf');
    expect(res.body).toBe('');
    expect(mock.loginCalls).toBe(1);
  });

  it('POSTs a JSON body and reads bytes back (GetFile)', async () => {
    const { t } = makeTransport({
      dataResponses: [bin(200, Buffer.from('DOCBYTES'), { contentType: 'application/pdf' })],
    });
    const res = await t.postBinary('PatientDocument/GetFile', { FilePath: 'x' });
    expect(Buffer.from(res.bytes).toString()).toBe('DOCBYTES');
  });

  it('decodes a texty prefix (no content-type) so sign-in pages are still caught', async () => {
    const { t } = makeTransport({ dataResponses: [bin(200, Buffer.from([0, 1, 2, 3]))] });
    const res = await t.getBinary('x');
    expect([...res.bytes]).toEqual([0, 1, 2, 3]);
  });

  it('returns an HTML document (texty) that is not a sign-in page', async () => {
    const { t } = makeTransport({
      dataResponses: [bin(200, '<html>doc</html>', { contentType: 'text/html' })],
    });
    const res = await t.getBinary('x');
    expect(Buffer.from(res.bytes).toString()).toBe('<html>doc</html>');
    expect(res.body).toContain('<html>doc</html>');
  });

  it('re-logs-in and replays when the download comes back a sign-in page', async () => {
    const { t, mock } = makeTransport({
      dataResponses: [
        bin(200, LOGIN_PAGE, { contentType: 'text/html' }),
        bin(200, Buffer.from('PDF'), { contentType: 'application/pdf' }),
      ],
    });
    const res = await t.getBinary('x');
    expect(Buffer.from(res.bytes).toString()).toBe('PDF');
    expect(mock.loginCalls).toBe(2);
  });

  it('treats a redirect to /Login as expiry and replays', async () => {
    const { t, mock } = makeTransport({
      dataResponses: [
        bin(302, '', { location: '/Login' }),
        bin(200, Buffer.from('PDF'), { contentType: 'application/pdf' }),
      ],
    });
    const res = await t.getBinary('x');
    expect(Buffer.from(res.bytes).toString()).toBe('PDF');
    expect(mock.loginCalls).toBe(2);
  });

  it('follows a redirect that stays on the portal', async () => {
    const { t, mock } = makeTransport({
      dataResponses: [
        bin(302, '', { location: '/DocumentManager/Resolved' }),
        bin(200, Buffer.from('PDF'), { contentType: 'application/pdf' }),
      ],
    });
    const res = await t.getBinary('x');
    expect(Buffer.from(res.bytes).toString()).toBe('PDF');
    expect(mock.loginCalls).toBe(1);
  });

  it('refuses a redirect off the portal domain', async () => {
    const { t } = makeTransport({
      dataResponses: [bin(302, '', { location: 'https://evil.example.com/x' })],
    });
    await expect(t.getBinary('x')).rejects.toThrow(/off the portal domain/);
  });

  it("refuses a redirect to another practice's insynchcs.com portal", async () => {
    const { t, mock } = makeTransport({
      dataResponses: [bin(302, '', { location: `${OTHER_PRACTICE}/x` })],
    });
    await expect(t.getBinary('x')).rejects.toThrow(/off the portal domain/);
    expect(mock.dataCalls).toBe(1);
  });

  it('follows an absolute redirect that stays on the portal host', async () => {
    const { t } = makeTransport({
      dataResponses: [
        bin(302, '', { location: `${PORTAL}/DocumentManager/Resolved` }),
        bin(200, Buffer.from('PDF'), { contentType: 'application/pdf' }),
      ],
    });
    const res = await t.getBinary('x');
    expect(Buffer.from(res.bytes).toString()).toBe('PDF');
  });

  it('refuses a redirect that downgrades the portal to plain http', async () => {
    const { t } = makeTransport({
      dataResponses: [bin(302, '', { location: 'http://pfbhintouch.insynchcs.com/x' })],
    });
    await expect(t.getBinary('x')).rejects.toThrow(/off the portal domain/);
  });

  it("refuses an absolute path on another practice's portal", async () => {
    const { t, mock } = makeTransport();
    await expect(t.getBinary(`${OTHER_PRACTICE}/file.pdf`)).rejects.toThrow(
      /outside the InSync portal/,
    );
    expect(mock.dataCalls).toBe(0);
  });

  it('refuses an absolute path outside the portal', async () => {
    const { t } = makeTransport();
    await expect(t.getBinary('https://evil.example.com/file.pdf')).rejects.toThrow(
      /outside the InSync portal/,
    );
  });

  it('refuses after too many redirects', async () => {
    const { t } = makeTransport({
      dataResponses: Array.from({ length: 10 }, () =>
        bin(302, '', { location: '/DocumentManager/Loop' }),
      ),
    });
    await expect(t.getBinary('x')).rejects.toThrow(/too many times/);
  });
});

describe('parsePortal', () => {
  it('accepts a bare https insynchcs host', () => {
    expect(parsePortal('https://pfbhintouch.insynchcs.com')).toEqual({
      origin: 'https://pfbhintouch.insynchcs.com',
      host: 'pfbhintouch.insynchcs.com',
      subdomain: 'pfbhintouch',
    });
    expect(parsePortal('https://pfbhintouch.insynchcs.com/').subdomain).toBe('pfbhintouch');
  });

  it('rejects the invalid forms', () => {
    expect(() => parsePortal(undefined)).toThrow(/required/);
    expect(() => parsePortal('   ')).toThrow(/required/);
    expect(() => parsePortal('not a url')).toThrow(/not a valid URL/);
    expect(() => parsePortal('http://x.insynchcs.com')).toThrow(/must use https/);
    expect(() => parsePortal('https://x.example.com')).toThrow(/insynchcs\.com host/);
    expect(() => parsePortal('https://x.insynchcs.com/p')).toThrow(/no path or query/);
    expect(() => parsePortal('https://x.insynchcs.com/?q=1')).toThrow(/no path or query/);
    expect(() => parsePortal('https://.insynchcs.com')).toThrow(/missing a practice subdomain/);
  });

  it('marks a missing portal as no_credential', () => {
    expect(() => parsePortal(undefined)).toThrow(expect.objectContaining({ kind: 'no_credential' }));
  });
});

describe('formBody', () => {
  it('encodes a plain record', () => {
    expect(formBody({ a: '1', b: 'x y' })).toBe('a=1&b=x+y');
  });

  it('passes URLSearchParams through, keeping repeated keys', () => {
    const form = new URLSearchParams([
      ['k', '1'],
      ['k', '2'],
    ]);
    expect(formBody(form)).toBe('k=1&k=2');
  });
});
