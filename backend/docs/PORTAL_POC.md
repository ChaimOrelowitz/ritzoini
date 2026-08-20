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

InSync's peer types come in pairs: a base type and an "Offsite" twin whose note
template carries one extra field, **"Justification for Offsite Delivery"
(ControlId_27)**. The selected type determines the template shape — offsite is
detected from the *name*, never from an ID list.

The portal export **does** carry an `isOffsite` boolean (the original spec said
it did not; the current export shape has it, and two of the three sample notes
set it to `true`). So offsite routing is live, not dormant.

**But the portal has no field for the justification text itself.** That field is
therefore typed by the operator on the review screen and blocks the row until it
is filled. It is deliberately *not* inferred from the narrative — several sample
notes bury a rationale inside `activitiesSummary`, and extracting it would be
this system inventing clinical text.

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
node scripts/extract-insync-captures.js "/path/to/har/dir"        # writes
node scripts/extract-insync-captures.js "/path/to/har/dir" --dry  # shows only
```

It pulls the POST parameter shapes, **scrubs** every answer-bearing ControlId,
the identity controls (12 = patient name, 13 = provider name), the
`DataBaseValueCollection` mirror, the rendered values inside `DynamicHTML`, every
literal occurrence of the captured patient's ID/name anywhere in the payload, and
any EPIN — then refuses to store a pack that fails its own scrub check.

### Current status: two captures are missing

From the HARs in this repo the extractor recovers **appointment, note, generate,
close, calendar**. It does **not** find:

- `/Scheduler/StartEncounter`
- `/EncounterDetail/AddEditStartEncounter`

Those live in the POC's own unified capture
(`InSync Apointment Note Close Encounter.har`), which is not in this repo. Until
they are supplied, **dry runs work end to end and live execution is blocked** with
a message naming the missing steps. Drop that HAR beside the others and re-run
the extractor — no code change needed.

One more capture gap worth knowing: the note capture in this repo is from a
**non-offsite** template, so it has no `ControlId_27`. Preparing an offsite note
against it fails loudly ("The stored note template has no ControlId_27…") rather
than silently dropping the justification. An offsite note-save capture is needed
before any offsite type can go live.

---

## Guardrails, and where each one lives

| Guardrail | Enforced by |
|---|---|
| Never hardcode type / peer / client IDs | `utils/portalMatch.js`, `utils/insyncPortal.js` — everything resolves live |
| Dry-run before live | `POST /runs/:id/execute` defaults to `dry_run`; live also requires `confirm: true` and two browser confirmations |
| Payload-diff gate before bulk live on a new type | `GET /runs/:runId/notes/:noteId/payloads` — the exact bodies that would be sent, with the PIN redacted |
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
4. `node scripts/extract-insync-captures.js "<har-dir>"`.
5. Add each peer on the Peers tab: portal name, "Look up" their provider ID,
   InSync username, password, signing PIN.
6. Upload an export, work the review screen, **dry run**, read the log.
7. For the first live encounter of any encounter type, use "View prepared
   payloads" and diff against a real manual capture of that type before running
   that type in bulk.
8. Run live without signing first, then with signing.

## Tests

`node test/portalPoc.test.js` (also in `npm test`) — 33 assertions over the
matching rules, the offsite branch, the appointment-exists rule, the credential
crypto and the cross-patient contamination guard. No network, no database.
