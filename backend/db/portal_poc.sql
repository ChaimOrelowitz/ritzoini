-- Portal POC — peer note transcription (portal.linksnetwork.com → InSync EHR)
--
-- Backs the /portalPOC screen. The pipeline is: upload the portal's notes.json →
-- Phase A resolution against InSync with the ADMIN login (peer→provider id,
-- client→patient id, portal label→VisitTypeID) → human review → Phase B
-- execution under EACH PEER's own InSync login (appointment → encounter → note →
-- close → sign).
--
-- RLS: every table below has RLS enabled and NO policies, so the anon/authed
-- Supabase keys the browser holds can read nothing here. The only reader is the
-- backend's service-role key, which is fenced by middleware/auth.js — admins
-- plus accounts flagged `profiles.portal_only`. That is deliberately tighter
-- than a two-user policy: the browser never touches these rows at all.

-- ---------------------------------------------------------------------------
-- Access flag
-- ---------------------------------------------------------------------------

-- Restricts a profile to ONLY /portalPOC and its API. Same shape as
-- ps_payroll_only: the fence lives in middleware/auth.js requireAuth, and the
-- frontend hides every other nav/section.
alter table profiles
  add column if not exists portal_only boolean not null default false;


-- ---------------------------------------------------------------------------
-- Peers — the peer-management table, and the credential store
-- ---------------------------------------------------------------------------

create table if not exists portal_peers (
  id                     uuid primary key default gen_random_uuid(),
  portal_peer_name       text not null,
  insync_provider_id     text,               -- resolved live from InSync, then stored
  insync_provider_name   text,               -- "Last, First, Cred" as InSync spells it
  insync_username        text,
  -- AES-256-GCM ciphertext from utils/portalCrypto.js. NEVER a plaintext column,
  -- never selected into an API response, never logged.
  insync_password_enc    text,
  signing_pin_enc        text,
  is_active              boolean not null default true,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists portal_peers_name_uniq
  on portal_peers (lower(portal_peer_name));

-- Which InSync scheduler shows this peer's calendar. LoadCalendarView filters on
-- ScheduleSetupID, not on provider id, so without this the appointment-exists
-- check reads the wrong calendar -- and a wrong "nothing here" books a duplicate.
-- Resolved from the scheduler directory (LoadCalendarView's Item6) and cached;
-- re-resolved automatically if it stops working.
alter table portal_peers
  add column if not exists insync_schedule_setup_id text;


-- ---------------------------------------------------------------------------
-- Client map — resolve once, confirm once, reuse forever
-- ---------------------------------------------------------------------------
--
-- A portal client is bound to an InSync patient id exactly once, by a human.
-- Every later run reuses the binding instead of re-running (and re-risking) a
-- name+DOB search. Ambiguity BLOCKS -- a note in the wrong chart is real harm.

create table if not exists portal_client_map (
  id                     uuid primary key default gen_random_uuid(),
  portal_client_name     text not null,
  portal_client_dob      date not null,
  insync_patient_id      text not null,
  insync_patient_name    text,
  insync_mrn             text,
  confirmed_by           uuid references profiles(id),
  confirmed_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Name+DOB is the portal's identity for a client, so it is the map key. NOTE:
-- this is a FUNCTIONAL index, which ON CONFLICT cannot target by column name --
-- an upsert keyed on (portal_client_name, portal_client_dob) fails with "no
-- unique or exclusion constraint matching". routes/portalPoc.js matches the
-- index's own semantics instead: find case-insensitively, then update or insert.
create unique index if not exists portal_client_map_uniq
  on portal_client_map (lower(portal_client_name), portal_client_dob);


-- ---------------------------------------------------------------------------
-- Job runs — one row per notes.json upload
-- ---------------------------------------------------------------------------

create table if not exists portal_job_runs (
  id                     uuid primary key default gen_random_uuid(),
  uploaded_at            timestamptz not null default now(),
  uploaded_by            uuid references profiles(id),
  source_filename        text,
  exported_at            timestamptz,        -- the portal export's own timestamp
  note_count             int not null default 0,
  duplicate_count        int not null default 0,
  status                 text not null default 'staged'
                           check (status in ('staged', 'dry_run', 'executing', 'done', 'failed')),
  last_executed_at       timestamptz,
  last_execution_mode    text check (last_execution_mode in ('dry_run', 'live')),
  created_at             timestamptz not null default now()
);

create index if not exists portal_job_runs_uploaded_idx
  on portal_job_runs (uploaded_at desc);


-- ---------------------------------------------------------------------------
-- Staged notes — what the review screen renders and what execution consumes
-- ---------------------------------------------------------------------------
--
-- `note` is the portal note verbatim (the app never rewrites clinical text).
-- `resolution` holds Phase A's output plus any override Bella made on the
-- review screen; `flags` is the array of reasons a row is not Ready.

create table if not exists portal_staged_notes (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references portal_job_runs(id) on delete cascade,
  portal_note_uuid       text not null,
  note                   jsonb not null,
  resolution             jsonb not null default '{}'::jsonb,
  flags                  jsonb not null default '[]'::jsonb,
  status                 text not null default 'needs_attention'
                           check (status in ('ready', 'needs_attention', 'duplicate', 'done', 'failed', 'skipped')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists portal_staged_notes_run_uuid_uniq
  on portal_staged_notes (run_id, portal_note_uuid);

create index if not exists portal_staged_notes_run_idx
  on portal_staged_notes (run_id);


-- ---------------------------------------------------------------------------
-- Processed notes — the dedupe ledger and the audit trail
-- ---------------------------------------------------------------------------

create table if not exists portal_processed_notes (
  portal_note_uuid       text primary key,
  run_id                 uuid references portal_job_runs(id) on delete set null,
  peer_name              text,
  client_name            text,
  session_date           date,
  insync_visit_type_id   text,
  insync_visit_id        text,               -- appointment used or created
  insync_encounter_id    text,               -- encounter created
  appointment_reused     boolean,
  signed                 boolean not null default false,
  status                 text not null
                           check (status in ('done', 'failed', 'skipped')),
  error_detail           text,
  processed_at           timestamptz not null default now()
);

create index if not exists portal_processed_notes_run_idx
  on portal_processed_notes (run_id);


-- ---------------------------------------------------------------------------
-- Execution log — per-step activity, for the on-screen log and for audit
-- ---------------------------------------------------------------------------

create table if not exists portal_run_events (
  id                     bigserial primary key,
  run_id                 uuid not null references portal_job_runs(id) on delete cascade,
  staged_note_id         uuid references portal_staged_notes(id) on delete cascade,
  at                     timestamptz not null default now(),
  level                  text not null default 'info'
                           check (level in ('info', 'warn', 'error')),
  step                   text,
  message                text not null,
  detail                 jsonb
);

create index if not exists portal_run_events_run_idx
  on portal_run_events (run_id, id);


-- ---------------------------------------------------------------------------
-- Capture templates — the HAR-derived request shapes the write chain replays
-- ---------------------------------------------------------------------------
--
-- app.py reads these out of local .har files at runtime. Those HARs carry live
-- session cookies and a real patient's chart, so they are not committed and not
-- shipped to Render. scripts/extract-insync-captures.js pulls just the POST
-- parameter shapes, scrubs the captured patient's identity and every
-- answer-bearing ControlId, and upserts them here.

create table if not exists portal_capture_templates (
  step                   text primary key,
  url                    text not null,
  params                 jsonb not null,
  captured_from          text,
  field_count            int,
  updated_at             timestamptz not null default now()
);

-- An earlier version of this file pinned `step` with a CHECK that predates the
-- note/note_offsite split, so drop it before the extractor tries to store one.
-- Safe to re-run: this whole file is idempotent.
alter table portal_capture_templates
  drop constraint if exists portal_capture_templates_step_check;

-- Steps: appointment, start, encounter, note, note_offsite, generate, close,
-- calendar. The peer note form exists in TWO shapes with different InSync
-- TemplateIds -- the base form, and the Offsite form that adds ControlId_27 --
-- so both are stored and the selected encounter type picks which is replayed.

-- Which encounter type the capture was taken against. The write templates carry
-- that type's CPT / modifier / POS / copay scaffolding, so replaying them for a
-- DIFFERENT type is exactly what the payload-diff gate below exists to catch.
alter table portal_capture_templates
  add column if not exists captured_visit_type_id text;


-- ---------------------------------------------------------------------------
-- Historical: the payload-diff gate (no longer enforced)
-- ---------------------------------------------------------------------------
--
-- Live runs once refused any encounter type other than the captured one until a
-- human had diffed its payloads and recorded the type here. That existed only
-- because the write templates carried ONE type's billing mapping hardcoded.
--
-- They no longer do: utils/insyncPortal.js resolveBilling asks InSync for the
-- selected type's CPT code, modifiers, units and place of service on every run
-- (GetSchedulerCalendar's CPT map + GetPosCodeByEncSpaceFacilityId), so the
-- mapping is right by construction rather than by manual attestation.
--
-- Nothing reads this table to decide anything now. It is kept because deleting
-- the record of what somebody verified, and when, buys nothing.

create table if not exists portal_verified_types (
  insync_visit_type_id   text primary key,
  insync_visit_type_name text,
  verified_by            uuid references profiles(id),
  verified_at            timestamptz not null default now(),
  note                   text
);


-- ---------------------------------------------------------------------------
-- Lock everything to the service role
-- ---------------------------------------------------------------------------

alter table portal_peers             enable row level security;
alter table portal_client_map        enable row level security;
alter table portal_job_runs          enable row level security;
alter table portal_staged_notes      enable row level security;
alter table portal_processed_notes   enable row level security;
alter table portal_run_events        enable row level security;
alter table portal_capture_templates enable row level security;
alter table portal_verified_types    enable row level security;

revoke all on portal_peers,
              portal_client_map,
              portal_job_runs,
              portal_staged_notes,
              portal_processed_notes,
              portal_run_events,
              portal_capture_templates,
              portal_verified_types
  from anon, authenticated;
