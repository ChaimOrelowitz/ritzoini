# Portal POC — peer note transcription into InSync

Peer support workers write session notes in an external CRM
(`portal.linksnetwork.com`). Those finished notes used to be retyped by hand into
the InSync EHR. This screen automates the transcription: it takes the portal's
exported notes and, **logging in as each peer**, creates the InSync encounter,
fills the note with the peer's own words, closes it, and signs it with the peer's
PIN.

This is **transcription of already-authored notes, not generation of clinical
content.** The narrative fields are copied from the portal note. The default
value for Peer Support Intervention Details is the peer's own selected
intervention labels, and an operator may edit fields exposed for manual review.
Diagnosis, treatment-plan and visit-code content is assembled by InSync itself
at `GenerateEncounterNote`; this system does not generate it.

In the observed DSC configuration, the Peer Support encounters use CPT H0038.
Payer, CPT mapping, modifiers, place of service, program enrolment and billing
provider are still resolved from InSync for the selected patient and encounter
type; the application does not assume that every patient has the same payer.
Route: **`/portalPOC`**. API: **`/api/portal/*`**.

## For teams rebuilding this inside another CRM

Ritzoini is the working reference implementation, not a required intermediary.
A CRM team can reproduce the integration by calling InSync directly in the same
order and preserving the same identity, billing, duplicate, session-state and
signing safeguards.

Start with:

- `utils/insync.js` — InSync login and request handling.
- `utils/insyncPortal.js` — provider, patient, encounter-type, calendar and billing lookups.
- `utils/portalExecute.js` — appointment, encounter, note, close, sign and co-sign sequence.
- `routes/portalPoc.js` — review state, bindings, dedupe, execution and audit flow.
- `test/portalPoc.test.js` and `test/portalAccess.test.js` — regression coverage.

---

## The two-login architecture

InSync access is role-scoped, which splits the work in half:

| Phase | Login | Does |
|---|---|---|
| **A — Resolution** | the practice **admin** login (`app_settings.insync_username/password`) | READ ONLY. Peer name → provider ID, client name+DOB → patient ID, portal label → VisitTypeID, dedupe. |
| **B — Execution** | **each peer's own** login (`portal_peers`, encrypted) | The only session that sees that peer's calendar, and the only one that can sign as the peer. |

The consequence that shapes the UI: **"does this appointment already exist?"
cannot be answered in Phase A.** The review screen shows `checked on run`, and it
resolves in Phase B against the peer's own calendar.

Peers are processed in batches — log in once as a peer, do all of their notes,
move on. Within a session, notes run **serially**: InSync tracks a current
patient/encounter in session state, so two concurrent requests on one login would
silently misattribute a note.

---

## Flow

```
portal export (notes.json, from the existing Chrome extension)
   │ upload
   ▼
portal_job_runs + portal_staged_notes      ← dedupe on portalNoteId and on the
   │                                          portal's own enteredInInsyncAt
   │ Phase A (admin login, read only)
   ▼
review screen  ── an authorized operator fixes every flagged row, then GO
   │
   │ Phase B (per peer, that peer's login)
   │   calendar check → reuse or book → start encounter → note →
   │   generate → close → sign
   ▼
InSync  +  portal_processed_notes (audit) + portal_run_events (log)
```

---

## Identity and encounter-type resolution

Captured patient, provider and encounter-type IDs are never reused. The sources
of truth are:

- **Encounter types** — retrieved from `GetVisitTypes` during resolution, filtered
  to `Peer Support` + `Individual`, and matched from the type name.
- **Peer providers** — the provider directory is read live from
  `ddlPsPrimaryPhysician` in `GetAdvancedSearchFields`. A human-confirmed
  provider ID is then stored on the peer record and reused until it is changed.
- **Clients** — `BindPatientList` searches InSync using `"Last, First"` and, when
  necessary, the surname. A human-confirmed name+DOB → patient-ID binding is
  stored in `portal_client_map` and reused on later uploads.

Adding a peer or client does not require a code change, but it does require a
confirmed binding. A newly created encounter type is discovered live only if its
name fits the supported Peer Support Individual naming rules and InSync returns
complete billing information for it.

### Standard and Offsite note forms

InSync uses two Peer Support Individual note forms:

| Encounter-type name | Note form | TemplateId | FormTemplateDetailId |
|---|---|---:|---:|
| Does not contain `Offsite` | Standard Peer Support Individual | 973 | 471 |
| Contains `Offsite` | Offsite Peer Support Individual | 1028 | 525 |

The Offsite form adds **Justification for Offsite Delivery** (`ControlId_27`).
The two-form machinery is captured and tested, but **Offsite execution is
currently disabled**: the source export has no dedicated value for that required
field. The portal ignores its `isOffsite` flag, removes Offsite types from the
review choices, and refuses an Offsite row at execution.

Do not infer the justification from narrative text. To enable Offsite later, the
source CRM must supply a dedicated justification field; then map it to
`ControlId_27`, restore the source `isOffsite` value, remove the dropdown filter
in `resolveRun`, and remove the Offsite guard in `executeNote`.

### Peer Support Individual encounter types observed in the supplied HARs

The four captured Offsite types and their base twins are aligned first. A blank
Offsite column means no Offsite twin was observed in the supplied HAR files.
This is capture evidence, not a promise that every listed type is currently active
or has complete billing configuration.

| Non-Offsite type | Offsite twin |
|---|---|
| **1246** — Peer Support - Individual - English - In-person outside the clinic-- [15 mins] | **1271** — Peer Support - Individual - English - In-person outside the clinic - Offsite-- [15 mins] |
| **1253** — Peer Support - Individual - English - In-person at Home-- [15 mins] | **1272** — Peer Support - Individual - English - In-person at Home Offsite-- [15 mins] |
| **1252** — Peer Support - Individual - Language other than English -In-person outside the clinic-- [15 mins] | **1273** — Peer Support - Individual - Language other than English -In-person outside the clinic Offsite-- [15 mins] |
| **1254** — Peer Support - Individual - Language other than English - In-person Home-- [15 mins] | **1274** — Peer Support - Individual - Language other than English - In-person at Home Offsite-- [15 mins] |
| **1194** — Peer Support - Individual - 15min-- [15 mins] | — |
| **1199** — Peer Support - Individual - 1hr-- [60 mins] | — |
| **1200** — Peer Support - Individual - 2hr-- [120 mins] | — |
| **1201** — Peer Support - Individual - 3hr-- [180 mins] | — |
| **1205** — Peer Support - Individual - 30min-- [30 mins] | — |
| **1206** — Peer Support - Individual - 45min-- [45 mins] | — |
| **1207** — Peer Support - Individual - 1hr 15min-- [75 mins] | — |
| **1208** — Peer Support - Individual - 1hr 30min-- [90 mins] | — |
| **1209** — Peer Support - Individual - 1hr 45min-- [105 mins] | — |
| **1210** — Peer Support - Individual - 2hr 15min-- [135 mins] | — |
| **1211** — Peer Support - Individual - 2hr 30min-- [150 mins] | — |
| **1212** — Peer Support - Individual - 2hr 45min-- [165 mins] | — |
| **1241** — Peer Support - Individual - English - In the clinic-- [15 mins] | — |
| **1242** — Peer Support - Individual - English - Telehealth with video and audio when the client is home-- [15 mins] | — |
| **1243** — Peer Support - Individual - English - Telehealth audio only when the client is home-- [15 mins] | — |
| **1244** — Peer Support - Individual - English - Telehealth with video when the client is not home-- [15 mins] | — |
| **1245** — Peer Support - Individual - English - Telehealth audio only when the client is not home-- [15 mins] | — |
| **1247** — Peer Support - Individual - Language other than English - In the clinic-- [15 mins] | — |
| **1248** — Peer Support - Individual - Language other than English - Telehealth video & audio when client is home-- [15 mins] | — |
| **1249** — Peer Support - Individual - Language other than English -Telehealth audio only when client is home-- [15 mins] | — |
| **1250** — Peer Support; Individual - Language other than English -Telehealth video when client is not home-- [15 mins] | — |
| **1251** — Peer Support - Individual - Language other than English -Telehealth audio when client is not home-- [15 mins] | — |

---

---

## Data model

Created by `db/portal_poc.sql`. Every table has RLS on with **no policies**, so
the browser's anon/authed keys can read none of it; only the backend's
service-role key touches these rows, and it is fenced by `middleware/auth.js`.

| Table | Holds |
|---|---|
| `portal_peers` | peer → InSync provider ID, plus the peer's encrypted InSync password and signing PIN |
| `portal_client_map` | the one-time confirmed portal-client → InSync-patient binding |
| `portal_job_runs` | one row per upload |
| `portal_staged_notes` | the portal note verbatim + Phase A resolution + flags; what the review screen renders |
| `portal_processed_notes` | dedupe ledger and audit trail, keyed by the portal note UUID |
| `portal_run_events` | per-step activity log |
| `portal_capture_templates` | the scrubbed HAR-derived request shapes the write chain replays |

`profiles.portal_only` is the access flag (see below).

---

## Credential security

`portal_peers` holds several peers' real InSync passwords and signing PINs — the
highest-risk data in this repo.

- Encrypted with **AES-256-GCM** (`utils/portalCrypto.js`) under
  `PORTAL_CRED_KEY`, which lives in the **Render environment, not in Supabase**.
  A leak of the database alone yields ciphertext; a leak of the env alone yields
  nothing to decrypt.
- Ciphertext **never leaves the backend** — the peers API returns
  `has_password` / `has_pin` booleans, never the values.
- Plaintext opens one InSync session and is then dropped. It is never logged,
  never put in an error message, and never written to `portal_run_events`;
  `portalCrypto.scrub()` is applied to execution errors as a second line.

Generate the key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> Supabase Vault would be preferable to app-level encryption and is worth moving
> to. It needs DB-side access this codebase does not currently have — every other
> secret here (Zoho, Zoom, Airtable, InSync admin) already lives in the app
> environment or `app_settings`, so this follows the existing trust boundary.

---

## The capture pack

`app.py` reads its six request templates straight out of `.har` files at runtime.
Those files carry live session cookies and a real patient's chart, so they are
neither committed nor deployed. `scripts/extract-insync-captures.js` does the
equivalent once, on a trusted machine:

```bash
node --max-old-space-size=8192 scripts/extract-insync-captures.js         # writes
node --max-old-space-size=8192 scripts/extract-insync-captures.js --dry   # shows only
node --max-old-space-size=8192 scripts/extract-insync-captures.js <dir> … # elsewhere
```

With no arguments it scans the repo root and `portal_POC/`. The heap flag is not
optional — the unified capture is 86MB of JSON.

It picks, per step, the capture from the HAR that covers the **most** of the
chain, preferring one whose payload names a peer-support encounter type. That
matters: the standalone scheduler HAR books a completely different service, and
its CPT / POS / copay scaffolding is wrong for a peer encounter. The two note
forms are split by reading the payload for `ControlId_27` rather than by
guessing from a filename.

It pulls the POST parameter shapes, **scrubs** every answer-bearing ControlId,
the identity controls (12 = patient name, 13 = provider name), the
`DataBaseValueCollection` mirror, the rendered values inside `DynamicHTML`, the
captured clinician's display name, every literal occurrence of the captured
patient's ID/name anywhere in the payload, and any EPIN — then refuses to store a
pack that fails its own scrub check.

Three things the scrub gets wrong if you rewrite it:

- **`DynamicHTML` arrives entity-escaped.** Element patterns must run against the
  unescaped string and the result re-escaped, or the scrub silently matches
  nothing and every answer in the rendered form survives.
- **`StartEncounter` uses short field names** (`sPatientID`, not `PatientId`), so
  identity matching has to be a suffix rule, not a list of exact names.
- **The interventions multi-select renders into a bare `<label>` with no `id`,**
  between the two `hdnField*_20` hidden inputs. There is nothing to target it by
  except that structure.

Each of those let real data through when first written, so `assertClean` now
looks *inside* the rendered blob rather than only at the parameters, and there
are regression tests for the first two.

### Current capture inventory

The extractor recognizes nine endpoint shapes; the note endpoint is split into
standard and Offsite variants, producing ten stored template roles:

| Role | Purpose |
|---|---|
| `appointment` | Save a new appointment |
| `start` | Start the selected appointment |
| `encounter` | Create/open the encounter |
| `note` | Save the standard form (TemplateId 973) |
| `note_offsite` | Save the Offsite form (TemplateId 1028) |
| `generate` | Ask InSync to assemble the chart-derived note sections |
| `close` | Close and optionally sign |
| `calendar` | Read the peer's calendar |
| `visittypes` | Retrieve the encounter-type catalog |
| `schedulercalendar` | Retrieve patient/scheduler billing context |

The standard note form was captured in `InSync Save Peer Encounter Note.har`.
The unified HAR supplied the shared write chain and the Offsite form. Therefore,
the pack is deliberately assembled from compatible captures; it did not all come
from one session.

---

---

## Per-type billing — resolved live, never replayed

The captured payloads came from one session against encounter type **1273**, and
carried that type's billing mapping hardcoded in **eighteen** places across three
steps: CPT map `418`, modifier `338` (U4), POS `99`, plus the captured *patient's*
program enrolment `6519` / `18`.

That mapping is per type, and wrong for any other:

| Type | CPT map | Modifier | POS |
|---|---|---|---|
| 1246 English – outside the clinic | 394 | — | 99 |
| 1252 Lang-other – outside the clinic | 400 | 338 | 99 |
| **1253 English – In-person at Home** | **401** | **—** | **12** |
| 1273 Lang-other – outside clinic Offsite | 418 | 338 | 99 |
| 1241 English – In the clinic | — | — | 11 |

A typical upload is dominated by 1253, so replaying the capture would bill POS 99
instead of 12 and attach a "language other than English" modifier to English
encounters. So none of it is taken from the capture. `resolveBilling()` in
[utils/insyncPortal.js](../utils/insyncPortal.js) asks InSync, per run:

- **CPT / modifiers / units / map id** — `POST /Scheduler/GetSchedulerCalendar`,
  read from `AdditionalDetails.lstCPT` (keyed by `EncounterTypeID`, covering every
  peer type). The same call the browser makes to fill the booking form's CPT grid.
- **Place of service** — `POST /EncounterDetail/GetPosCodeByEncSpaceFacilityId`
  with a JSON body `{EncounterTypeId:'<id>', VisitId:'null'}`.
- **Program enrolment** — `POST /ProgramManagement/ProgramManagementSearch`, per
  patient. Every patient has their own (5996, 5309, 3604 for the first three
  checked). More than one enrolment blocks the note: which program an encounter
  belongs to is a human decision.

The extractor blanks all eighteen fields, so a regression fails loudly rather
than quietly billing the captured type's numbers.

InSync remains the source of truth, but `SaveBookAppointment` still expects the
populated booking model back: after the dialog resolves CPT, modifiers, units,
map id and POS, the final appointment request posts those returned values just
as InSync's browser does. Omitting them leaves an empty CPT/POS model and InSync
silently answers `DataSave=false`.

### Three things the rewrite has to get right

- **`SEEncounterDetails_SECPTCode` uses an underscore.** `keyMatches()` normalises
  `[ ]` to dots and matches the last dot-segment, so that key is a *single*
  segment and `setFields(…, 'SECPTCode')` can never reach it. It is assigned
  directly.
- **Three fields are composites**, rebuilt rather than substituted:
  - `SECPTCode` = `<CPT>#*#&*&<mapId>`
  - `SECPTModifiers` = `<CPT>#*#&*&<mapId>,<M1>,<M2>,<M3>,<M4>,<Units>,&*%^1,&*%^1`
  - `SECPTDescription` = `<CPT>#*#&*&<mapId> -  <description>`
- **`assertBilling()` runs before anything is sent.** It refuses a payload whose
  billing is incomplete (a blank CPT map id would otherwise sail through, because
  blank matches blank), whose written values disagree with what InSync returned,
  or in which the captured encounter type still appears.

`portal_verified_types` survives as audit history of the old manual gate; nothing
reads it to decide anything.


---

## The appointment check — and notes already entered by hand

Before writing anything, the run opens **the peer's own InSync calendar** for that
client, date and minute. Reuse an untouched appointment; if the session has
already been worked, write nothing.

### Getting the right calendar

`LoadCalendarView` filters on `selectedSchedulers` (a **ScheduleSetupID**), not on
provider id. The captured request pins it to the captured user's schedule and its
`fromDate`/`toDate` to the week it was recorded, so replaying it asks about
somebody else's calendar in a past week — regardless of whose session runs it.
Everything that decides *whose* calendar and *which* day is therefore set
explicitly, and the schedule id is resolved rather than assumed:

1. try the id cached on `portal_peers.insync_schedule_setup_id`
2. then try the session default (blank `selectedSchedulers`)
3. then look the peer up in the scheduler directory — **`Item6`** of the response
   maps `ScheduleSetupID` ↔ `ResourceId` — and pin that

Each attempt is **verified** against `Item1`, which names the schedule actually
being shown. If none can be confirmed as the peer's, the note is **blocked**: a
wrong "no appointment here" is precisely what books a duplicate, so silence is
never read as absence. The captured id is never a fallback.

> Observed in practice: the blank-filter attempt did **not** return the owner's
> own calendar even on their own session, so the directory lookup is the branch
> that actually fires. The activity log names which one was used.

### What the match means

An encounter id can exist while the encounter is still **open**, so "an encounter
exists" must not be read as "the note was already entered":

| Calendar row | Disposition | Effect |
|---|---|---|
| `VisitStatusID === 4` | cancelled | ignored |
| no `EncounterId` | `reusable` | reuse that `VisitID` |
| `EncounterId` + clearly closed | `already_closed` | row → **duplicate**, nothing written |
| `EncounterId`, not clearly closed | `needs_review` | row **held**, nothing written |

**"Clearly closed"** needs a positive completion signal, not merely a non-Pending
status: `EncounterClosedByName` present (it reads "Closed By: … On …"), **or**
`EncounterStatus === '3'` together with `ChargeStatus === 1`. Real closed rows
carry `VisitStatusID = 1` ("Check In"), which is why excluding only status 4 was
not enough — those rows used to be reused.

A `needs_review` hold is stored on the row (`resolution.calendar_hold`) because
resolution runs on the admin session and cannot re-derive it; without that, a
re-resolve would quietly mark the row Ready again. "Reviewed — clear hold" on the
review screen removes it, and the next run re-checks the calendar anyway.

**Dry run signs in too**, read-only, purely so it can do this check. That is what
makes "already entered by hand" visible *before* a live run rather than during
one. It sends nothing.

---

## The intervention-details field

`ControlId_7` ("Peer Support Intervention Details") has no counterpart in the
portal export. The standing convention is to repeat the selected interventions
into it, so it is prefilled with the same labels sent to the `ControlId_20`
multi-select — the peer's own selection copied into a second field, not prose the
app composed. It stays editable, and an operator entry wins.

---

## Closing an encounter — the part that is not the payload

`SaveEndEncounter` cannot be posted cold. On its own it returns
`EPINCorrect: true`, `SignatureExist: true` — and silently keeps whatever times
the encounter already had. The payload is not the difference: a working manual
close and ours were byte-identical on every time field.

InSync reads the encounter out of **session state**, which the close screen and
its validations establish. So the close runs the same sequence the browser does:

```
GET  /ENDEncounter/ENDEncounter?eid=&pid=&tpelemname=…
POST /EncounterNote/EncounterNote?pid=&eid=
POST /ENDEncounter/GetEndEncounterDuration
POST /EncounterDetail/GetEncounterDurationAlert    StartTime / EndTime
POST /EndEncounter/ValidateEndEncounterTime        EndEncounterDateTime
POST /EndEncounter/ValidateDurationForCPT          StartTime / EndTime
POST /ENDEncounter/SaveEndEncounter
```

This is the same statefulness warning that forces serial execution, applied to
the close: the ids in the payload are not enough on their own.

### Billable units are the encounter window

Not the appointment's slot length, and not a units field. `ValidateDurationForCPT`
and the program alert are both passed StartTime and EndTime, and the span is what
gets billed — a 180-minute session on a per-15-minute code is 12 units.
`EncounterStartDate` carries a **padded** hour and `EncounterEndDate` does not
(`08/20/2026 09:00 AM` → `08/20/2026 12:00 PM`); both captures agree, so the
asymmetry is copied rather than tidied.

### The co-sign is read, never configured

A peer's note needs their supervisor's signature, and InSync does **not** attach
it unless the close asks. The close screen carries the wiring:

```
hdnCoSignIDs               "97,"     -> CoSignID
hdnEndCosignProvider_97    "2421"    -> CoSignPhysicianIDs (the supervisor)
hdnCosignRequestOption_97  "1"       -> CosignTypeID
hdnCosignSR_97             "1"       -> SR
```

`loadCloseScreen()` parses those and `applyCosign()` puts them in the payload, so
the supervisor follows whatever InSync already knows for that peer and no
clinician is ever named in code.

**Required final state:** after the peer signs and closes the encounter, the note
must appear in InSync as **waiting for the configured supervisor's co-sign**. A
run is not operationally complete merely because the peer signature succeeded;
the co-sign request returned by the close screen must be included in
`SaveEndEncounter` and verified in InSync during acceptance testing.

### Correcting an encounter that is already closed

Reopen on the **admin** session, then close on the **peer's**:

```
POST /CoSignEncounterList/EditEncounter
     PatientId, EncounterId, txtReasonToReopen   (the reason is double-encoded)
```

then the close sequence above as the peer. `scripts/portal-redo-note.js
<encounter_id> --apply` clears the dedupe ledger and resets the staged row so the
note can be sent again.
---

## Offsite is switched off

The portal has no field for the "Justification for Offsite Delivery" that an
Offsite type's note template requires, so an Offsite encounter could only ever be
signed with that field blank. Automatic routing already ignores the portal's
`isOffsite` flag; on top of that, Offsite types are **filtered out of the review
dropdown** and **refused at execution**.

The two-template machinery (`note` / `note_offsite`, `noteStepFor`,
`templatesFor`, the `ControlId_27` handling) is untouched and still tested. This
is a policy switch: re-enabling means deleting the dropdown filter in
`resolveRun` and the guard at the top of `executeNote`, then pointing
`parsePortalNote` back at `note.isOffsite`.

---

## Admin InSync login

Phase A resolution runs under the practice-wide InSync login stored in
`app_settings.insync_username` / `insync_password` — the same one the One-On-One
and Co-Sign sections use, set from either of those screens. It is deliberately
**not** duplicated onto this screen: a `portal_only` account uses it but cannot
see or change it, and changing it here would silently alter what the other two
domains run under.

`/api/portal/status` reports whether both admin credential values are configured.
It does not perform a live login test; invalid or expired credentials are discovered
when a resolution request attempts to sign in.

---

## Guardrails, and where each one lives

| Guardrail | Enforced by |
|---|---|
| Never hardcode type / peer / client IDs | `utils/portalMatch.js`, `utils/insyncPortal.js` — everything resolves live |
| Dry run before live | Dry run is available and strongly recommended, but not enforced as a prerequisite. Live requires `confirm: true`; the UI shows one confirmation for unsigned live runs and a second confirmation when signing is enabled. |
| Billing is right for the type being written | `resolveBilling()` asks InSync per type/patient; `assertBilling()` refuses to send an incomplete or mismatched payload |
| Inspect what would be sent | `GET /runs/:runId/notes/:noteId/payloads` — the exact bodies, with live-resolved billing shown first and the PIN redacted |
| Client-match ambiguity BLOCKS | `resolveRun` never auto-binds; a binding is always an explicit human confirm written to `portal_client_map` |
| Credentials encrypted, never logged | `utils/portalCrypto.js` + `peerView()` + `scrub()` |
| Control every clinical field | `NOTE_FIELDS` maps narrative controls to portal fields. Intervention Details defaults to the peer's selected intervention labels; exposed manual fields may be edited by an operator; diagnosis/plan/visit-code sections are assembled by InSync. |
| Respect appointment status | `findExistingAppointment` ignores `VisitStatusID === 4` |
| Stop on unexpected, per note | Critical writes require their expected success result; HTTP/session failures and recognized InSync restrictions stop that note and are recorded before processing continues. |
| No cross-patient contamination | every answer control is blanked before the current note is written in — tested |

---

## Access: the `portal_only` account

`profiles.portal_only = true` restricts an account to this one screen. It is the
same shape as `ps_payroll_only`:

- **API** — `middleware/auth.js` `requireAuth` is the single chokepoint. A
  `portal_only` account may reach `/api/portal/*` and `GET /api/users/me`, and
  nothing else. Unlike the payroll fence this one allows writes, because
  transcribing a note *is* the job — it is the surface that is restricted, not
  the verbs.
- **UI** — `Layout.js` redirects any other path to `/portalPOC`, hides the
  section switcher and renders a single nav item. `App.js`'s `PrivateRoute`
  guards the route itself.
- It **overrides `role`**, so the account stays a plain `supervisor`.

Set it from Users → Edit → "Portal POC only", or:

```bash
node scripts/create-portal-user.js bella@example.com Bella Lastname
node scripts/create-portal-user.js bella@example.com --revoke
```

Admins also see the screen (a fourth "Portal POC" section tab).

---

## Setup checklist

1. Run `db/portal_poc.sql` in the Supabase SQL editor.
2. Set `PORTAL_CRED_KEY` in the backend environment.
3. Confirm `app_settings.insync_username` / `insync_password` hold the admin login.
4. Run `node --max-old-space-size=8192 scripts/extract-insync-captures.js` on a trusted machine.
5. Add each peer: portal name, confirmed provider ID, InSync username, password and signing PIN.
6. Upload a test export, resolve every flagged row, run a dry run and inspect the log.
7. Inspect prepared payloads and confirm the selected type, patient, provider, payer, CPT map, modifier, POS and program.
8. Run one dedicated test note live with signing enabled, then verify the saved appointment, encounter, note, units and co-sign route in InSync.
9. Do not use the same note for an unsigned test followed by a signed test: the first close makes the later attempt a duplicate. Use separate test notes, or follow the documented reopen procedure.

## Tests

`node test/portalPoc.test.js` (59 assertions — the matching rules, the ignored
`isOffsite` flag, the note-form split, the appointment-exists rule, the
credential crypto, the cross-patient contamination guard) and
`node test/portalAccess.test.js` (53 assertions — the `portal_only` fence, and
that it does not leak onto other accounts). Both in `npm test`. No network, no
database.
