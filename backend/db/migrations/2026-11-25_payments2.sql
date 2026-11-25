-- Payments 2.0 — additive only. Run once in the Supabase SQL editor.
-- Creates four new tables and one private storage bucket. Touches no existing
-- table, column or row. Safe to re-run (everything is IF NOT EXISTS / ON
-- CONFLICT DO NOTHING).

create extension if not exists pgcrypto;

-- ── Pay rates ──────────────────────────────────────────────────────────────
-- The rate for a session is the row with the latest effective_date on or
-- before the session date.
create table if not exists pay_rates (
  id             uuid primary key default gen_random_uuid(),
  effective_date date not null unique,
  amount_cents   integer not null check (amount_cents > 0),
  created_at     timestamptz not null default now()
);

insert into pay_rates (effective_date, amount_cents) values
  ('2000-01-01', 5000),   -- $50 / session before 2026-06-09
  ('2026-06-09', 5500)    -- $55 / session on or after
on conflict (effective_date) do nothing;

-- ── Paydays ────────────────────────────────────────────────────────────────
-- One row per actual payday (Thursday). The stub and the session list arrive
-- separately and fill in their own columns.
create table if not exists paydays (
  id             uuid primary key default gen_random_uuid(),
  pay_date       date not null unique,
  period_start   date,                -- as printed on the stub (informational only)
  period_end     date,
  gross_cents    integer,             -- from the stub
  stub_hours     numeric,             -- older stubs: hours = session count
  stub_file      text,                -- storage path in the `payments` bucket
  stub_filename  text,
  list_raw       text,                -- the session list as text
  list_file      text,                -- storage path in the `payments` bucket
  list_filename  text,
  status         text not null default 'stub_only'
                 check (status in ('stub_only', 'list_only', 'complete', 'mismatch')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── Payday items ───────────────────────────────────────────────────────────
-- One row per line on a payday's session list.
create table if not exists payday_items (
  id               uuid primary key default gen_random_uuid(),
  payday_id        uuid not null references paydays(id) on delete cascade,
  line_no          integer,
  raw_line         text not null,
  billing_name_raw text,
  session_date     date not null,
  session_id       uuid references sessions(id) on delete set null,
  match_confidence numeric,           -- 0..1 score of the chosen session
  match_status     text not null default 'unmatched'
                   check (match_status in ('auto', 'confirmed', 'unmatched')),
  amount_cents     integer,           -- rate for session_date
  created_at       timestamptz not null default now()
);
create index if not exists payday_items_payday_idx  on payday_items (payday_id);
create index if not exists payday_items_date_idx    on payday_items (session_date);
-- A session can be paid on at most one payday line.
create unique index if not exists payday_items_session_uniq
  on payday_items (session_id) where session_id is not null;

-- ── Group aliases ──────────────────────────────────────────────────────────
-- Names the billing office has used for a group. Learned when a match is
-- confirmed by hand. One group can have many aliases; the same alias text can
-- belong to several groups over time (activity names recur cycle to cycle).
create table if not exists group_aliases (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references groups(id) on delete cascade,
  alias       text not null,
  alias_norm  text not null,
  created_at  timestamptz not null default now(),
  unique (group_id, alias_norm)
);
create index if not exists group_aliases_norm_idx on group_aliases (alias_norm);

-- Only the backend (service-role key, which bypasses RLS) touches these
-- tables. RLS on with no policies keeps the browser's anon key out.
alter table pay_rates     enable row level security;
alter table paydays       enable row level security;
alter table payday_items  enable row level security;
alter table group_aliases enable row level security;

-- ── Storage ────────────────────────────────────────────────────────────────
-- Private bucket for uploaded stubs and lists. Files are served to the page
-- through short-lived signed URLs from the backend.
insert into storage.buckets (id, name, public)
values ('payments', 'payments', false)
on conflict (id) do nothing;
