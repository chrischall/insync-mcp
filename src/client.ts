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

import { McpToolError, WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
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
 * The fetchproxy remediation sentence, shared by the not-signed-in error and
 * the empty-response hint. Each caller adds its own ending (with or without
 * "then retry"), so it carries no closing punctuation.
 */
const FETCHPROXY_SIGN_IN_HINT =
  'Open your InSync portal (INSYNC_PORTAL) in a Chrome tab and sign in — the bridge ' +
  'issues requests from inside that tab, so it needs one open';

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
        ? `${FETCHPROXY_SIGN_IN_HINT} — then retry.`
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
  /**
   * The configured portal host (e.g. `pfbhintouch.insynchcs.com`). When set, a
   * download path must resolve to exactly this host; when omitted (tests), any
   * `*.insynchcs.com` host is accepted.
   */
  portalHost?: string;
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

/** The DataTables paging fields with their defaults, as strings for a query or form. */
function gridParams(params: GridParams): Record<string, string> {
  return {
    draw: String(params.draw ?? 1),
    start: String(params.start ?? 0),
    length: String(params.length ?? 25),
  };
}

function gridQuery(params: GridParams, extra: Record<string, string>): string {
  return new URLSearchParams({ ...gridParams(params), ...extra }).toString();
}

/**
 * Stand-in base for resolving a relative download path when no portal host is
 * configured. Any `*.insynchcs.com` name works: it only has to pass the suffix
 * check, so a relative path is accepted exactly as before.
 */
const UNCONFIGURED_PORTAL_HOST = 'portal.insynchcs.com';

/** Rows of the unread folder the unread gate reads in its one page. */
const UNREAD_PAGE_SIZE = 200;

export class InsyncClient {
  private readonly transport: InsyncTransport;
  private readonly scrubber: SecretScrubber;
  private readonly mode: TransportMode;
  private readonly portalHost: string | undefined;

  constructor(opts: InsyncClientOptions) {
    this.transport = opts.transport;
    this.scrubber = opts.scrubber ?? new SecretScrubber();
    this.mode = opts.mode ?? 'server';
    this.portalHost = opts.portalHost;
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
      ? `${FETCHPROXY_SIGN_IN_HINT}.`
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
    const query = gridQuery(params, {
      messageType: MESSAGE_TYPE[params.folder],
      searchStr: params.search ?? '',
      hasAttachment: String(params.hasAttachment ?? false),
      IsArchived: String(params.archived ?? false),
    });
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
    return this.text(await this.transport.postForm(path, gridParams(params)), path);
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
   * for the tool to surface; throws (nothing written) on rejection. The HTTP
   * status is judged first (see {@link submitFormJson}), so a 5xx after the
   * bytes landed is an UNKNOWN outcome, never a "did not return JSON" error
   * that reads as safe to retry.
   *
   * Derived from the portal JS, UNVERIFIED on the wire — see docs/INSYNC-API.md.
   */
  async upload(path: string, form: Record<string, string>): Promise<{ status?: string }> {
    const data = await this.submitFormJson(path, form);
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
   * POST a write form exactly once: a fresh anti-forgery token is attached (as a
   * field and the `__RequestVerificationToken` header, when the portal yields
   * one) and the transport is forbidden to re-login and replay it. Only the
   * signed-out check happens here; judging accept/reject is the caller's.
   */
  private async sendForm(
    path: string,
    form: Record<string, string> | URLSearchParams,
  ): Promise<FetchResult> {
    const token = await this.antiForgeryToken();
    const headers: Record<string, string> = {};
    let body: Record<string, string> | URLSearchParams;
    if (form instanceof URLSearchParams) {
      body = new URLSearchParams(form);
      if (token !== undefined) body.set('__RequestVerificationToken', token);
    } else {
      body = { ...form };
      if (token !== undefined) body.__RequestVerificationToken = token;
    }
    if (token !== undefined) headers.__RequestVerificationToken = token;
    const res = await this.sent(() => this.transport.postForm(path, body, { replay: false, headers }));
    if (isSignedOut(res)) throw new InsyncNotSignedInError(this.mode);
    return res;
  }

  /**
   * Run a write's request. A failure that is not already a tool error (a
   * timeout, a dropped connection) happened AFTER the request may have reached
   * the portal, so it is reported as {@link WriteOutcomeUnknownError} — never as
   * a plain error that reads as "safe to retry".
   */
  private async sent(run: () => Promise<FetchResult>): Promise<FetchResult> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof McpToolError) throw err;
      throw new WriteOutcomeUnknownError('InSync', 'POST', { cause: err });
    }
  }

  /**
   * Judge a write's HTTP status: a 4xx is the portal refusing it (nothing
   * applied); a 5xx is no proof either way — a backend can fail after
   * committing — so it is {@link WriteOutcomeUnknownError}.
   */
  private assertWriteStatus(res: FetchResult, path: string): void {
    if (res.status >= 500) {
      throw new WriteOutcomeUnknownError('InSync', 'POST', {
        hint:
          `InSync answered ${path} with HTTP ${res.status}, so the write may or may not have ` +
          'happened. Re-read the matching list before retrying; do not resend blindly.',
      });
    }
    if (res.status >= 400) {
      throw this.fail(
        `InSync refused ${path} with HTTP ${res.status}.`,
        'Nothing was applied. The request shape may have changed; see docs/INSYNC-API.md.',
      );
    }
  }

  /**
   * Submit a write form once (see {@link sendForm}) and return the raw body.
   * Several portal saves answer with an empty body or an HTML fragment and judge
   * success only by the HTTP status, so the body is left to the tool to read.
   */
  async submitForm(path: string, form: Record<string, string> | URLSearchParams): Promise<string> {
    const res = await this.sendForm(path, form);
    this.assertWriteStatus(res, path);
    return res.body;
  }

  /** Submit a write form once (see {@link sendForm}) and parse its JSON answer. */
  async submitFormJson(
    path: string,
    form: Record<string, string> | URLSearchParams,
  ): Promise<Record<string, unknown>> {
    const res = await this.sendForm(path, form);
    this.assertWriteStatus(res, path);
    return this.json<Record<string, unknown>>(res, path);
  }

  /** Submit a JSON write once, never replayed, and parse the JSON answer. */
  async submitJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.sent(() => this.transport.postJson(path, body, { replay: false }));
    if (isSignedOut(res)) throw new InsyncNotSignedInError(this.mode);
    this.assertWriteStatus(res, path);
    return this.json<Record<string, unknown>>(res, path);
  }

  // --- lookups the write tools read first (all side-effect free) ---

  /**
   * The unread-folder row for one message, or undefined when it is not unread.
   * This is the gate that keeps a tool from opening — and so marking read — an
   * unread message, so it fails CLOSED: one page of {@link UNREAD_PAGE_SIZE}
   * rows is read, and when the portal's `recordsTotal` says the folder holds
   * more than that page and no row matched, the answer is unknown, not "read",
   * and this throws instead. Paging through the rest is deliberately not
   * attempted. A listing with no numeric `recordsTotal` is taken as complete.
   */
  async findUnreadMessage(childId: string, masterId: string): Promise<Record<string, unknown> | undefined> {
    // json() only hands back an object or an array; an array simply has no `data`.
    const listing = (await this.listMessages({ folder: 'unread', length: UNREAD_PAGE_SIZE })) as Record<
      string,
      unknown
    >;
    const rows: unknown[] = Array.isArray(listing.data) ? listing.data : [];
    // Compared as strings: the portal sends these ids as numbers, the tools take strings.
    const match = rows.find(
      (r): r is Record<string, unknown> =>
        r !== null &&
        typeof r === 'object' &&
        String((r as Record<string, unknown>).TODOChildId) === childId &&
        String((r as Record<string, unknown>).TODOMasterId) === masterId,
    );
    if (match !== undefined) return match;
    const total = Number(listing.recordsTotal);
    if (Number.isFinite(total) && total > rows.length) {
      throw new McpToolError(
        `Could not confirm whether this message is unread: the unread folder has ${total} messages ` +
          `and only ${rows.length} were checked.`,
        {
          hint:
            'Open the message in the portal, or re-call with allow_mark_read=true after the user ' +
            'agrees. (This server does not page through the rest of the unread folder.)',
        },
      );
    }
    return undefined;
  }

  /** Whether one message is in the unread folder; throws when that cannot be told (see {@link findUnreadMessage}). */
  async isUnread(childId: string, masterId: string): Promise<boolean> {
    return (await this.findUnreadMessage(childId, masterId)) !== undefined;
  }

  /** Compose recipients (`Resources[]`) and quick subjects — `GetComposeMessageDetail`. */
  async getComposeDetail(): Promise<unknown> {
    const path = 'Messages/GetComposeMessageDetail';
    return this.json(await this.transport.getJson(path), path);
  }

  /** The compose partial view; the tool reads its server-stamped `ReminderDate`. */
  async getComposeForm(): Promise<string> {
    const path = 'Messages/LoadComposeMessageDetail?IsPriorityEnable=false';
    return this.text(await this.transport.getText(path), path);
  }

  /**
   * The reply partial view for one message: its hidden ids, reply-to group,
   * quoted history and prefilled subject. Verified side-effect free on a READ
   * message (the unread count did not move); the tool still refuses an unread one.
   */
  async getReplyForm(childId: string, masterId: string): Promise<string> {
    const path = 'Messages/GetComposeDetailForReply';
    const Mstparams = JSON.stringify({ TODOChildId: childId, TODOMasterId: masterId });
    return this.text(await this.transport.postForm(path, { Mstparams }), path);
  }

  /** The refill-request page: its medication and provider pick lists. */
  async getRefillForm(): Promise<string> {
    const path = 'RefillPrescription/RefillPrescription';
    return this.text(await this.transport.getText(path), path);
  }

  /** The scheduler page: carries the hidden `PracticeID` the facility lookup needs. */
  async getSchedulerPage(): Promise<string> {
    const path = 'PatientScheduler';
    return this.text(await this.transport.getText(path), path);
  }

  async listRequestFacilities(practiceId: string): Promise<unknown> {
    const endpoint = 'PatientScheduler/BindFacilities';
    const query = new URLSearchParams({ practiceId }).toString();
    return this.json(await this.transport.postForm(`${endpoint}?${query}`, {}), endpoint);
  }

  /** Providers bookable at a facility on a date (`MM/DD/YYYY`). The filters are left blank. */
  async listRequestProviders(facilityId: string, date: string): Promise<unknown> {
    const endpoint = 'PatientScheduler/BindProviders';
    const query = new URLSearchParams({
      facilityId,
      date,
      GenderIds: '',
      LanguageIds: '',
      ServiceOfferedIds: '',
      CredentialIds: '',
    }).toString();
    return this.json(await this.transport.postForm(`${endpoint}?${query}`, {}), endpoint);
  }

  /** The visit types a provider's schedule offers on a date. `SpCalledFrom` is the page's fixed `1`. */
  async listRequestVisitTypes(args: {
    scheduleSetupId: string;
    date: string;
    facilityId: string;
  }): Promise<unknown> {
    const path = 'PatientScheduler/GetSchedulerVisitTypeSlots';
    const body = {
      VisitDate: args.date,
      ScheduleSetupID: args.scheduleSetupId,
      SpCalledFrom: 1,
      FacilityId: args.facilityId,
    };
    return this.json(await this.transport.postJson(path, body), path);
  }

  /**
   * A provider's time slots on a date. The portal passes the schedule-setup id
   * as `providerId` and the provider's resource id as `ResourceId`.
   */
  async listRequestSlots(args: {
    scheduleSetupId: string;
    date: string;
    currentTime: string;
    resourceId: string;
    visitTypeId: string;
  }): Promise<unknown> {
    const endpoint = 'PatientScheduler/BindSchedulerSlots';
    const query = new URLSearchParams({
      providerId: args.scheduleSetupId,
      date: args.date,
      currentTime: args.currentTime,
      ResourceId: args.resourceId,
      EncounterTypeID: args.visitTypeId,
    }).toString();
    return this.json(await this.transport.postForm(`${endpoint}?${query}`, {}), endpoint);
  }

  /** The cancellation-window check: `"2"` means the period has passed (verified `"0"` = allowed). */
  async checkCancelWindow(visitId: string): Promise<string> {
    const endpoint = 'Appointment/CheckCancelAppointmentRequestTimeDuration';
    const query = new URLSearchParams({ VisitID: visitId }).toString();
    return this.text(await this.transport.getText(`${endpoint}?${query}`), endpoint).trim();
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

  /**
   * Refuse a download path that leaves the InSync portal. The path is RESOLVED
   * against the portal first — the way the transport will resolve it — and the
   * resulting host is judged, so a protocol-relative `//evil.example/x` (which
   * no "is it absolute?" pattern catches) is seen for the off-portal URL it is.
   * With a configured portal host the match is exact; without one (tests) it
   * falls back to the `*.insynchcs.com` suffix.
   */
  private assertPortalUrl(filePath: string): void {
    const base = `https://${this.portalHost ?? UNCONFIGURED_PORTAL_HOST}/`;
    let host: string;
    try {
      host = new URL(filePath, base).hostname;
    } catch {
      throw this.fail('The attachment path is not a valid URL.', this.emptyHint());
    }
    const onPortal =
      this.portalHost !== undefined ? host === this.portalHost : host.endsWith('.insynchcs.com');
    if (!onPortal) {
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
