-- Payments 2.0 — eCW encounter import. Additive only. Run once in the
-- Supabase SQL editor. Creates three new tables; touches no existing table,
-- column or row. Safe to re-run.
--
-- One row per eCW encounter (one patient in one group session), keyed on
-- eCW's own encounter id, so uploading the same export twice never creates a
-- second copy. Stores the eCW patient id (needed to spot a patient entered
-- twice in one session) but no patient names or dates of birth.

create extension if not exists pgcrypto;

-- Each upload of an eCW export.
create table if not exists ecw_imports (
  id              uuid primary key default gen_random_uuid(),
  filename        text,
  uploaded_at     timestamptz not null default now(),
  row_count       integer not null default 0,
  new_count       integer not null default 0,
  unchanged_count integer not null default 0,
  changed_count   integer not null default 0,
  missing_count   integer not null default 0,
  date_from       date,
  date_to         date
);

create table if not exists ecw_encounters (
  encounter_id     text primary key,
  ecw_group_id     text not null,          -- one eCW group session (changes every week)
  visit_date       date not null,
  start_time       text,                   -- HH:MM as exported
  end_time         text,
  group_name       text,
  locked           boolean not null default false,
  locked_at        text,                   -- 'YYYY-MM-DD HH:MM' as exported
  signed           boolean not null default false,
  signed_at        text,
  billed           boolean not null default false,
  billed_at        text,
  patient_id       text,
  provider         text,
  visit_type       text,
  cpt              text,
  visit_status     text,
  claim_number     text,
  claim_voided     boolean not null default false,
  first_import_id  uuid references ecw_imports(id) on delete set null,
  last_import_id   uuid references ecw_imports(id) on delete set null,
  absent_import_id uuid references ecw_imports(id) on delete set null,  -- set when a later export covering this date no longer has it
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists ecw_encounters_group_idx on ecw_encounters (ecw_group_id);
create index if not exists ecw_encounters_date_idx  on ecw_encounters (visit_date);

-- Every difference between an upload and what was already stored.
--   kind 'filled'  — normal progress: a blank filled in, no→yes on locked /
--                    signed / billed, a pending visit checked in
--   kind 'changed' — a value replaced by a different one (re-lock time,
--                    billed yes→no, claim voided, time changed…)
--   kind 'missing' — the encounter is no longer in an export that covers its date
create table if not exists ecw_changes (
  id              uuid primary key default gen_random_uuid(),
  encounter_id    text not null references ecw_encounters(encounter_id) on delete cascade,
  import_id       uuid references ecw_imports(id) on delete set null,
  field           text not null,
  old_value       text,
  new_value       text,
  kind            text not null check (kind in ('filled', 'changed', 'missing')),
  detected_at     timestamptz not null default now(),
  acknowledged_at timestamptz
);
create index if not exists ecw_changes_open_idx on ecw_changes (acknowledged_at) where acknowledged_at is null;
create index if not exists ecw_changes_enc_idx  on ecw_changes (encounter_id);

alter table ecw_imports    enable row level security;
alter table ecw_encounters enable row level security;
alter table ecw_changes    enable row level security;
