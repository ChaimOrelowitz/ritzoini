# Ritzoini

Group-therapy supervision/billing platform (Express + React + Supabase). Two
distinct domains live in the same codebase — see below.

## Stack
- **Backend**: `backend/` — Express, Supabase (Postgres) via service-role key,
  `node server.js` (`npm run dev` for nodemon). No test suite.
- **Frontend**: `frontend/` — CRA React, `npm start` / `npm run build`. Calls
  the backend through `src/utils/api.js`'s `authFetch` (attaches Supabase
  JWT, throws on non-OK). No raw `fetch` calls elsewhere.
- **DB**: Supabase. `backend/db/schema.sql` is **stale** — only defines
  `profiles`/`groups`/`sessions`/`zoom_call_transcripts`. The OO tables
  (`oo_clients`, `oo_appointments`, etc.) exist in production but were never
  added to this file. Don't trust schema.sql as the source of truth — query
  Supabase directly when you need current columns.
- **Deploy**: backend is a Render Web Service (`ritzoini.onrender.com`),
  auto-deploys on push to `main`. Frontend is a Render Static Site that
  serves the already-built `frontend/build/` directly — there's no build
  step on Render's side, so `frontend/build/` is committed to git and must
  be rebuilt (`CI=true npm run build`) and committed alongside any frontend
  source change. See `README.md` for the full setup walkthrough.

## Domain 1: Core (group supervision & billing)
Recurring weekly therapy **groups** (supervisor + instructor + day-of-week)
spawn weekly **sessions**, which auto-complete based on an ECW end-time, get a
SOAP note from the supervisor, then move through
`SCHEDULED → COMPLETED → READY TO LOCK → LOCKED` for payroll. Admins reconcile
locked sessions against **pay periods** for **payments**. `bulkImport.js` /
`billing.js` use Claude to turn free-text or Excel billing sheets into
structured group/schedule data. "Peer Supervision" (`/ps`) is routed but
unbuilt (`ComingSoonPage` stub).

Key files: `routes/{groups,sessions,instructors,payPeriods,payments,bulkImport,billing}.js`,
pages `DashboardPage`, `GroupDetailPage`, `CalendarPage`, `SessionsPage`,
`PaymentsPage`, `InstructorsPage`.

## Domain 2: OO (one-on-one individual therapy)
Separate client/appointment pipeline with an EHR integration and AI note
generation:
- `oo_clients` / `oo_appointments` — individual clients and their scheduled
  sessions (`routes/ooClients.js`, `routes/ooAppointments.js`).
- **InSync EHR push** (`utils/insync.js`, cookie-jar HTTP client reverse-
  engineered from browser traffic — see the `.har` files at repo root). Four
  manual buttons per appointment, in order: **Push to InSync** → **Process
  with AI** (Claude turns `raw_notes` into structured fields via
  `utils/noteGenerator.js`) → **Push Note to InSync** → **End Encounter**.
  None of these auto-run — a human clicks each one.
- **Zoom Phone transcript auto-ingestion** (`routes/zoomWebhooks.js`,
  `utils/zoomTranscripts.js`): every Zoom Phone call's auto-transcript is
  logged via webhook (`phone.recording_transcript_completed`), matched to a
  client by phone number (`oo_clients.phone/mobile/mother_phone/father_phone`),
  and **auto-attached** into that client's nearest-by-date blank
  appointment's `raw_notes` — this is the only automatic step in the
  pipeline; it just replaces manually typing the note before "Process with
  AI". Ambiguous matches land as `unmatched` with `candidate_client_ids`;
  fixable via the Transcripts page's **Retry match** button or manual client
  dropdown (`POST /transcripts/:id/{retry-match,assign-client}`). Reassigning
  a transcript to a different client first detaches it from any previously-
  matched appointment (clears that appointment's `raw_notes`), so a wrong
  auto-match followed by a manual fix doesn't leave the transcript text
  stuck on the wrong client's chart.
  Requires *two* separate Zoom apps: a General App (Event Subscriptions →
  webhook, secret in `ZOOM_WEBHOOK_SECRET_TOKEN`) and a Server-to-Server
  OAuth app (`ZOOM_S2S_ACCOUNT_ID/CLIENT_ID/CLIENT_SECRET`, scope
  `phone:read:recording_transcript:admin`) — phone transcripts need a real
  bearer token, unlike meeting recordings which carry a `download_token` in
  the webhook payload. Zoom returns transcripts as a JSON timeline, not plain
  text — `toPlainTranscript()` converts it to "Speaker: text" lines before
  it's used as `raw_notes`.

Key files: `routes/{ooClients,ooAppointments,zoomWebhooks}.js`,
`utils/{insync,noteGenerator,zoomTranscripts}.js`, pages `OOClientsPage`,
`OOClientDetailPage`, `OOCallsPage`, `OOTranscriptsPage`.

## Conventions
- **Auth**: `middleware/auth.js` — `requireAuth` verifies the Supabase JWT and
  merges the `profiles` row onto `req.user`; `requireAdmin` checks
  `role==='admin'`. Cron endpoints use a shared-secret header
  (`x-cron-secret`) instead, since an external scheduler hits them.
- **Errors**: routes uniformly `try/catch` → `res.status(500).json({ error:
  err.message })`; frontend catches with `alert(ex.message)`.
- **Env vars**: backend uses bare names (`SUPABASE_URL`, `ZOOM_*`,
  `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `CRON_SECRET`...); frontend requires
  CRA's `REACT_APP_` prefix.
- **Email**: real send via Resend (`utils/mailer.js`), gated by a DB-backed
  `email_enabled` toggle (per-user `profiles.email_enabled`, or global via
  `app_settings`) — not the old simulated/SMTP path `services/email.js`
  describes (that file is dead code, nothing requires it).

## Gotchas
- Node doesn't hot-reload — a background `node server.js` keeps running old
  code after an edit. Kill and restart before re-testing.
- `frontend/build/` is committed — regenerate it (`CI=true npm run build`)
  whenever frontend source changes, and commit both together.
- Two `Layout.js` files exist: `components/layout/Layout.js` is the one
  actually imported by `App.js`. `components/shared/Layout.js` is unused
  dead code — don't edit it expecting it to take effect.
- Testing a `requireAuth`-protected route locally without a real password:
  mint a session token via the Supabase admin API without sending any email —
  ```js
  const { data } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
  const { data: v } = await supabase.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: 'magiclink' });
  // v.session.access_token is a real, usable JWT
  ```
