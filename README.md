# 🚀 Ritzoini Platform — Setup Guide

This guide walks you (or a developer) through getting the platform running from scratch.
Estimated time: **30–45 minutes** for someone technical, longer if brand new.

---

## What You're Setting Up

| Part | Technology | Where It Lives |
|------|-----------|----------------|
| Frontend (the website) | React | Static site on Render, served from the committed `frontend/build/` |
| Backend (the API) | Node.js + Express | Render (Web Service) |
| Database + Auth | PostgreSQL via Supabase | Supabase (free) |

---

## Step 1 — Create a Supabase Project (Database + Auth)

1. Go to **https://supabase.com** and sign up for free
2. Click **New Project**, give it a name like `ritzoini`
3. Set a strong database password and save it somewhere safe
4. Wait ~2 minutes for the project to be created

### Set Up the Database

1. In your Supabase project, click **SQL Editor** in the left sidebar
2. Click **New Query**
3. Copy the entire contents of `backend/db/schema.sql` and paste it in
4. Click **Run** (green button)
5. You should see "Success" — your tables are created!

### Get Your API Keys

1. Go to **Settings → API** in Supabase
2. Copy these values — you'll need them later:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **anon public** key
   - **service_role secret** key (keep this private!)

### Create Your First Admin User

1. Go to **Authentication → Users** in Supabase
2. Click **Invite user** → enter your email
3. Accept the invite email and set your password
4. Now go back to **SQL Editor** and run this (replace the email):
   ```sql
   UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com';
   ```

---

## Step 2 — Run the Backend Locally (or Deploy)

### Option A: Run Locally

```bash
cd backend
cp .env.example .env
# Edit .env with your Supabase values
npm install
npm run dev
```

Your API will be running at `http://localhost:4000`

### Option B: Deploy to Render (current production host)

1. Go to **https://render.com** and sign up
2. Click **New → Web Service**, connect this GitHub repo, set the root
   directory to `backend`
3. Build command: `npm install` · Start command: `npm start`
4. Add your env vars in Render's dashboard (see `backend/.env.example` for
   the full list — Supabase keys, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
   `CRON_SECRET`, `ZOOM_*`, etc.)
5. Render gives you a public URL like `https://ritzoini.onrender.com`, and
   auto-deploys on every push to `main`

---

## Step 3 — Run the Frontend Locally (or Deploy)

### Option A: Run Locally

```bash
cd frontend
cp .env.example .env
# Edit .env with your Supabase values + API URL
npm install
npm start
```

Your app will open at `http://localhost:3000`

### Option B: Deploy to Render (current production host)

The production frontend is a Render **Static Site** that serves the
already-built `frontend/build/` folder directly — there's no build step on
Render's side, which is why `frontend/build/` is committed to git instead of
gitignored.

1. Build and commit before pushing:
   ```bash
   cd frontend
   CI=true npm run build
   git add build && git commit -m "Rebuild frontend"
   ```
2. In Render: **New → Static Site**, connect this repo, root directory
   `frontend`, publish directory `build`, no build command
3. Render auto-redeploys (re-serves the new `build/`) on every push to `main`

---

## Step 4 — Invite Supervisors

Once you're logged in as an admin:

1. Click **Users** in the left sidebar
2. Enter the supervisor's name and email
3. Click **Send Invitation**
4. They'll receive an email with a link to set their password
5. Go back to **Dashboard** and create a group — you can assign them as supervisor right away

---

## How the Session Workflow Works

```
SCHEDULED → (supervisor submits notes) → COMPLETED + email sent → READY TO LOCK → LOCKED
         ↘
          CANCELLED (if session didn't happen)
```

- **Scheduled**: Default state for all sessions
- **Submit Notes**: Supervisor writes what happened; email is sent to the notification address
- **Ready to Lock**: After notes are submitted, the session can be locked
- **Locked**: Permanent record — cannot be edited

---

## File Structure

```
ritzoini/
├── backend/
│   ├── db/
│   │   ├── schema.sql          ← Partial — predates the OO/Zoom tables, see CLAUDE.md
│   │   └── supabase.js         ← DB client
│   ├── middleware/
│   │   └── auth.js             ← JWT verification (requireAuth / requireAdmin)
│   ├── routes/
│   │   ├── groups.js           ← Group endpoints (core domain)
│   │   ├── sessions.js         ← Session endpoints (core domain)
│   │   ├── users.js            ← User/invite endpoints
│   │   ├── instructors.js, payPeriods.js, payments.js, billing.js, bulkImport.js
│   │   ├── cron.js             ← Secret-header-gated auto-complete cron
│   │   ├── ooClients.js, ooAppointments.js   ← OO (one-on-one) domain
│   │   └── zoomWebhooks.js     ← Zoom Phone transcript webhook + OO domain
│   ├── utils/
│   │   ├── insync.js           ← InSync EHR client
│   │   ├── mailer.js           ← Resend-based email (see "Email" below)
│   │   ├── noteGenerator.js    ← Claude session-note generation
│   │   └── zoomTranscripts.js  ← Zoom Phone transcript matching/auth
│   ├── .env.example            ← Copy to .env and fill in
│   ├── package.json
│   └── server.js               ← Entry point
│
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── admin/          ← CreateGroupModal, EditGroupModal, BulkImportModal
    │   │   ├── supervisor/     ← SubmitNotesModal
    │   │   ├── shared/         ← EditSessionModal, OOApptCard (OO domain)
    │   │   └── layout/         ← Layout.js (the one actually used by App.js)
    │   ├── context/
    │   │   └── AuthContext.js  ← Login state
    │   ├── pages/
    │   │   ├── LoginPage.js, DashboardPage.js, GroupDetailPage.js, CalendarPage.js,
    │   │   │   SessionsPage.js, AdminUsersPage.js, InstructorsPage.js, PaymentsPage.js
    │   │   └── OOClientsPage.js, OOClientDetailPage.js, OOCallsPage.js,
    │   │       OOTranscriptsPage.js   ← OO domain
    │   ├── utils/
    │   │   └── api.js          ← All API calls (authFetch wrapper)
    │   ├── App.js
    │   └── index.css           ← All styles
    ├── build/                  ← Committed — see "Deploy to Render" above
    ├── .env.example
    └── package.json
```

See `CLAUDE.md` for the full breakdown of the two domains (core
group-supervision vs. OO one-on-one) and how the OO ↔ InSync ↔ Zoom pipeline
fits together.

---

## Email

Real email already goes out via **Resend** (`utils/mailer.js`), not the old
SMTP/simulated path. Set `RESEND_API_KEY`, `FROM_EMAIL`, and `TO_EMAIL` in
your `.env`. Sending can be toggled off per-user (`profiles.email_enabled`)
or globally via the DB-backed `app_settings`/`app_config` toggle without a
redeploy.

---

## Private iPhone Contacts & "Message DSC"

Two read-only surfaces that put the peer-supervision caseload on a phone: a
**CardDAV** server that syncs `DSC Peers` and `Ritzoini Instructors` into
iPhone Contacts, and an authenticated recipient feed for a **Message DSC**
Apple Shortcut that opens a separate native Messages conversation per peer (no
Twilio, no group chat). Both require their own credentials, refuse every write,
and fail closed when unconfigured.

Setup, the exact iPhone account fields, and the step-by-step Shortcut build are
in **[`backend/docs/PRIVATE_CONTACTS.md`](backend/docs/PRIVATE_CONTACTS.md)**.
Generate the credentials with `node backend/scripts/make-contact-credentials.js`.

---

## Payments 2.0

A paydays-first view of what you've been paid and what you're still owed, at
**Payments 2.0** in the Ritzoini menu (owner only). It sits alongside the
original Payments page, which is unchanged.

**Why paydays, not pay periods.** The office pays a session only once it's
billed, signed and locked in eCW by the Tuesday before a payday, so about half
of all sessions land on a payday whose printed pay period doesn't contain the
session date. Every payday has two documents that arrive separately, in either
order: the RTG pay stub (Pay Date, Gross) and the billing office's session list.
A payday is **complete** when the list × rate equals the stub's gross.

**Setup (once).** Run `backend/db/migrations/2026-11-25_payments2.sql` in the
Supabase SQL editor. It adds `pay_rates` (seeded with $50 before 2026-06-09,
$55 from then), `paydays`, `payday_items`, `group_aliases`, and a private
`payments` storage bucket. Nothing existing is changed.

**Importing.** Click **+ Add stubs or lists** and drop files (a whole folder
works for the backfill), or paste a list. Accepted: stub PDFs, `.eml` emails
(list in the body or attached), `.xlsx` and `.pdf` lists. Parsing is
text-first; Claude reads a PDF only when its text yields nothing. Each list is
placed on a payday by, in order: a date inside the file (a stub's Pay Date or
a "Check date" line), then the email subject's date, then the email's sent
date. Those last two only count when the list total matches a waiting stub;
otherwise the list is held and you pick the payday. Lock reminders, "missing
notes" emails, quoted replies and lists already imported are skipped.

**Matching.** Each line is matched to a session on the same date by billing
name or a learned alias, time (incl. "group time"), and activity words.
Confident matches link automatically and set the session's `paid` flag; the
rest wait on the payday's review screen, and a pick you make there is saved as
an alias for next time.

**Statuses** (derived, never stored): *Paid* · *Owed* (locked, unpaid, 7+ days
old) · *Needs lock* (posted to Zoho, not locked) · *Probably didn't run* (no
note, not locked, 7+ days — one click marks it cancelled) · *Duplicate* (the
same session entered under two groups — counted once). Owed and Needs lock
only count sessions from 2026-04-01; earlier ones show in the ledger as
history. Test groups are excluded.

**eCW check** (tab). Upload the eCW encounter export (one row per patient per
group session; CSV or Excel) to see every locked session and whether it was
paid — eCW, not Ritzoini's Zoho-synced flag, is the source of truth here.
Setup: run `backend/db/migrations/2026-11-26_ecw_encounters.sql` once (adds
`ecw_imports`, `ecw_encounters`, `ecw_changes`; nothing existing changes, and
nothing here writes to `sessions`). Rows are keyed on eCW's encounter id, so
uploading overlapping exports never counts anything twice; a row that comes
back different is updated and each differing field is listed under *Changed
in eCW* until marked seen (blanks filled in and no→yes on locked/billed are
listed separately as normal updates; rows missing from a later export that
covers their date are flagged; a blank never erases a stored value).
Encounters roll up to one session per eCW group id. A session that's locked
and billed in eCW is either on a pay report (paid) or not (*Not paid yet*) —
the stubs and session lists alone decide which payday a session was paid on;
nothing is predicted. *Missing pay reports* lists each biweekly pay period
since the first eCW session that has no stub and/or no list on file, with a
copyable request for the office. The eCW extension can post straight to
`POST /api/payments2/ecw/ingest` with the `ECW_INGEST_KEY` (header
`x-ecw-key`); it pulls one month at a time. Each eCW session is paired with the Ritzoini session on the same date within
45 minutes to read whether it was paid. Flags for the office: a patient billed
twice in one session, a session entered twice, AM start times that should be PM.

Code: `backend/routes/payments2.js`, `backend/utils/pay2/` (eCW: `ecw.js`),
`frontend/src/pages/Payments2Page.js`.

## Need Help?

This codebase is well-structured and developer-friendly. Any React or Node.js developer can pick it up quickly. Key things to share with a developer:
- This README
- Your Supabase project URL (not the secret key!)
- What environment you want to deploy to
