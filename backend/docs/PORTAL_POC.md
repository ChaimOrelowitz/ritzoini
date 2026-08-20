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
`DataBaseValueCollection` mirror, the rendered values inside `DynamicHTML`, every
literal occurrence of the captured patient's ID/name anywhere in the payload, and
any EPIN — then refuses to store a pack that fails its own scrub check.

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

## The payload-diff gate — why it is enforced, not advisory

Every write template above was captured against **encounter type 1273**. Those
payloads carry that type's CPT / modifier / POS / copay scaffolding
(`H0038`, `U4`, CPT-map `418`, POS `99`). Preparing a *different* type swaps the
`VisitTypeID` and leaves the rest — which for a billable Medicaid encounter could
mean billing the wrong thing.

`app.py` handled this by hard-blocking live mode to 1273 only. SPEC softens that
to "other types share the same flow but should be diff-validated once each before
bulk live use." This implements that as a real gate:

- `portal_verified_types` records that a human diffed a type's prepared payloads
  against a real manual capture of the **same** type and accepted them.
- A **live** run refuses any encounter type that is neither the captured type nor
  in that table, naming the offending types.
- A **dry** run is never blocked — a dry run is how you produce the payloads to
  diff in the first place. The review screen shows
  `⚠ not payload-verified — live blocked` on the row and offers
  "Mark this type payload-verified" beside "View prepared payloads".

---

## Guardrails, and where each one lives

| Guardrail | Enforced by |
|---|---|
| Never hardcode type / peer / client IDs | `utils/portalMatch.js`, `utils/insyncPortal.js` — everything resolves live |
| Dry-run before live | `POST /runs/:id/execute` defaults to `dry_run`; live also requires `confirm: true` and two browser confirmations |
| Payload-diff gate before bulk live on a new type | `GET /runs/:runId/notes/:noteId/payloads` gives the exact bodies (PIN redacted); `portal_verified_types` + the live-run check make it a gate rather than a suggestion |
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
7. For the first live encounter of any encounter type other than the captured
   one, use "View prepared payloads", diff against a real manual capture of that
   type, then "Mark this type payload-verified". Live runs refuse until you do.
8. Run live without signing first, then with signing.

## Tests

`node test/portalPoc.test.js` (35 assertions — the matching rules, the ignored
`isOffsite` flag, the note-form split, the appointment-exists rule, the
credential crypto, the cross-patient contamination guard) and
`node test/portalAccess.test.js` (53 assertions — the `portal_only` fence, and
that it does not leak onto other accounts). Both in `npm test`. No network, no
database.
