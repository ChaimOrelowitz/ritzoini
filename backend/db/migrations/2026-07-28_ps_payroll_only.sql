-- Grants a profile access to ONLY the Peer Management → Payroll Report screen.
-- When true, the app fences the user in (see middleware/auth.js requireAuth):
-- they may GET /api/ps/payroll/* and GET /api/users/me and nothing else, and
-- the frontend hides every other nav/section/tab. Read-only — no finalize/edit.
alter table profiles
  add column if not exists ps_payroll_only boolean not null default false;
