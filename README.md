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

## Need Help?

This codebase is well-structured and developer-friendly. Any React or Node.js developer can pick it up quickly. Key things to share with a developer:
- This README
- Your Supabase project URL (not the secret key!)
- What environment you want to deploy to
