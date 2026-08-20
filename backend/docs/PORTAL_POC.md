# Portal POC — peer note transcription into InSync

Peer support workers write session notes in an external CRM
(`portal.linksnetwork.com`). Those finished notes used to be retyped by hand into
the InSync EHR. This screen automates the transcription: it takes the portal's
exported notes and, **logging in as each peer**, creates the InSync encounter,
fills the note with the peer's own words, closes it, and signs it with the peer's
PIN.

This is **transcription of already-authored notes, not generation of clinical
content.** Every clinical value written to InSync comes verbatim from the portal
note. The diagnosis / treatment-plan / visit-code content is assembled by InSync
itself at `GenerateEncounterNote`; this system supplies none of it. These are
billable Medicaid encounters (CPT H0038), so the integrity rule is absolute:
what gets signed must faithfully reflect what the peer wrote.

Route: **`/portalPOC`**. API: **`/api/portal/*`**.

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
review screen  ── Bella fixes every flagged row, then GO
   │
   │ Phase B (per peer, that peer's login)
   │   calendar check → reuse or book → start encounter → note →
   │   generate → close → sign
   ▼
InSync  +  portal_processed_notes (audit) + portal_run_events (log)
```

---

## Nothing is hardcoded

Encounter type IDs, peer provider IDs and client patient IDs are all resolved
live, every run:

- **Encounter types** — `GetVisitTypes` each run, filtered to
  `Peer Support` + `Individual`, matched on three dimensions parsed out of the
  type NAME (language / mode / location) plus offsite-or-not.
- **Peer provider IDs** — parsed live from `ddlPsPrimaryPhysician` in
  `GetAdvancedSearchFields`.
- **Client patient IDs** — `BindPatientList` search, then a one-time human
  confirmation stored in `portal_client_map`.

A new peer, a new client or a new encounter type therefore needs no code change.

### The Offsite dimension

InSync's peer types come in pairs: a base type and an "Offsite" twin. They are
**two different note forms with different InSync TemplateIds** — the Offsite form
adds one field, **"Justification for Offsite Delivery" (ControlId_27)**. The
capture pack therefore stores both note shapes (`note` and `note_offsite`), and
the **selected encounter type** picks which one is replayed. Offsite is detected
from the type *name*, never from an ID list.

**The portal's `isOffsite` flag is deliberately ignored** (`parsePortalNote`
returns `offsite: false` unconditionally). The flag exists in the export, but it
means nothing yet: the portal has no field for the justification text, and the
encounter types actually in use pull the base note form, which has no such
field. Honouring the flag would route notes to an Offsite twin whose required
field could only ever be blank. The flag is still surfaced as
`dimensions.portalIsOffsite` so the reason stays visible.

The offsite **machinery is intact and exercised** whenever the selected type is
an Offsite one: the review screen's dropdown can still pick one, which switches
to the offsite note form and blocks the row until the justification is typed. To
re-enable automatic routing once the portal grows that field, flip the flag in
`parsePortalNote` and map the new portal field onto ControlId_27 in
`portalExecute`'s `NOTE_FIELDS`.

The justification is never inferred from the narrative — several sample notes
bury a rationale inside `activitiesSummary`, and extracting it would be this
system inventing clinical text.

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

### Current status: complete

With `portal_POC/InSync Apointment Note Close Encounter.har` in place, all eight
steps resolve:

| Step | Source | Captured against |
|---|---|---|
| appointment | unified HAR | type 1273 |
| start | unified HAR | — |
| encounter | unified HAR | — |
| close | unified HAR | type 1273 |
| generate | unified HAR | — |
| calendar | unified HAR | — |
| `note` (base form) | `InSync Save Peer Encounter Note.har` | TemplateId 973 |
| `note_offsite` | unified HAR | TemplateId 1028 |

Every write step now comes from **one coherent session** that worked end to end,
rather than being stitched together from partial captures.

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

If it is missing or expired, `/api/portal/status` reports
`admin_insync_configured: false` and the page says so.

---

## Guardrails, and where each one lives

| Guardrail | Enforced by |
|---|---|
| Never hardcode type / peer / client IDs | `utils/portalMatch.js`, `utils/insyncPortal.js` — everything resolves live |
| Dry-run before live | `POST /runs/:id/execute` defaults to `dry_run`; live also requires `confirm: true` and two browser confirmations |
| Billing is right for the type being written | `resolveBilling()` asks InSync per type/patient; `assertBilling()` refuses to send an incomplete or mismatched payload |
| Inspect what would be sent | `GET /runs/:runId/notes/:noteId/payloads` — the exact bodies, with live-resolved billing shown first and the PIN redacted |
| Client-match ambiguity BLOCKS | `resolveRun` never auto-binds; a binding is always an explicit human confirm written to `portal_client_map` |
| Credentials encrypted, never logged | `utils/portalCrypto.js` + `peerView()` + `scrub()` |
| Only portal-authored content is written | `NOTE_FIELDS` maps each control to a named portal field; the two fields with no portal source are typed by the operator, never inferred |
| Respect appointment status | `findExistingAppointment` ignores `VisitStatusID === 4` |
| Stop on unexpected, per note | each step has an explicit success signal; a failure records against that note and moves to the next |
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
4. `node --max-old-space-size=8192 scripts/extract-insync-captures.js`.
5. Add each peer on the Peers tab: portal name, "Look up" their provider ID,
   InSync username, password, signing PIN.
6. Upload an export, work the review screen, **dry run**, read the log.
7. Use "View prepared payloads" on a dry run and check the billing block against
   the encounter type you expect — CPT map, modifier, POS.
8. Run live without signing first, then with signing.

## Tests

`node test/portalPoc.test.js` (35 assertions — the matching rules, the ignored
`isOffsite` flag, the note-form split, the appointment-exists rule, the
credential crypto, the cross-patient contamination guard) and
`node test/portalAccess.test.js` (53 assertions — the `portal_only` fence, and
that it does not leak onto other accounts). Both in `npm test`. No network, no
database.
