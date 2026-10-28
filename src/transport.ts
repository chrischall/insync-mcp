// The transport surface the client talks through, plus the two value types and
// errors shared by both transports and the client.
//
// A transport owns the HTTP mechanics — cookies or the browser bridge, redirect
// following, re-login on expiry — and returns a raw `{ status, body, url }`
// triple. Parsing, signed-out detection and projection all live in the client,
// so the two transports stay interchangeable. The method names describe the
// REQUEST shape (JSON body, form body, plain text), never the response: every
// one resolves to a `FetchResult` whose `body` is untouched text.

import { McpToolError } from '@chrischall/mcp-utils';

/** The raw result of one request. `url` is the `Location` header on a redirect. */
export interface FetchResult {
  status: number;
  body: string;
  url?: string;
}

/**
 * A binary request's result. Extends {@link FetchResult} so the session manager
 * and {@link isSignedOut} can judge it exactly as they judge a text result:
 * `body` holds a short decoded prefix ONLY when the response looks like text (a
 * sign-in page, a JSON timeout, a redirect), and is empty for real binary. The
 * bytes ride alongside on `bytes`.
 */
export interface BinaryFetchResult extends FetchResult {
  bytes: Uint8Array;
  /** The upstream `Content-Type`, used to pick a file extension. */
  contentType?: string;
}

/** Per-call options shared by every verb. */
export interface RequestOptions {
  /** Extra request headers, merged over the verb's defaults. */
  headers?: Record<string, string>;
  /**
   * `false` forbids the credential transport from signing in again and
   * replaying this request when the session turns out to have expired. Set it
   * on a WRITE: a fresh sign-in restores the portal to the account holder, so a
   * replay would act as whoever the new session serves. Default: replay once.
   */
  replay?: false;
}

/**
 * The practice-wide AWS S3 credentials the login response carries. Captured and
 * held on the session so later file code can read them, and their string values
 * are registered with the {@link SecretScrubber} the moment they are captured —
 * the server NEVER talks to S3 directly, and these must never reach a result,
 * an error or a log.
 */
export interface S3Config {
  enabled: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucketName?: string;
  regionEndpoint?: string;
  practiceFolderName?: string;
}

/** What the client needs of a transport — faked wholesale in tests. */
export interface InsyncTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  /** A diagnostic snapshot for the healthcheck tool; shape varies by transport. */
  status(): unknown;
  getJson(path: string, opts?: RequestOptions): Promise<FetchResult>;
  postJson(path: string, body: unknown, opts?: RequestOptions): Promise<FetchResult>;
  postForm(
    path: string,
    form: Record<string, string> | URLSearchParams,
    opts?: RequestOptions,
  ): Promise<FetchResult>;
  getText(path: string, opts?: RequestOptions): Promise<FetchResult>;
  postText(path: string, body: string, opts?: RequestOptions): Promise<FetchResult>;
  /**
   * GET a binary payload (a downloaded file's bytes). Follows redirects only
   * within the portal domain; a redirect off `*.insynchcs.com` is refused so a
   * download can never be bounced to direct storage (S3). Not available on the
   * browser-bridge transport, which relays text only.
   */
  getBinary(path: string, opts?: RequestOptions): Promise<BinaryFetchResult>;
  /** POST a JSON body and read a binary payload back (the document `GetFile` endpoint). */
  postBinary(path: string, body: unknown, opts?: RequestOptions): Promise<BinaryFetchResult>;
  /** The captured S3 config, or `undefined` (never captured on the bridge path). */
  getS3Config(): S3Config | undefined;
}

/**
 * A login failure that MUST NOT be retried — bad/inactive/locked credentials, a
 * missing credential, an unsupported account shape, or an invalid portal URL.
 * Cached by {@link CookieSessionManager} so repeated tool calls do not each
 * resubmit the password (which counts toward an account lockout).
 */
export class PermanentTransportError extends McpToolError {
  constructor(message: string, opts: ConstructorParameters<typeof McpToolError>[1]) {
    super(message, opts);
    this.name = 'PermanentTransportError';
  }
}

/**
 * A write hit an expired session, so the portal provably did NOT act on it. A
 * distinct type because "not accepted" is safe to retry, unlike a failure after
 * the request may have been applied.
 */
export class NotAcceptedError extends McpToolError {
  constructor(message: string, opts: { hint: string }) {
    super(message, { ...opts, kind: 'session_expired' });
    this.name = 'NotAcceptedError';
  }
}

/** A validated `INSYNC_PORTAL`: its origin, host and practice subdomain. */
export interface PortalInfo {
  origin: string;
  host: string;
  subdomain: string;
}

/**
 * Validate `INSYNC_PORTAL` and extract the pieces both transports need. Requires
 * `https://<sub>.insynchcs.com` with no path and no query — the portal is
 * per-practice, so a wrong host silently reads someone else's practice.
 */
export function parsePortal(raw: string | undefined): PortalInfo {
  const hint =
    'Set INSYNC_PORTAL to your practice portal, e.g. https://pfbhintouch.insynchcs.com ' +
    '(scheme + host only, no path).';
  if (raw === undefined || raw.trim() === '') {
    throw new PermanentTransportError('INSYNC_PORTAL is required.', { hint, kind: 'no_credential' });
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PermanentTransportError(`INSYNC_PORTAL is not a valid URL: ${raw}`, { hint });
  }
  if (url.protocol !== 'https:') {
    throw new PermanentTransportError('INSYNC_PORTAL must use https.', { hint });
  }
  if (!url.hostname.endsWith('.insynchcs.com')) {
    throw new PermanentTransportError('INSYNC_PORTAL must be an insynchcs.com host.', { hint });
  }
  if (url.pathname !== '/' || url.search !== '') {
    throw new PermanentTransportError('INSYNC_PORTAL must have no path or query.', { hint });
  }
  const subdomain = url.hostname.slice(0, -'.insynchcs.com'.length);
  if (subdomain === '') {
    throw new PermanentTransportError('INSYNC_PORTAL is missing a practice subdomain.', { hint });
  }
  return { origin: url.origin, host: url.hostname, subdomain };
}
