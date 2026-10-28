# InSync portal API — shapes (keys only, no values)

A living reference for the endpoints this server calls. Request/response shapes
are recorded as **key paths only** — never real values, which are PHI. Each
section notes how it was established: `verified live` (observed read-only
through the paired browser session) or `derived from portal JS` (read out of the
portal's own bundles, not yet seen on the wire).

## File transfer (T4)

> **Provenance:** the owner's practice (`pfbhintouch`) currently has **no
> documents and no message attachments** to exercise, so the shapes below are
> **derived from the portal JS** (`_bundles_Revamp_messagesScript`,
> `_JS_DocumentBundle`, `_bundles_genralScriptbundle`), not verified on the
> wire. Re-confirm against a real file when one exists.

All file transfer goes through the portal's **own session-authorized
endpoints** — never direct object storage. The login response carries
practice-wide AWS S3 credentials, but this server never uses them to talk to S3:
hitting the bucket directly would bypass per-patient authorization. Those values
are held server-side and scrubbed from every result, error and log. A download
target URL is refused unless it stays on `*.insynchcs.com`.

### Message attachments

`GET Messages/GetToDoAttachments?todoMasaterId=<id>` — side-effect free (it is
the portal's attachment-tooltip endpoint; it does **not** open or mark the
message read). Response: a JSON array of rows.

```
[].FileName      # display name; may be "display##_##exerciseProUrl" (split on ##_##)
[].FilePath      # session-authorized portal URL the browser links to for the bytes
[].FileNotExit   # truthy => the file is still present (the portal enables the link);
                 #   falsy  => deleted or moved (link disabled)
```

The same rows also appear on `GET Messages/GetMessageDetail` as
`MessageAttachments[]`, but that read can mark an unread message read, so this
server lists attachments only through `GetToDoAttachments`.

**Fetching the bytes:** `GET <FilePath>` with the session cookies. The portal's
own script simply navigates to `FilePath`; this server fetches it, following
redirects **only within `*.insynchcs.com`** and refusing any hop off the portal.

### Documents

`POST PatientDocument/GetAllPatientDocs` (empty body) — the document list.
(Returned `{"Files":[]}` for this practice.)

```
Files[].DstFolderURL   # storage-folder handle, fed to GetFileSource
Files[].FileName       # display name (the UI rewrites ".msg" -> ".pdf")
```

**Resolving + fetching the bytes** (the portal's two-step download):

```
POST PatientDocument/GetFileSource?FolderUrl=<DstFolderURL>   # params in the query string
  -> { Status: "success" | "warning", FilePath: "<resolved server path>" }

POST PatientDocument/GetFile   { "FilePath": "<resolved server path>" }   # responseType: arraybuffer
  -> the file bytes (MIME derived from the file extension)
```

`GetFileSource` returns `Status: "warning"` (and an empty `FilePath`) when the
file no longer exists; this server surfaces that as "not available to download"
and fetches nothing.

> A legacy handler, `GET DocumentManager/DownloadFile.ashx?filePath=<path>`,
> appears in `_bundles_genralScriptbundle` as an alternative byte route. The
> Angular document viewer uses `GetFileSource` → `GetFile` instead, so that is
> what this server implements.

## File upload (T5)

> **Provenance:** **derived from the portal JS** (`_JS_ProfileBundle`), **UNVERIFIED
> on the wire.** No agent performs a real upload — it mutates practice-visible
> state — so the request below was read out of the portal's own insurance-card
> save path, not observed on a live POST. An owner-supervised live test confirms
> it later; re-confirm the success signal and any anti-forgery requirement then.

The only patient-facing upload the portal exposes is the **insurance-card image**
save. There is deliberately no generic document-upload endpoint, and this server
builds none.

### Insurance card images

`POST PatientProfile/SaveInsuranceCardImages` — form-urlencoded:

```
FrontImage           # base64 of the front image, data-URL prefix stripped ("" when not set)
BackImage            # base64 of the back image, data-URL prefix stripped ("" when not set)
DocManagerImagePath  # "" from a plain upload (the scanner path, unused here)
ScannerName          # "" from a plain upload
```

The portal JS strips a leading `data:image/<type>;base64,` prefix
(`FileReader.readAsDataURL` result) before sending; this server reads raw file
bytes, so its base64 has no such prefix, and it strips one defensively anyway.
Only `.jpg`, `.jpeg` and `.png` are accepted here (the portal UI also lists
`.gif`; it is omitted because the magic-byte guard the upload runs does not sniff
a type it would then send).

**Success signal.** The portal's own handler reads `data.Success` on this save;
other saves in the same bundle read `Status == "1"`. This server accepts
**either** (`Success === true` OR `Status == "1"`) and treats anything else as a
rejection (nothing uploaded).

**Anti-forgery.** The insurance-card `$.ajax` call does not itself carry
`__RequestVerificationToken`, but other authenticated POSTs in the bundle attach
the logged-in form token (`GET ClinicalSummary/GetAntiForgeryToken` →
`{ success, formToken }`, which refreshes the hidden
`__RequestVerificationToken` input). This server fetches that token immediately
before the write and attaches it as both a form field and the
`__RequestVerificationToken` header; a missing token is tolerated (the endpoint
may not validate one). The token is minted per write and is NOT part of the
confirm-gate binding.

**Confirm gate.** The tool is `readOnly:false, destructive:true` and gated by
`confirmWrite`: the first call reads nothing, returns a preview + `confirmToken`,
and only a repeat call with that token (after the user approves the preview)
uploads. The exact image bytes and the shown preview are bound into the token, so
a file or argument that changed since the preview is refused as `DRAFT_CHANGED`.
The write goes out once and is never replayed on a lapsed session.

**Verification-after-write** (for the later live test, documented not executed):
re-read the insurance details rather than trusting the save's `Status`/`Success`
alone, since the response is unverified.
