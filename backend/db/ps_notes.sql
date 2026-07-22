-- Peer Supervision co-sign notes — the durable, versioned note store.
--
-- Replaces the old "scan dumps one JSON blob into ps_scan_runs" model. Notes are
-- ingested ONCE from InSync (incrementally, hourly) and live here as rows. The
-- AI verdict and the reviewer's progress persist, so you can review 10 of 20,
-- leave, and come back to the other 10 still waiting.
--
-- ── Lifecycle of one note (same eid) ──────────────────────────────────────────
--   1. Peer signs it -> lands in the InSync co-sign queue -> we ingest v1,
--      status 'pending', AI gives it a verdict.
--   2. You sign it            -> status 'signed'   (terminal).
--   3. You reopen it          -> status 'reopened' (waiting on the peer).
--   4. Peer revises & resigns -> SAME eid comes back with different content ->
--      we insert v2 (status 'pending', re-judged), and v1 becomes 'superseded'
--      (kept forever for the side-by-side old-vs-new view).
--
-- ── Buckets (verdict and status are orthogonal) ───────────────────────────────
--   Clean stack      = ai_verdict='clean'   AND status='pending'  (bulk-sign anytime)
--   Flagged queue    = ai_verdict='flagged' AND status='pending'  (needs your eyes)
--   Waiting on peer  = status='reopened'
--   Archive          = status='signed'  (+ 'superseded' older versions)

create table if not exists ps_notes (
  id            uuid primary key default gen_random_uuid(),
  eid           text not null,               -- InSync encounter id
  version       int  not null default 1,     -- 1,2,3… for revisions of the same eid
  pid           text,                         -- InSync patient id

  peer_name     text,
  patient_name  text,
  mrn           text,
  visit_date    text,                         -- 'MM/DD/YYYY' (as InSync gives it)
  visit_datetime text,
  start_time    text,
  end_time      text,
  total_time    text,

  content_hash  text not null,                -- dedup / revision detection

  ai_verdict    text check (ai_verdict in ('clean','flagged')),
  ai_flags      jsonb,                         -- { machine:[…], clone:{partnerEid,pct,reason}, coherence:"…" }

  status        text not null default 'pending'
                  check (status in ('pending','reopened','signed','superseded')),
  reopen_reason text,

  note_data     jsonb,                         -- full parsed note: content for re-judge,
                                               -- side-by-side, and cosign/reopen ids for actions

  ingested_at   timestamptz not null default now(),
  judged_at     timestamptz,
  actioned_at   timestamptz,                   -- when it was signed / reopened
  created_at    timestamptz not null default now()
);

-- One row per (eid, version).
create unique index if not exists ps_notes_eid_version_uniq
  on ps_notes (eid, version);

-- At most one live version of an eid at a time. A revision supersedes the prior
-- row before the new one is inserted, so this never trips in normal flow — it's
-- a guard against a double-ingest racing two active rows for the same encounter.
create unique index if not exists ps_notes_active_uniq
  on ps_notes (eid)
  where status in ('pending','reopened');

-- The queue reads: the two pending buckets, filtered/sorted.
create index if not exists ps_notes_queue_idx
  on ps_notes (status, ai_verdict, visit_date desc);

-- Search/filter by peer, client, date across the whole (growing) archive.
create index if not exists ps_notes_peer_idx    on ps_notes (peer_name);
create index if not exists ps_notes_patient_idx on ps_notes (patient_name);
create index if not exists ps_notes_eid_idx     on ps_notes (eid);
