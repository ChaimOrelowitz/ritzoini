# AI Tasks

Tickets for planned work. Move to "Done" when complete.

---

## Open

### OO-004 — Redesign OO Clients main screen as roster + setup health dashboard

**Status:** In progress

**Summary:**
The current Clients screen is a simple alphabetical list grouped by next-appointment DOW. It doesn't surface setup problems, shows no schedule rhythm, and has no quick filters. Redesign it to be a roster / setup-health page: summary stat cards, filter pills, schedule-rhythm-based day grouping, and a compact 2-row client card showing name, age/sex, contact, normal schedule rhythm, next appointment, and status badge.

**Design principle:**
Clients page = roster and setup health.
Call Worklist = weekly work queue.
Sessions = processing/closing notes.

**Changes:**

**`frontend/src/pages/OOClientsPage.js`** (frontend only, no backend changes)
- Add `computeStatus(client, nextAppt)` — derives one of: ready / needs_appt / missing_contact / missing_insync / missing_referral / inactive / problem (2+ issues)
- Add `buildScheduleMaps(apptData)` — computes modal DOW, time, duration per client from all future scheduled appointments (2-pass)
- Add `STATUS_BADGE` constant — color/label per status key
- Add `FILTERS` constant — All / Active / Inactive / No Future Appt / Missing Phone / Missing InSync / Missing Referral / Problems
- Redesign `ClientCard` to 2-row: row 1 = name+age/sex · rhythm · next appt date · status badge; row 2 = contact line + referral badge
- Update `DaySection` — accepts `scheduleMaps`, passes to cards; section title uses plural day name (e.g. "Tuesdays")
- Change grouping: use `scheduleMaps.dayMap[c.id]` (modal DOW from schedule) instead of DOW of next appointment
- "No Schedule / Needs Setup" group at bottom for clients with no future appointments (no modal DOW)
- Summary stat cards: Active / Scheduled / No Future Appt / Missing Phone / Missing InSync / Problems — above filter pills
- Filter pills: pill-shaped buttons, active pill is navy; filter applied over search and archived toggle
- `loadAll`: also calls `buildScheduleMaps` and stores result in state
- Preserved: Add Client modal, InSync credentials panel, sync result banner, import panel, assign-referral panel, archived toggle, search, all existing handlers

**`frontend/build/`** — rebuild

**Out of scope:**
- Preview panel (navigate-to-detail on click is preserved)
- Backend changes
- Changes to OOCallListPage, OOCallsPage, OOClientDetailPage

---

### OO-003 — Client detail page redesign

**Status:** In progress

**DB migration (run in Supabase SQL editor before deploying):**
```sql
ALTER TABLE oo_appointments
  ADD COLUMN session_summary TEXT,
  ADD COLUMN topics_for_upcoming TEXT;
```

**Summary:**
Restructure the OO client detail page for faster pre-session scanning:
header gets address + InSync link; existing client info/treatment plan move into a collapsible section; 3-column body becomes 2-column (Sessions left, Summary right);
"Last Note" replaced by editable "Summary of Previous Appointment" panel (session_summary + topics_for_upcoming on the most recent past appointment).
Also stop pushing additional_comments to InSync.

---

#### Changes

**`backend/routes/ooAppointments.js`**
- Add `session_summary` and `topics_for_upcoming` to `PATCH /:id` allowed list
- Remove `'data[ControlId_37]'` (additional_comments) from `push-note-to-insync` payload

**`frontend/src/pages/OOClientDetailPage.js`**
- Header right column: add address row + "Open in InSync ↗" link (address and InSync link currently buried in right sidebar)
- My Notes textarea stays in header left (320px), unchanged
- Replace 3-column body with:
  - Collapsible "Client Details" strip (default closed): Client Info, Referral Source, Insurance, Treatment Plan, Debug tools, Raw InSync data — all moved from the old right sidebar and middle column
  - 2-column body: Sessions (flex 2) | Summary of Previous Appointment (flex 1)
- Summary panel (replaces "Last Note"):
  - Targets most recent appointment with date ≤ today
  - Two autosave textareas: "Summary of Last Session" (session_summary) and "Topics for Upcoming Session" (topics_for_upcoming)
  - Shows appointment date/time as subtitle
  - Placeholder when no past appointment exists

**`frontend/build/`** — rebuild

---

#### Out of scope
- AI generation of session_summary / topics_for_upcoming (manual only)
- Pushing session_summary / topics_for_upcoming to InSync
- Changes to OOApptCard.js behavior
- Mobile/responsive layout

---

## Done

### OO-002 — Client archive and hard delete

**Status:** Done — commit f3be8c53

**Summary:**  
Add Archive (soft-hide) and Delete (hard cascade) actions to the OO client workflow. Archived clients disappear from the main Clients screen and Calls screen, do not receive Zoom transcript auto-attachment, and can be un-archived via a "Show Archived" toggle on the main screen. Hard delete is permanent and cascades through all related data; the confirmation popup offers Archive as the safer alternative.

---

#### Behavior

**Archive**
- Sets `status = 'archived'` via existing `PUT /:id`
- Hidden from main Clients screen (default) and Calls screen (already filtered to `status='active'`)
- Zoom transcript matching does NOT include archived clients (existing `.eq('status','active')` filter stays as-is)
- Still accessible by navigating directly to `/oo/clients/:id`
- Un-archive button on the detail page restores `status` to `'active'`
- InSync sync must NOT overwrite `'archived'` back to `'active'` — protect in sync loop

**Delete**
- Hard cascade: delete `oo_appointments` for the client, then `zoom_call_transcripts` matched to those appointments (or to the client), then the client row
- Triggered from a confirmation modal that offers **[Archive Instead]** as the primary safe action, alongside **[Delete Permanently]** and Cancel
- No bulk delete

**Show Archived toggle**
- Toggle button in OOClientsPage toolbar
- When on: re-fetches with `?show_archived=true`; archived clients appear greyed out with an "Archived" badge
- Un-archive button available from the detail page (not from the list)

---

#### Backend changes

**`GET /oo/clients`** (`ooClients.js` ~line 68)
- Add `.neq('status', 'archived')` by default
- If `req.query.show_archived === 'true'`, omit the filter (return all statuses)

**`DELETE /:id`** (`ooClients.js` ~line 140)
- Before deleting client: cascade delete `oo_appointments` where `client_id = id`, then `zoom_call_transcripts` where `matched_client_id = id`
- Then delete the client row

**`POST /sync-insync`** (`ooClients.js` ~line 586)
- When fetching existing client for match, also select `status`
- In the update payload, if `existing.status === 'archived'`, omit `status` — don't let InSync overwrite the archived flag

---

#### Frontend changes

**`OOClientsPage.js`**
- Add "Show Archived" toggle button in toolbar header
- When toggled on: re-fetch `?show_archived=true`, archived clients render with grey/muted style and an "Archived" badge
- Edit modal: add `'archived'` option to status dropdown
- Delete button in edit modal footer (left side): opens confirmation modal (see below)

**`OOClientDetailPage.js`**
- Archive button in page header: calls `PUT /:id { status: 'archived' }`, confirm with "Archive [Name]?"
- If client is already archived: show "Archived" banner + Unarchive button (sets status back to `'active'`)
- Delete button in page header: opens same confirmation modal

**Confirmation modal (shared between list + detail)**
- Title: "Delete [First Last]?"
- Body: "This permanently removes all their appointments, notes, and transcripts. Archive instead to hide them without losing data."
- Buttons: [Archive Instead] (sets status='archived', closes modal) | [Cancel] | [Delete Permanently] (red, cascade delete)

---

#### Files to change

| File | What changes |
|---|---|
| `backend/routes/ooClients.js` | GET filter, DELETE cascade, sync status protection |
| `frontend/src/pages/OOClientsPage.js` | Show Archived toggle, archived client styling, delete confirmation modal, 'archived' in status dropdown |
| `frontend/src/pages/OOClientDetailPage.js` | Archive/Unarchive button, Delete button, confirmation modal |
| `frontend/build/` | Rebuild |

No change to `backend/utils/zoomTranscripts.js` — existing `status='active'` filter already excludes archived clients.

---

#### Risks

| Risk | Note |
|---|---|
| InSync sync overwrites archived status | Fixed in sync loop — check existing status before updating |
| FK constraint on cascade delete | Backend must delete child rows in order: appointments → transcripts → client. If `zoom_call_transcripts` has a FK on `matched_appointment_id`, deleting appointments first handles it. |
| Archived client still shows in Calls screen | Calls endpoint already filters `status='active'` — no change needed |
| Show Archived toggle resets on page reload | Acceptable for v1 — state is local |

---

#### Test cases

1. Archive from detail page → client disappears from main screen, navigating to `/oo/clients/:id` still works, "Archived" banner shows.
2. Unarchive from detail page → client reappears on main screen.
3. Show Archived toggle → archived clients appear with grey badge; toggle off → hidden again.
4. Run InSync sync → archived client's status stays `'archived'` after sync.
5. Zoom call comes in for archived client's phone → does NOT auto-attach (stays unmatched).
6. Delete with no appointments → cascade succeeds, client gone.
7. Delete with appointments → cascade deletes appointments first, then client.
8. Confirmation modal: click "Archive Instead" → client is archived, not deleted.
9. Calls screen: archived client does not appear (existing filter, just verify).

---

#### Out of scope

- Bulk archive / bulk delete
- Archiving at the appointment level
- Any change to how `'inactive'` clients are displayed (they still show on main screen)
- Any change to Zoom transcript matching (no code change needed)

---

## Done

### OO-001 — Redesign appointment action buttons + location dropdown + remove email flow

**Status:** Done — commit 2f9ee81a. Location dropdown has one option until ControlId_112 values confirmed.

**Summary:**  
Redesign the OO appointment card action area into a clean 2-row layout, add a location dropdown to the View Note modal with auto-fill logic, wire up the End Encounter button in the UI, and remove the dead "Send to Secretary" email flow.

---

#### Layout

Replace the current button row (which has a broken "Appt Pushed" / "Visit ###" split into two boxes) with:

**Row 1 — 4 equal square buttons:**
| Push Appt | Process Note | View Note | Push Note |

**Row 2 — 1 full-width rounded pill button:**
| End Encounter |

---

#### Per-button behavior

**Push Appt**
- Unpushed: navy square, "Push Appt to InSync" (existing 2-click confirm stays)
- Pushed: single green square `<a>` linking to InSync, showing "✓ Appt Pushed" + "Visit ### ↗"  
  (revert the recent 2-box split back to one clickable box)

**Process Note** — no change

**View Note** — no change to button itself; modal changes below

**Push Note**
- Unpushed: blue square, "Push Note" (existing confirm dialog stays)
- Pushed: single green square `<a>` linking to InSync, showing "✓ Note Pushed" + "Enc ### ↗"
- Remove the standalone "Encounter ### ↗" text link that currently appears below the button row

**End Encounter**
- Disabled (grey pill) until `appt.insync_encounter_id` is set
- Enabled (navy pill): calls `POST /oo/appointments/:id/end-insync-encounter`
- Done: green pill, "✓ Encounter Closed", shows "Encounter ### ↗" link to InSync below/inside, disabled
- On success: auto-sets appointment `status` to `completed` (backend already does this); status field on card becomes an editable `<select>` so user can manually change it

---

#### View Note modal changes

1. **Location of Meeting** — change from read-only `<input>` to `<select>` dropdown  
   - Options: InSync's ControlId_112 values (see blocker below)  
   - Default: "Audio only Telehealth" (value `3`)  
   - On change to "Audio only Telehealth": auto-fill `audio_only_reason` = `"Client does not have internet access."` (only if field is empty or was previously auto-filled)  
   - On change away from "Audio only Telehealth": clear `audio_only_reason` if it still contains the auto-fill text

2. **Remove "Send to Secretary" button** from the modal footer entirely  
   Remove `handleSend`, `sending` state, and the `send-note` API call from the frontend.  
   The `send-note` backend route can stay for now (dead but harmless).

---

#### Backend changes

**`process-note` AI prompt** (`ooAppointments.js` ~line 342)  
- Remove `location_of_meeting` from the fields the AI generates  
- Location is now user-selected in the modal, not inferred from raw notes  
- Remove `audio_only_reason` from AI output too (it's auto-filled by the modal)  
- Update the example JSON output accordingly

**`push-note-to-insync` route** (`ooAppointments.js` line 803)  
- Accept `location_value` (numeric string) and `location_label` (display text) from `req.body`  
- Fall back to `'3'` / `'Audio only Telehealth'` if not provided  
- Pass these into `fillNoteTemplate` instead of hardcoding  
- Also accept `audio_only_reason` from `req.body`; fall back to `appt.ai_fields.audio_only_reason`

**`fillNoteTemplate` function** (`ooAppointments.js` line 61)  
- Accept `locationValue` + `locationLabel` parameters  
- Replace the hardcoded `'3'` / `'Audio only Telehealth'` block (lines 117–120) with the passed values

**Frontend: push note handler**  
When `handlePushNoteToInsync` fires, include in the POST body:
- `location_value` from `fields.location_value` (fallback `'3'`)
- `location_label` from `fields.location_of_meeting` (fallback `'Audio only Telehealth'`)
- `audio_only_reason` from `fields.audio_only_reason`

**Status field on appointment card**  
Change the static status badge to an editable `<select>` (scheduled / completed / cancelled).  
Uses existing `PATCH /oo/appointments/:id` with `{ status }`.

---

#### Files to change

| File | What changes |
|---|---|
| `frontend/src/components/shared/OOApptCard.js` | Button layout, End Encounter handler, modal dropdown, remove Send to Secretary, status select, Push Note body |
| `backend/routes/ooAppointments.js` | `fillNoteTemplate` + `push-note-to-insync` accept location from body; `process-note` prompt update |
| `frontend/build/` | Rebuild after frontend changes |

---

#### Blocker

**InSync ControlId_112 location dropdown values** — need the full `value → label` map.  
Currently only confirmed: `3` → `"Audio only Telehealth"`.  
Until received, the dropdown will have only this one option (which is already the correct default).  
Add remaining options when user provides them; no backend logic changes needed, just extend the `LOCATION_OPTIONS` constant.

---

#### Test cases

1. Full pipeline: Push Appt → Process Note → open View Note modal (verify location dropdown defaults to "Audio only Telehealth" and audio_only_reason is auto-filled) → Push Note → End Encounter → verify status → completed.
2. Change location to non-audio option → push note → verify InSync gets correct ControlId_112 value.
3. Auto-fill: select "Audio only Telehealth" → reason fills; change away → reason clears.
4. Push Note button shows "✓ Note Pushed / Enc ### ↗" after success.
5. End Encounter disabled until note pushed; enabled after; shows link when done.
6. Status select: manually change status after encounter closed; verify PATCH fires.
7. Old appointments with no `location_value` in `ai_fields` → Push Note defaults to Audio only Telehealth without error.
8. "Send to Secretary" button is gone from modal.

---

#### Out of scope

- Fetching InSync location list dynamically
- Zoom transcript ingestion
- Group sessions / pay periods
- The `send-note` backend route (leave as dead code for now)

