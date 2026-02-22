# 🚀 Ritzoini Platform — Setup Guide

This guide walks you (or a developer) through getting the platform running from scratch.
Estimated time: **30–45 minutes** for someone technical, longer if brand new.

---

## What You're Setting Up

| Part | Technology | Where It Lives |
|------|-----------|----------------|
| Frontend (the website) | React | Vercel (free) |
| Backend (the API) | Node.js + Express | Vercel or Railway (free) |
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

### Option B: Deploy to Railway (free hosting)

1. Go to **https://railway.app** and sign up
2. Click **New Project → Deploy from GitHub** (push your code to GitHub first)
3. Add these environment variables in Railway's dashboard:
   ```
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_SERVICE_KEY=your-service-role-key
   FRONTEND_URL=https://your-vercel-app.vercel.app
   PORT=4000
   NOTIFICATION_EMAIL=notes@yourcompany.com
   ```
4. Railway gives you a public URL like `https://ritzoini-api.up.railway.app`

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

### Option B: Deploy to Vercel (free hosting)

1. Push your code to GitHub
2. Go to **https://vercel.com** and sign up
3. Click **Add New Project → Import from GitHub**
4. Set the root directory to `frontend`
5. Add environment variables:
   ```
   REACT_APP_SUPABASE_URL=https://xxxxx.supabase.co
   REACT_APP_SUPABASE_ANON_KEY=your-anon-key
   REACT_APP_API_URL=https://your-railway-api.up.railway.app
   ```
6. Click **Deploy** — you'll get a live URL!

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
│   │   ├── schema.sql          ← Run this in Supabase
│   │   └── supabase.js         ← DB client
│   ├── middleware/
│   │   └── auth.js             ← JWT verification
│   ├── routes/
│   │   ├── groups.js           ← Group endpoints
│   │   ├── sessions.js         ← Session endpoints
│   │   └── users.js            ← User/invite endpoints
│   ├── services/
│   │   └── email.js            ← Email sender (simulated for now)
│   ├── .env.example            ← Copy to .env and fill in
│   ├── package.json
│   └── server.js               ← Entry point
│
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── admin/          ← CreateGroupModal, EditGroupModal
    │   │   ├── supervisor/     ← SubmitNotesModal
    │   │   └── shared/         ← Layout, EditSessionModal
    │   ├── context/
    │   │   └── AuthContext.js  ← Login state
    │   ├── pages/
    │   │   ├── LoginPage.js
    │   │   ├── DashboardPage.js
    │   │   ├── GroupDetailPage.js
    │   │   └── AdminUsersPage.js
    │   ├── utils/
    │   │   └── api.js          ← All API calls
    │   ├── App.js
    │   └── index.css           ← All styles
    ├── .env.example
    └── package.json
```

---

## Enabling Real Email

Currently email is **simulated** (it logs to the terminal). To send real emails:

1. Sign up for **SendGrid** or **Mailgun** (both have free tiers)
2. Get your SMTP credentials
3. Update `backend/services/email.js` — uncomment the nodemailer block and fill in your SMTP details
4. Add SMTP env vars to your `.env` / Railway dashboard

---

## Need Help?

This codebase is well-structured and developer-friendly. Any React or Node.js developer can pick it up quickly. Key things to share with a developer:
- This README
- Your Supabase project URL (not the secret key!)
- What environment you want to deploy to
