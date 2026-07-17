-- Peer Supervision caseload tracking (Airtable → Supabase, read-only mirror)
--
-- ps_caseload_periods is the SYSTEM OF RECORD for payroll: Airtable keeps no
-- history of the Peers.Supervisor link changing, so entry/exit dates exist
-- nowhere else. One row per stint. A peer who leaves and later returns gets a
-- SECOND row -- never reopen a closed one.

create table if not exists ps_caseload_periods (
  id                     uuid primary key default gen_random_uuid(),
  peer_airtable_id       text not null,
  peer_name              text,
  supervisor_airtable_id text not null,
  entered_on             date not null,
  left_on                date,          -- null = currently on the caseload
  source                 text not null default 'sync'
                           check (source in ('backfill', 'sync', 'manual')),
  note                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint ps_caseload_dates_ck check (left_on is null or left_on >= entered_on)
);

-- A peer can hold at most one OPEN stint with a given supervisor. Closed rows
-- are exempt, which is what allows re-entry to insert a new row.
create unique index if not exists ps_caseload_open_uniq
  on ps_caseload_periods (peer_airtable_id, supervisor_airtable_id)
  where left_on is null;

create index if not exists ps_caseload_peer_idx
  on ps_caseload_periods (peer_airtable_id);

create index if not exists ps_caseload_payroll_idx
  on ps_caseload_periods (supervisor_airtable_id, entered_on, left_on);


-- Last-seen attributes for each peer, so the Caseload page renders without
-- calling Airtable. Refreshed by the daily poll; never written back.
create table if not exists ps_peers (
  airtable_id            text primary key,
  peer_name              text,
  status                 text,
  cohort                 text,
  email                  text,
  phone                  text,
  last_supervision       date,
  supervisor_airtable_id text,
  last_seen_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);


-- One row per poll, for observability and to prove to payroll that the job ran.
create table if not exists ps_sync_runs (
  id                     uuid primary key default gen_random_uuid(),
  ran_at                 timestamptz not null default now(),
  supervisor_airtable_id text,
  peers_seen             int,
  entered                int,
  departed               int,
  ok                     boolean not null default true,
  error                  text,
  detail                 jsonb
);

create index if not exists ps_sync_runs_ran_at_idx on ps_sync_runs (ran_at desc);
