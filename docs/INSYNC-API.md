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
