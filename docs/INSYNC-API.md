# InSync portal API — shapes (keys only, no values)

A living reference for the endpoints this server calls. Request/response shapes
are recorded as **key paths only** — never real values, which are PHI. Each
section notes how it was established: `verified live` (observed read-only
through the paired browser session) or `derived from portal JS` (read out of the
portal's own bundles, not yet seen on the wire).

## Reads (T3)

> **Provenance: `verified live`** — every read below was observed read-only
> through the paired browser session (see `skills/insync-fpx/references/endpoints.md`).
> Only the keys each tool projects are listed; the portal returns more. A
> signed-out response is the login page (`<title>Portal :: Login`), an
> `{"isTimeout":true}` body, or a `302` to `/Login` — detected by content, never
> by status.

### Dashboard counts — `insync_get_counts`

`POST Dashboard/GetDashBoradCount` (empty body).

```
Dashboard[0].UnreadMessage                   # -> unreadMessages
Dashboard[0].Medications                     # -> medications
Dashboard[0].Allergies                       # -> allergies
Dashboard[0].Problems                        # -> problems
Dashboard[0].LabResults                      # -> labResults
Dashboard[0].Immunizations                   # -> immunizations
Dashboard[0].PendingPatientFormCount         # -> pendingForms
Dashboard[0].PendingPatientSurveyFormCount   # -> pendingSurveys
Dashboard[0].PatientID / .PracticeId         # internal ids — dropped (not projected)
```

### Balance — `insync_get_balance`

`POST Dashboard/GetPateintBalance` (empty body).

```
Dashboard.PaymentSummaryModel[0].NetDue          # -> netDue
Dashboard.PaymentSummaryModel[0].CreditBalance   # -> creditBalance
```

### Appointments — `insync_list_appointments`

`POST PatientScheduler/FutureAppiontmentDetails` (upcoming) or
`PatientScheduler/PastAppiontmentDetails` (past):

```
{ "pageOptions": { "PageSize": <n>, "CurrentPage": <p> },
  "sortOptions": { "Field": "VISITDATETIME", "Direction": "ASC" | "DESC" } }
```

```
currentAppointment.TotalRows                 # -> total
currentAppointment.Appointment[].VisitID     # -> visitId
currentAppointment.Appointment[].VisitDate   # -> date (MM/DD/YYYY)
currentAppointment.Appointment[].StartTime   # -> start
currentAppointment.Appointment[].EndTime     # -> end
currentAppointment.Appointment[].Provider    # -> provider
currentAppointment.Appointment[].FacilityName  # -> facility
currentAppointment.Appointment[].VisitType   # -> type
currentAppointment.Appointment[].VisitStatus # -> status
currentAppointment.Appointment[].ExpectedCopay # -> expectedCopay
currentAppointment.Appointment[].STime{...}  # tick/minute noise — dropped
```

### Appointment calendar — `insync_get_appointment_calendar`

`POST PatientScheduler/MonthlyAppointments` — `{ "FromDate": "MM/DD/YYYY",
"ToDate": "MM/DD/YYYY" }` (ISO `from`/`to` are converted; default is the current
month).

```
totalCount                  # -> total
appointments[].VisitDate    # -> date
appointments[].TimeSlab     # -> time
appointments[].AppText      # -> label
appointments[].VisitID      # -> visitId
appointments[].ColorCode    # dropped
```

### Medications — `insync_list_medications`

`GET AllergyMedicationClinical/GetMedicationGridData?<DataTables>&objMedicationsSummary={"Type":"<code>"}`
— `Type` `82` current, `68` discontinued, `78` cancelled (the `status` arg).

```
recordsTotal                 # -> total
data[].DrugName              # -> name
data[].Dispense              # -> dispense
data[].DrugQuantity          # -> quantity
data[].Refills               # -> refills
data[].DaysSupply            # -> daysSupply
data[].PrescriptionDatetxt   # -> prescribed (preferred; falls back to PrescriptionDate)
data[].PhysicianName         # -> prescriber
data[].Rxcui                 # -> rxcui
```

### Allergies — `insync_list_allergies`

`GET AllergyMedicationClinical/GetAllergiesGridData?<DataTables>&objAllergie={}`.

```
recordsTotal   # -> total
data[]         # -> allergies[] (rows passed through; e.g. AllergyName, Reaction)
```

### Messages (list) — `insync_list_messages`

`GET Messages/GetMessages?messageType=<1|2|4>&searchStr=&hasAttachment=&IsArchived=&draw=&start=&length=`
— `messageType` `1` unread, `2` read, `4` sent. **Listing is side-effect free.**
The result is wrapped `untrusted_content: true` (practice-authored text).

```
recordsTotal                 # -> total
UnreadMessagesCount          # -> unreadCount
data[].TODOChildId           # -> childId   (needed by insync_get_message)
data[].TODOMasterId          # -> masterId  (needed by insync_get_message / attachments)
data[].GroupName             # -> from
data[].ToGroupName           # -> to
data[].TaskSubject           # -> subject
data[].ReminderDateText      # -> date
data[].TotalAttachments      # -> attachments
data[].IsImportant           # -> important
data[].IsFromPatient         # -> fromPatient
```

### Message detail — `insync_get_message`

`GET Messages/GetMessageDetail?toDoChildId=<id>&todoMasaterId=<id>&type=inbox`.
**Opening an UNREAD message probably marks it read** (visible to the practice, no
inverse); the tool checks the unread list first and refuses to fetch the detail
unless `allow_mark_read` is set. Body HTML is run through `htmlToReadableText`.

```
PracticeName                        # -> practice
MessageDetail.TaskSubject           # -> subject
MessageDetail.CreatedOnText         # -> date
MessageDetail.PatientName           # -> patient
MessageDetail.TaskMessage           # -> body (HTML -> readable text)
MessageAttachments[].FileName       # -> attachment name
MessageAttachments[].FilePath       # a session URL — NEVER returned
```

### Forms — `insync_list_forms`

`POST PatientDocument/GetPatientFromList` (empty body). `status: pending`
(`Status == "Sent"`) or `all`.

```
PatientFormcollection[].FormName            # -> name
PatientFormcollection[].Status              # -> status ("Sent" = pending, "Received" = submitted)
PatientFormcollection[].SentOn              # -> sentOn
PatientFormcollection[].ReceivedOn          # -> receivedOn (full view)
PatientFormcollection[].LastSubmittedOn     # -> lastSubmittedOn (full view)
PatientFormcollection[].SubPatientFormID    # -> formId
PatientFormcollection[].TemplateID          # -> templateId
# NEVER returned, on any view: PatientUserPassword, PatientUserName,
# TemplateHTML, PlainHTML, TemplateScript, InsyncSiteURl.
```

### Surveys — `insync_list_surveys`

`GET SurveyForms/GetReceivedSurveyForms` — an **HTML fragment** of `<tr>` rows.
Each data row has a name cell and a received-date cell; the `<tr onclick>` holds
a sign-in token.

```
tr > td[0]            # -> name
tr > td.ReceivedDate  # -> receivedDate (the 2nd cell)
tr[onclick=...]       # sign-in token — NEVER returned
# header rows (no <td>), empty-name rows, and <2-cell rows are skipped
```

### Documents (list) — `insync_list_documents`

`POST PatientDocument/GetAllPatientDocs` (empty body). (Returned `{"Files":[]}`
for the owner's practice — handle empty.)

```
Files[]     # -> the projected list (rows passed through)
TreeData[]  # dropped
```

See **File transfer** below for retrieving a document's bytes.

### Profile — `insync_get_profile`

`POST PatientProfile/GetPatientDetails` (empty body; ~540 KB). Only **scalar**
fields of `PatientDetail` are projected.

```
PatientDetail.<scalar>   # strings / numbers / booleans kept (FirstName, LastName, DOB, Age, Active, ...)
PatientDetail.Image      # photo bytes — NEVER returned, on any view
PatientDetail.*List      # picklists / arrays — dropped
PatientDetail.<object>   # nested objects (e.g. Address) — dropped
PatientDetail.*Password* / *Hash* / *Token*  # credential-shaped keys — dropped
```

### Refill history — `insync_list_refill_requests`

`POST RefillPrescription/RefillPrescripationGrid` (form-urlencoded `draw`,
`start`, `length`) — an **HTML grid**. Rows are parsed to objects keyed by the
`<thead>` column headers. **Lists history only; submits no refill.**

```
<table><thead><tr><th>..column headers..</th></tr></thead>
       <tbody><tr><td>..values..</td></tr></tbody></table>
# -> [ { <header>: <cell>, ... }, ... ]
```

## File transfer (T4)

> **Provenance:** the owner's practice (`pfbhintouch`) currently has **no
> documents and no message attachments** to exercise, so the shapes below are
> **derived from the portal JS** (`_bundles_Revamp_messagesScript`,
> `_JS_DocumentBundle`, `_bundles_genralScriptbundle`), not verified on the
> wire. Re-confirm against a real file when one exists.

All file transfer goes through the portal's **own session-authorized
endpoints** — never direct object storage. The login response carries some
object-storage configuration, but this server never uses it to talk to storage
directly; doing so would sidestep the portal's per-patient authorization. Any
such values are held server-side and scrubbed from every result, error and log.
A download target URL is refused unless it stays on `*.insynchcs.com`.

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

## Messages, refill, appointment and cancellation requests (T6)

> **Provenance:** every **lookup** below was **verified live, read-only**
> (2026-10-28, owner's practice; the unread count did not move across the reply
> form load). Every **send** is **derived from the portal JS** —
> `_bundles_Revamp_messagesScript`, `_bundles_Revamp_refillPrescriptionScript`,
> `_JS_AppointmentBundle` — and the cancel partial view's inline script, and is
> **UNVERIFIED on the wire**: no automated run sends one, because each reaches
> the practice. Re-confirm each success signal on an owner-supervised send.

All five sends are `readOnly:false, destructive:true`, gated by `confirmWrite`
through `defineWrite` / `registerWrite`, go out exactly once (`replay: false`),
and attach a fresh anti-forgery token to the form posts (as for the upload). A
5xx or a dropped connection after sending is `WriteOutcomeUnknownError`, which
the tools report as `status: "unknown"` (check the named list before retrying);
a 4xx is a refusal (nothing applied).

### Compose — `insync_list_message_recipients`, `insync_send_message`

`GET Messages/GetComposeMessageDetail` (verified):

```
Resources[].UserGroupID   # -> recipients[].groupId
Resources[].GroupName     # -> recipients[].name
Subjects[]                # -> subjects (the practice's quick subjects)
PatientSignatureDetail.*  # signature / priority flags — not used
```

`GET Messages/LoadComposeMessageDetail?IsPriorityEnable=false` (verified) — the
compose partial. Its `#ReminderDate` input carries the server-stamped send time
(`MM/DD/YYYY h:mm:00 AM`); it is read at send time and is not bound into the
token. `#ddlToUser` is a single select. The disclaimer the UI requires ticking
is shown in the preview.

`POST Messages/ComposeEmail` — form-urlencoded, one field holding JSON:

```
objToDoNew = JSON {
  TODOMasterId: 0, TaskSubject, TaskMessage,
  IsImportant: "false", IsImportantColor: "",
  ToGroupIds: "<groupId>", ToGroupName: "<group name>",
  _setPatientSignature: false, _setPatientSignaturepath: "",
  ReminderDate: "<from the compose partial>", AttachmentFileName: ""
}
-> { Result: [ { Status } ], validationMessage? }   # success: Result[0].Status > 0
```

**Verified live 2026-10-28** (owner-supervised): one message sent to a practice
group through `insync_send_message`; the portal answered `Result[0].Status > 0`
and the message appeared at the top of the Sent folder
(`GetMessages?messageType=4`). The Sent list shows `ToGroupName` as `Patient`
for patient-sent messages, whatever group they went to.

### Reply — `insync_reply_message`

`POST Messages/GetComposeDetailForReply` — form `Mstparams = JSON {TODOChildId,
TODOMasterId}` → the reply partial (verified, on a read message). Hidden inputs:

```
#todoMasterId / #todoChildId   # the thread ids
#lblReplyToID                  # -> FromGroupId
#ToGroupIds                    # -> ToGroupIds (observed "-1")
#hdnGroupName                  # the replying-to group; EMPTY when that staff member left
                               #   the practice — the UI then disables the reply, and so
                               #   does this server
#emailhistory                  # the quoted thread (attribute-encoded)
#txtSubject                    # prefilled "Re: …"
```

`POST Messages/ReplySendEmail` — form `objReplySent = JSON { TODOMasterId,
TODOChildId, TaskSubject, TaskMessage, History, ToGroupIds, FromGroupId,
_setPatientSignature: false, _setPatientSignaturepath: "", AttachmentFileName:
"" }` → same `Result[0].Status > 0` signal. `History` is the decoded
`#emailhistory` re-escaped with `$('<div>').text(v).html()` (`&`, `<`, `>`). The
reply partial has no `ReminderDate`, so none is sent. An UNREAD message is
refused unless `allow_mark_read` (loading its reply form is unverified on an
unread message).

**Verified live 2026-10-28** (owner-supervised): one reply sent on a read thread
through `insync_reply_message`; the portal answered `Result[0].Status > 0`, and
the thread appeared in Sent with `IsReplied: true`, a new `TODOChildId` and the
reply's date in `ReminderDateText`. The Sent list sorts by the thread's
`CreatedOn`, so a reply on an old thread is NOT at the top — find it with
`searchStr=<subject>`.

### Refill request — `insync_get_refill_options`, `insync_request_refill`

`GET RefillPrescription/RefillPrescription` (verified) — the refill page:

```
select#ddlRefillDrug > option[value]            # -> medications[].medicationId / name
select#ddlSearchPrimaryProvider > option[value] # -> providers[].providerId / name
input#PracticeName                              # -> practice
```

`POST RefillPrescription/SaveRefillRequest` — jQuery's serialization of
`{ refillPrescripationList: [row] }` (sic), form-urlencoded:

```
refillPrescripationList[0][DrugName]        # selected names joined ", "
refillPrescripationList[0][NoOfRefills]
refillPrescripationList[0][ReasonForRefill]
refillPrescripationList[0][PharmacyName]
refillPrescripationList[0][PharmacyAddress]
refillPrescripationList[0][PharmacyPhone]
refillPrescripationList[0][ResourceId]      # the provider option value
refillPrescripationList[0][MedicationIDs]   # selected ids joined ","
```

The portal's success handler reads nothing from the response, so a 2xx is the
only success signal. Verify with `insync_list_refill_requests`.

### Appointment request — `insync_find_appointment_slots`, `insync_request_appointment`

All lookups verified:

```
GET  PatientScheduler                                  # input#PracticeID
POST PatientScheduler/BindFacilities?practiceId=<id>   -> FacilityData[].{FacilityId, FacilityName, IsPrimaryForPatient}
POST PatientScheduler/BindProviders?facilityId&date=MM/DD/YYYY&GenderIds=&LanguageIds=&ServiceOfferedIds=&CredentialIds=
     -> ProviderData[].{ResourceId, ProviderName, IsPrimaryProvider, ScheduleSetupID, ResourceType, DayOfTheWeek, ScheduleID}
POST PatientScheduler/GetSchedulerVisitTypeSlots  JSON {VisitDate, ScheduleSetupID, SpCalledFrom: 1, FacilityId}
     -> lst[].{EncounterTypeID, EncounterType}, IsAppointmentReqPlotVisitTypeMandatory?
POST PatientScheduler/BindSchedulerSlots?providerId=<ScheduleSetupID>&date&currentTime=MM/DD/YYYY hh:mm AM&ResourceId&EncounterTypeID
     -> ScheduleSlots[].{Time, Duration, IsAvailable, ScheduleID}, NextAvailability.NextAvailablityDate
```

Note `providerId` carries the **schedule-setup** id, not the resource id. The
portal defaults to the facility with `IsPrimaryForPatient == 1` and the provider
with `IsPrimaryProvider == 1`; so does this server.

`POST PatientScheduler/SaveAppointmentReq` — JSON (Angular `$http.post`), one
fixed slot (`IsFlexible: false`; the flexible window is not offered):

```
{ FacilityId: "<id>", ResourceId, ScheduleSetupID, ResourceType, IsFlexible: false,
  PrefferedDate: "MM/DD/YYYY", PrefferedTime: "<slot Time>",
  FlexibleDateFrom: "", FlexibleDateTo: "", FlexibleTimeFrom: "", FlexibleTimeTo: "",
  Comments, IsTelemedicineMeeting, VisitTypeID: <id or "">, Duration, ScheduleID }
-> { resultModel: { Status, PPARID, ResponseMsg? }, requestDate }
   # Status 1 = requested (PPARID = request id), 2 = already booked, 4 = ResponseMsg refusal
```

### Cancellation request — `insync_cancel_appointment`

```
GET Appointment/CheckCancelAppointmentRequestTimeDuration?VisitID=<id>   # verified: "0" allowed, "2" period passed
POST Appointment/CancelAppointmentRequest  form {VisitID, caseID}        # verified: the modal partial;
                                                                          #   carries data-visitid / data-pparid
                                                                          #   and the save script below
```

`POST Appointment/SaveCancelAppointmentRequest` — form-urlencoded (`ServerCall`
→ `$.ajax`):

```
VisitID, PPARID (from the upcoming-list row; 0 for a booked visit), Comments (required), caseID: "3"
```

`caseID` only steers the portal's own UI refresh (`3` = the current & future
list). The success handler reads nothing, so a 2xx is the signal. The upcoming
row's `IsNotCancel == 1` is refused before anything is sent. This is a
**request**: the practice reviews it.
