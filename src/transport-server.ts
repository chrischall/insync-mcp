// Bridge-less transport: signs in to the InSync portal server-side with a
// cookie jar, no browser involved. Selected when credentials are configured.
//
// Login (verified live 2026-10-28, no MFA):
//   1. GET /                     → hidden `__RequestVerificationToken` + its cookie
//   2. POST /Login/userLogin     → JSON { Status, url, … } + session cookies
//      form: UserName=<lower>&Password=…&IsAzureAd=false&__RequestVerificationToken=…
//      success is Status === 1 with a non-empty url (/Login/RedirectWithoutMessage).
//   3. GET url (following redirects) then GET /Dashboard to confirm the session.
//
// Only a whitelist of fields is read from that JSON; the account password and
// any sensitive configuration it carries are registered with the scrubber so
// they never surface in a result, error or log.
//
// A rejected login (Status 0/2/3/5) is NEVER retried: attempts count toward an
// account lockout. It is thrown as a PermanentTransportError, which the session
// manager caches.

import { McpToolError } from '@chrischall/mcp-utils';
import { createCookieSessionManager, type CookieSessionManager } from '@chrischall/mcp-utils/session';
import { isSignedOut } from './client.js';
import { SecretScrubber } from './secrets.js';
import {
  formBody,
  NotAcceptedError,
  parsePortal,
  PermanentTransportError,
  type BinaryFetchResult,
  type FetchResult,
  type InsyncTransport,
  type PortalInfo,
  type RequestOptions,
  type S3Config,
} from './transport.js';

const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/;
const USER_AGENT = 'Mozilla/5.0';
const API_HINT = 'The portal sign-in flow may have changed; see docs/INSYNC-API.md.';

interface InsyncSession {
  jar: Map<string, string>;
  s3: S3Config;
}

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
  replay?: false;
}

export interface ServerTransportOptions {
  portal: string | undefined;
  username: string | undefined;
  password: string | undefined;
  scrubber: SecretScrubber;
  /** Injectable for tests; the real `fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Whether a Set-Cookie line's attributes delete the cookie: `Max-Age` <= 0, or
// (absent Max-Age, which takes precedence per RFC 6265 §5.3) an `Expires` in
// the past. That is how the portal clears a cookie on sign-out; without this
// the jar would keep resending a value the server meant to drop. Domain and
// Path are still ignored — every request goes to the one pinned portal host.
function isDeletion(attributes: string[]): boolean {
  const attrs = new Map<string, string>();
  for (const attr of attributes) {
    const eq = attr.indexOf('=');
    const name = (eq < 0 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    attrs.set(name, eq < 0 ? '' : attr.slice(eq + 1).trim());
  }
  const maxAge = attrs.get('max-age');
  if (maxAge !== undefined) return Number(maxAge) <= 0;
  const expires = attrs.get('expires');
  return expires !== undefined && Date.parse(expires) <= Date.now();
}

function absorb(headers: Headers, jar: Map<string, string>): void {
  for (const line of headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (isDeletion(attributes)) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1));
  }
}

function readS3(data: Record<string, unknown>): S3Config {
  const str = (key: string): string | undefined => {
    const v = data[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  return {
    enabled: data.IsAWSS3Enabled === true,
    accessKeyId: str('S3AccessKeyID'),
    secretAccessKey: str('S3SecretAccessKey'),
    bucketName: str('S3BucketName'),
    regionEndpoint: str('S3RegionEndpoint'),
    practiceFolderName: str('S3PracticeFolderName'),
  };
}

export class ServerTransport implements InsyncTransport {
  private readonly sessions: CookieSessionManager<InsyncSession, FetchResult>;
  private readonly doFetch: typeof fetch;
  private portalInfo?: PortalInfo;

  constructor(private readonly opts: ServerTransportOptions) {
    /* v8 ignore next */
    this.doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    // Register the password as a scrub needle up front, not after a successful
    // login: a failed or half-finished sign-in can still surface an error, and
    // the password must already be redacted from it.
    opts.scrubber.add(opts.password);
    this.sessions = createCookieSessionManager<InsyncSession, FetchResult>({
      login: () => this.login(),
      isExpired: (res) => isSignedOut(res),
      isPermanentError: (err) => err instanceof PermanentTransportError,
    });
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  status(): unknown {
    return { mode: 'server', signedIn: this.sessions.current !== undefined };
  }

  getS3Config(): S3Config | undefined {
    return this.sessions.current?.s3;
  }

  getJson(path: string, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.request({
      method: 'GET',
      path,
      headers: { Accept: 'application/json', ...opts.headers },
      replay: opts.replay,
    });
  }

  getText(path: string, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.request({
      method: 'GET',
      path,
      headers: { Accept: 'text/html', ...opts.headers },
      replay: opts.replay,
    });
  }

  postJson(path: string, body: unknown, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.request({
      method: 'POST',
      path,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      replay: opts.replay,
    });
  }

  postForm(
    path: string,
    form: Record<string, string> | URLSearchParams,
    opts: RequestOptions = {},
  ): Promise<FetchResult> {
    const body = formBody(form);
    return this.request({
      method: 'POST',
      path,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...opts.headers,
      },
      body,
      replay: opts.replay,
    });
  }

  postText(path: string, body: string, opts: RequestOptions = {}): Promise<FetchResult> {
    return this.request({ method: 'POST', path, headers: { ...opts.headers }, body, replay: opts.replay });
  }

  getBinary(path: string, opts: RequestOptions = {}): Promise<BinaryFetchResult> {
    return this.binaryRequest({ method: 'GET', path, headers: { ...opts.headers } });
  }

  postBinary(path: string, body: unknown, opts: RequestOptions = {}): Promise<BinaryFetchResult> {
    return this.binaryRequest({
      method: 'POST',
      path,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
    });
  }

  // Binary fetches are idempotent reads, so they always go through the session's
  // replay-once path: a lapsed session re-logs-in and the download is retried.
  private async binaryRequest(spec: RequestSpec): Promise<BinaryFetchResult> {
    return (await this.sessions.withSession((session) =>
      this.doBinaryRequest(session.jar, spec),
    )) as BinaryFetchResult;
  }

  private async doBinaryRequest(
    jar: Map<string, string>,
    spec: RequestSpec,
  ): Promise<BinaryFetchResult> {
    let url = new URL(spec.path, `${this.portal().origin}/`);
    if (!this.onPortal(url)) {
      throw new McpToolError('Refusing to download from a host outside the InSync portal.', {
        hint: 'InSync file downloads go only through the portal, never direct storage (S3).',
      });
    }
    for (let hop = 0; hop < 10; hop++) {
      const res = await this.doFetch(url.toString(), {
        method: hop === 0 ? spec.method : 'GET',
        redirect: 'manual',
        headers: {
          Cookie: cookieHeader(jar),
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': USER_AGENT,
          ...spec.headers,
        },
        body: hop === 0 ? spec.body : undefined,
      });
      absorb(res.headers, jar);
      const location = res.headers.get('location');
      const contentType = res.headers.get('content-type') ?? undefined;
      if (res.status >= 300 && res.status < 400 && location !== null) {
        const next = new URL(location, url);
        // A redirect to the sign-in page means the session lapsed; surface it so
        // withSession re-logs-in and replays the whole download.
        if (/\/Login/i.test(next.pathname)) {
          return { status: res.status, body: '', bytes: new Uint8Array(), url: location, contentType };
        }
        if (!this.onPortal(next)) {
          throw new McpToolError('InSync redirected the download off the portal domain.', {
            hint: 'File downloads go only through the portal, never direct storage (S3).',
          });
        }
        url = next;
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Decode a short prefix only for a texty response, so isSignedOut can spot a
      // sign-in or timeout page served with 200; real binary leaves body empty.
      const texty = contentType === undefined || /text\/|json|xml/i.test(contentType);
      const body = texty ? Buffer.from(bytes.subarray(0, 4096)).toString('utf8') : '';
      return { status: res.status, body, bytes, url: location ?? undefined, contentType };
    }
    throw new McpToolError('InSync redirected the download too many times.', { hint: API_HINT });
  }

  private async request(spec: RequestSpec): Promise<FetchResult> {
    if (spec.replay === false) {
      const session = await this.sessions.ensure();
      const res = await this.doRequest(session.jar, spec);
      if (isSignedOut(res)) {
        this.sessions.invalidate();
        throw new NotAcceptedError(
          'The InSync session expired before this request was accepted, so nothing changed.',
          { hint: 'Retry the call; the next one signs in again first.' },
        );
      }
      return res;
    }
    return this.sessions.withSession((session) => this.doRequest(session.jar, spec));
  }

  private portal(): PortalInfo {
    if (this.portalInfo === undefined) this.portalInfo = parsePortal(this.opts.portal);
    return this.portalInfo;
  }

  // Whether a URL is on exactly this practice's portal origin (scheme, host and
  // port). Every practice shares the insynchcs.com suffix, so a suffix check
  // would hand this session's cookie jar to ANOTHER practice's portal on a
  // redirect; and pinning the scheme keeps the cookies off plain http.
  private onPortal(url: URL): boolean {
    return url.origin === this.portal().origin;
  }

  private async doRequest(jar: Map<string, string>, spec: RequestSpec): Promise<FetchResult> {
    const res = await this.doFetch(new URL(spec.path, `${this.portal().origin}/`).toString(), {
      method: spec.method,
      redirect: 'manual',
      headers: {
        Cookie: cookieHeader(jar),
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': USER_AGENT,
        ...spec.headers,
      },
      body: spec.body,
    });
    absorb(res.headers, jar);
    const body = await res.text();
    const location = res.headers.get('location');
    return { status: res.status, body, url: location === null ? undefined : location };
  }

  private async login(): Promise<InsyncSession> {
    this.portal();
    const { username, password } = this.opts;
    if (username === undefined || password === undefined) {
      throw new PermanentTransportError(
        'INSYNC_USERNAME and INSYNC_PASSWORD are required for server-side sign-in.',
        {
          hint:
            'Set both in the environment (or a .env), or use INSYNC_TRANSPORT=fetchproxy to ' +
            'relay through a signed-in browser tab.',
          kind: 'no_credential',
        },
      );
    }

    const jar = new Map<string, string>();
    const landing = await this.doRequest(jar, {
      method: 'GET',
      path: '/',
      headers: { Accept: 'text/html' },
    });
    const token = TOKEN_RE.exec(landing.body)?.[1];
    if (token === undefined) {
      throw new McpToolError('Could not read the sign-in token from the InSync portal.', {
        hint: API_HINT,
      });
    }

    const form = new URLSearchParams({
      UserName: username.toLowerCase(),
      Password: password,
      IsAzureAd: 'false',
      __RequestVerificationToken: token,
    });
    const res = await this.doRequest(jar, {
      method: 'POST',
      path: '/Login/userLogin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        __RequestVerificationToken: token,
      },
      body: form.toString(),
    });

    const data = this.parseLoginJson(res);
    this.classifyStatus(data);
    this.guardAccountShape(data);
    const url = typeof data.url === 'string' ? data.url : '';
    if (url === '') {
      throw new PermanentTransportError('InSync accepted the sign-in but returned no redirect.', {
        hint: API_HINT,
      });
    }

    await this.followHandoff(jar, url);
    const dashboard = await this.doRequest(jar, {
      method: 'GET',
      path: '/Dashboard',
      headers: { Accept: 'text/html' },
    });
    if (!/Portal\s*::\s*Dashboard/i.test(dashboard.body)) {
      throw new McpToolError('Signed in to InSync but could not reach the dashboard.', {
        hint: API_HINT,
      });
    }

    const s3 = readS3(data);
    this.opts.scrubber.add(
      s3.accessKeyId,
      s3.secretAccessKey,
      s3.bucketName,
      s3.regionEndpoint,
      s3.practiceFolderName,
    );
    return { jar, s3 };
  }

  private parseLoginJson(res: FetchResult): Record<string, unknown> {
    // Never echo the body: it carries a password hash, an ePrescription token
    // and the S3 creds.
    if (!res.body.trimStart().startsWith('{')) {
      throw new McpToolError('InSync sign-in did not return the expected response.', {
        hint: 'The portal may be unavailable; retry shortly.',
      });
    }
    try {
      return JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      throw new McpToolError('InSync sign-in returned a response that could not be parsed.', {
        hint: 'The portal may be unavailable; retry shortly.',
      });
    }
  }

  private classifyStatus(data: Record<string, unknown>): void {
    const status = Number(data.Status);
    if (status === 1) return;
    const hint =
      'Check INSYNC_USERNAME and INSYNC_PASSWORD. Nothing retries automatically — the portal ' +
      'counts failed sign-ins toward an account lockout.';
    switch (status) {
      case 0:
        throw new PermanentTransportError('InSync did not accept the username and password.', {
          hint,
          kind: 'credential_rejected',
        });
      case 2:
        throw new PermanentTransportError('This InSync account is inactive.', { hint });
      case 3:
        throw new PermanentTransportError(
          'This InSync account is locked by too many failed sign-in attempts.',
          { hint },
        );
      case 5:
        throw new PermanentTransportError('This InSync delegate access has expired.', { hint });
      default:
        throw new PermanentTransportError('InSync returned an error during sign-in.', { hint });
    }
  }

  private guardAccountShape(data: Record<string, unknown>): void {
    const practices = data.AvailablePractice;
    if (Array.isArray(practices) && practices.length > 0) {
      throw new PermanentTransportError('Multi-practice InSync accounts are not supported yet.', {
        hint: 'This account can access more than one practice; that selection flow is not built.',
      });
    }
    if (data.IsCaseWorker === true || data.IsGuardian === true) {
      throw new PermanentTransportError(
        'Caseworker and guardian InSync accounts are not supported yet.',
        { hint: 'This account type needs a patient-selection flow that is not built.' },
      );
    }
  }

  // Every hop — the login JSON's own `url` included, which is the first request
  // to carry the fresh session cookies — is origin-checked BEFORE it is fetched.
  private async followHandoff(jar: Map<string, string>, startUrl: string): Promise<void> {
    let current = new URL(startUrl, `${this.portal().origin}/`);
    for (let hop = 0; hop < 10; hop++) {
      if (!this.onPortal(current)) {
        throw new McpToolError('InSync sign-in redirected off the portal domain.', {
          hint: API_HINT,
        });
      }
      const res = await this.doRequest(jar, {
        method: 'GET',
        path: current.toString(),
        headers: { Accept: 'text/html' },
      });
      if (res.status < 300 || res.status >= 400) return;
      if (res.url === undefined) return;
      current = new URL(res.url, current);
    }
    throw new McpToolError('InSync sign-in redirected too many times.', { hint: API_HINT });
  }
}
