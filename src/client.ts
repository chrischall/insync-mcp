// InSync Healthcare (Qualifacts) patient-portal client.
//
// The portal is ASP.NET MVC. Reads are JSON POSTs with an empty body, JSON-ish
// GETs with DataTables query params, or HTML fragments. A signed-out session is
// never a 401: it is the login page served 200 (`<title>Portal :: Login`), a
// `{"isTimeout":true}` JSON body, or a 302 to `/Login`. Detecting it by status
// would report success forever, so it is detected by content here.
//
// This client parses and judges every response; the transport under it only
// moves bytes. Secret values (the password, the S3 creds) are scrubbed from
// every error it raises.

import { McpToolError } from '@chrischall/mcp-utils';
import { SecretScrubber } from './secrets.js';
import type { BinaryFetchResult, FetchResult, InsyncTransport, S3Config } from './transport.js';

/**
 * Does this response mean "not signed in"? Shared with the server transport,
 * which uses it to decide when to re-login and replay.
 */
export function isSignedOut(res: { status: number; body: string; url?: string }): boolean {
  if (res.status >= 300 && res.status < 400) return /\/Login/i.test(res.url ?? '');
  if (/<title>[^<]*Portal\s*::\s*Login/i.test(res.body)) return true;
  return /"isTimeout"\s*:\s*true/i.test(res.body);
}

/** Which transport is carrying requests, for sign-in remediation copy. */
export type TransportMode = 'server' | 'fetchproxy';

/** Medication grid filter — the portal's `Type` codes are an implementation detail. */
export type MedicationStatus = 'current' | 'discontinued' | 'cancelled';
const MEDICATION_TYPE: Record<MedicationStatus, string> = {
  current: '82',
  discontinued: '68',
  cancelled: '78',
};

/** Message folder — the portal's `messageType` codes are an implementation detail. */
export type MessageFolder = 'unread' | 'read' | 'sent';
const MESSAGE_TYPE: Record<MessageFolder, string> = { unread: '1', read: '2', sent: '4' };

/**
 * Not signed in to the portal. Carries `kind: 'session_expired'` so the
 * healthcheck classifies it without a regex, and a hint that names the live
 * transport. (A portal-specific type rather than mcp-utils'
 * `SessionNotAuthenticatedError`, whose fixed copy talks about saved homes and
 * searches — wrong for a health portal.)
 */
export class InsyncNotSignedInError extends McpToolError {
  constructor(mode: TransportMode) {
    const hint =
      mode === 'fetchproxy'
        ? 'Open your InSync portal (INSYNC_PORTAL) in a Chrome tab and sign in — the bridge ' +
          'issues requests from inside that tab, so it needs one open — then retry.'
        : 'Set INSYNC_USERNAME and INSYNC_PASSWORD so the server can sign in, then retry.';
    super(
      'Not signed in to the InSync patient portal — it returned a sign-in or timeout page.',
      { hint, kind: 'session_expired' },
    );
    this.name = 'InsyncNotSignedInError';
  }
}

export interface InsyncClientOptions {
  transport: InsyncTransport;
  /** Scrubs the password + S3 creds from errors. A fresh one is created if omitted. */
  scrubber?: SecretScrubber;
  /** Which transport is in use, for remediation copy. Default `server`. */
  mode?: TransportMode;
}

/** DataTables paging shared by the grid reads. */
export interface GridParams {
  draw?: number;
  start?: number;
  length?: number;
}

/** Arguments for {@link InsyncClient.listMessages}. */
export interface ListMessagesParams extends GridParams {
  folder: MessageFolder;
  search?: string;
  hasAttachment?: boolean;
  archived?: boolean;
}

/** Arguments for the appointment list reads. */
export interface AppointmentPageParams {
  pageSize?: number;
  currentPage?: number;
}

function gridQuery(params: GridParams, extra: Record<string, string>): string {
  return new URLSearchParams({
    draw: String(params.draw ?? 1),
    start: String(params.start ?? 0),
    length: String(params.length ?? 25),
    ...extra,
  }).toString();
}

export class InsyncClient {
  private readonly transport: InsyncTransport;
  private readonly scrubber: SecretScrubber;
  private readonly mode: TransportMode;

  constructor(opts: InsyncClientOptions) {
    this.transport = opts.transport;
    this.scrubber = opts.scrubber ?? new SecretScrubber();
    this.mode = opts.mode ?? 'server';
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** The captured S3 config, for internal use by later file code. */
  getS3Config(): S3Config | undefined {
    return this.transport.getS3Config();
  }

  /** Build a tool-facing error with every known secret value scrubbed out. */
  private fail(message: string, hint: string): McpToolError {
    return new McpToolError(this.scrubber.scrub(message), { hint: this.scrubber.scrub(hint) });
  }

  private emptyHint(): string {
    return this.mode === 'fetchproxy'
      ? 'Open your InSync portal (INSYNC_PORTAL) in a Chrome tab and sign in — the bridge ' +
          'issues requests from inside that tab, so it needs one open.'
      : 'The session may have lapsed. Retry; the next call signs in again first.';
  }

  /** Parse a JSON response, turning a sign-in page or an HTML error into an error. */
  private json<T>(res: FetchResult, endpoint: string): T {
    if (isSignedOut(res)) throw new InsyncNotSignedInError(this.mode);
    const body = res.body.trimStart();
    if (body === '') {
      throw this.fail(`InSync returned an empty response for ${endpoint}.`, this.emptyHint());
    }
    if (!body.startsWith('{') && !body.startsWith('[')) {
      const title = /<title>([^<]*)<\/title>/i.exec(res.body)?.[1];
      throw this.fail(
        `${endpoint} did not return JSON${title ? ` — the portal returned "${title.trim()}"` : ''}.`,
        'The portal markup may have changed, or the request needs parameters it was not ' +
          'given; see docs/INSYNC-API.md.',
      );
    }
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw this.fail(
        `${endpoint} returned a response that could not be parsed as JSON.`,
        'The portal markup may have changed; see docs/INSYNC-API.md.',
      );
    }
  }

  /** Return an HTML/text response, rejecting a sign-in page or an empty body. */
  private text(res: FetchResult, endpoint: string): string {
    if (isSignedOut(res)) throw new InsyncNotSignedInError(this.mode);
    if (res.body.trim() === '') {
      throw this.fail(`InSync returned an empty response for ${endpoint}.`, this.emptyHint());
    }
    return res.body;
  }

  /** Fetch a signed-in page as text — used by the bridge healthcheck probe. */
  async pageText(path: string): Promise<string> {
    return this.text(await this.transport.getText(path), path);
  }

  // --- reads (see docs/INSYNC-API.md for shapes) ---

  async getCounts(): Promise<unknown> {
    const path = 'Dashboard/GetDashBoradCount';
    return this.json(await this.transport.postJson(path, {}), path);
  }

  async getBalance(): Promise<unknown> {
    const path = 'Dashboard/GetPateintBalance';
    return this.json(await this.transport.postJson(path, {}), path);
  }

  async listAppointments(
    when: 'upcoming' | 'past',
    params: AppointmentPageParams = {},
  ): Promise<unknown> {
    const path =
      when === 'upcoming'
        ? 'PatientScheduler/FutureAppiontmentDetails'
        : 'PatientScheduler/PastAppiontmentDetails';
    const body = {
      pageOptions: { PageSize: params.pageSize ?? 20, CurrentPage: params.currentPage ?? 1 },
      sortOptions: { Field: 'VISITDATETIME', Direction: when === 'upcoming' ? 'ASC' : 'DESC' },
    };
    return this.json(await this.transport.postJson(path, body), path);
  }

  async getAppointmentCalendar(fromDate: string, toDate: string): Promise<unknown> {
    const path = 'PatientScheduler/MonthlyAppointments';
    return this.json(await this.transport.postJson(path, { FromDate: fromDate, ToDate: toDate }), path);
  }

  async listMedications(status: MedicationStatus, params: GridParams = {}): Promise<unknown> {
    const endpoint = 'AllergyMedicationClinical/GetMedicationGridData';
    const query = gridQuery(params, {
      objMedicationsSummary: JSON.stringify({ Type: MEDICATION_TYPE[status] }),
    });
    return this.json(await this.transport.getJson(`${endpoint}?${query}`), endpoint);
  }

  async listAllergies(params: GridParams = {}): Promise<unknown> {
    const endpoint = 'AllergyMedicationClinical/GetAllergiesGridData';
    const query = gridQuery(params, { objAllergie: '{}' });
    return this.json(await this.transport.getJson(`${endpoint}?${query}`), endpoint);
  }

  async listMessages(params: ListMessagesParams): Promise<unknown> {
    const endpoint = 'Messages/GetMessages';
    const query = new URLSearchParams({
      messageType: MESSAGE_TYPE[params.folder],
      searchStr: params.search ?? '',
      hasAttachment: String(params.hasAttachment ?? false),
      IsArchived: String(params.archived ?? false),
      draw: String(params.draw ?? 1),
      start: String(params.start ?? 0),
      length: String(params.length ?? 25),
    }).toString();
    return this.json(await this.transport.getJson(`${endpoint}?${query}`), endpoint);
  }

  async getMessageDetail(args: {
    childId: string;
    masterId: string;
    type?: string;
  }): Promise<unknown> {
    const endpoint = 'Messages/GetMessageDetail';
    const query = new URLSearchParams({
      toDoChildId: args.childId,
      todoMasaterId: args.masterId,
      type: args.type ?? 'inbox',
    }).toString();
    return this.json(await this.transport.getJson(`${endpoint}?${query}`), endpoint);
  }

  async listForms(): Promise<unknown> {
    const path = 'PatientDocument/GetPatientFromList';
    return this.json(await this.transport.postJson(path, {}), path);
  }

  /** The received-surveys HTML fragment (`<tr>` rows); parsed by the tool layer. */
  async listSurveys(): Promise<string> {
    const path = 'SurveyForms/GetReceivedSurveyForms';
    return this.text(await this.transport.getText(path), path);
  }

  async listDocuments(): Promise<unknown> {
    const path = 'PatientDocument/GetAllPatientDocs';
    return this.json(await this.transport.postJson(path, {}), path);
  }

  async getProfile(): Promise<unknown> {
    const path = 'PatientProfile/GetPatientDetails';
    return this.json(await this.transport.postJson(path, {}), path);
  }

  /** The refill-history grid HTML; parsed by the tool layer. */
  async listRefillRequests(params: GridParams = {}): Promise<string> {
    const path = 'RefillPrescription/RefillPrescripationGrid';
    const form = {
      draw: String(params.draw ?? 1),
      start: String(params.start ?? 0),
      length: String(params.length ?? 25),
    };
    return this.text(await this.transport.postForm(path, form), path);
  }

  // --- file transfer (portal endpoints only — never direct S3) ---

  /**
   * The attachment rows for a message (`GetToDoAttachments`). Listing is
   * side-effect free — it is the portal's own attachment-tooltip endpoint, not
   * the message-detail read that can mark a message read.
   */
  async listAttachments(masterId: string): Promise<unknown> {
    const endpoint = 'Messages/GetToDoAttachments';
    const query = new URLSearchParams({ todoMasaterId: masterId }).toString();
    return this.json(await this.transport.getJson(`${endpoint}?${query}`), endpoint);
  }

  /**
   * Download a message attachment's bytes from its portal `FilePath`. The path
   * is refused unless it stays on the portal domain, so a download can never be
   * pointed at direct storage. The caller never sees the URL — it is resolved
   * from the attachment row here.
   */
  async downloadAttachment(filePath: string): Promise<BinaryFetchResult> {
    this.assertPortalUrl(filePath);
    return this.binary(await this.transport.getBinary(filePath), 'the attachment');
  }

  /**
   * Resolve a document's storage folder to a concrete server file path
   * (`GetFileSource`). Returns the portal's `{ Status, FilePath }`; the FilePath
   * is an internal handle fed straight to {@link downloadFile}, never surfaced.
   */
  async getFileSource(folderUrl: string): Promise<{ status: string; filePath: string }> {
    const endpoint = 'PatientDocument/GetFileSource';
    const query = new URLSearchParams({ FolderUrl: folderUrl }).toString();
    const data = this.json<Record<string, unknown>>(
      await this.transport.postJson(`${endpoint}?${query}`, {}),
      endpoint,
    );
    return {
      status: typeof data.Status === 'string' ? data.Status : '',
      filePath: typeof data.FilePath === 'string' ? data.FilePath : '',
    };
  }

  /** Fetch a resolved document's bytes (`GetFile`), given a FilePath from {@link getFileSource}. */
  async downloadFile(filePath: string): Promise<BinaryFetchResult> {
    return this.binary(
      await this.transport.postBinary('PatientDocument/GetFile', { FilePath: filePath }),
      'the document',
    );
  }

  // --- writes (confirm-gated at the tool layer; the session/CSRF are attached here) ---

  /**
   * The single portal-write path. Fetches a fresh logged-in anti-forgery token,
   * attaches it (as a form field AND the header the portal's own AJAX uses) and
   * the session, POSTs the form ONCE — never replayed, so a lapsed session that
   * silently re-authenticates cannot resubmit a write as whoever the new session
   * serves — and judges the portal's accept/reject. Returns the portal `Status`
   * for the tool to surface; throws (nothing written) on rejection.
   *
   * Derived from the portal JS, UNVERIFIED on the wire — see docs/INSYNC-API.md.
   */
  async upload(path: string, form: Record<string, string>): Promise<{ status?: string }> {
    const token = await this.antiForgeryToken();
    const body: Record<string, string> = { ...form };
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      body.__RequestVerificationToken = token;
      headers.__RequestVerificationToken = token;
    }
    const res = await this.transport.postForm(path, body, { replay: false, headers });
    const data = this.json<Record<string, unknown>>(res, path);
    // The portal's success signal differs by handler: the insurance-card save
    // reads `Success`, other saves read `Status == "1"`. Accept either.
    const accepted = data.Success === true || String(data.Status) === '1';
    if (!accepted) {
      throw this.fail(
        `InSync did not accept the upload to ${path}.`,
        'Nothing was uploaded. The portal rejected the request, or its save flow changed; ' +
          'see docs/INSYNC-API.md.',
      );
    }
    return { status: data.Status !== undefined ? String(data.Status) : undefined };
  }

  /**
   * A fresh logged-in anti-forgery token (`GetAntiForgeryToken` → `formToken`),
   * fetched the moment before a write so it matches the current session. Read
   * raw (not through {@link json}) because a signed-out response is surfaced as
   * the portal-specific not-signed-in error, and a missing token is tolerated —
   * the portal may not validate every endpoint, and the write still judges its
   * own accept/reject.
   */
  private async antiForgeryToken(): Promise<string | undefined> {
    const endpoint = 'ClinicalSummary/GetAntiForgeryToken';
    const res = await this.transport.getText(endpoint);
    if (isSignedOut(res)) throw new InsyncNotSignedInError(this.mode);
    try {
      const data = JSON.parse(res.body) as Record<string, unknown>;
      return typeof data.formToken === 'string' && data.formToken !== '' ? data.formToken : undefined;
    } catch {
      return undefined;
    }
  }

  /** Refuse an absolute download URL that leaves the InSync portal domain. */
  private assertPortalUrl(filePath: string): void {
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath);
    if (!isAbsolute) return; // relative → resolved against the portal by the transport
    let host: string;
    try {
      host = new URL(filePath).hostname;
    } catch {
      throw this.fail('The attachment path is not a valid URL.', this.emptyHint());
    }
    if (!host.endsWith('.insynchcs.com')) {
      throw this.fail(
        'Refusing to download this attachment from a host outside the InSync portal.',
        'InSync file downloads go only through the portal, never direct storage (S3).',
      );
    }
  }

  /** Validate a binary response: reject a sign-in page, an error status or empty bytes. */
  private binary(res: BinaryFetchResult, what: string): BinaryFetchResult {
    if (isSignedOut(res)) throw new InsyncNotSignedInError(this.mode);
    if (res.status >= 400) {
      throw this.fail(
        `InSync returned ${res.status} fetching ${what}.`,
        'The file may no longer exist, or the portal changed; see docs/INSYNC-API.md.',
      );
    }
    if (res.bytes.length === 0) {
      throw this.fail(`InSync returned no data for ${what}.`, this.emptyHint());
    }
    return res;
  }
}
